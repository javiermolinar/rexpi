import { createHash } from "node:crypto";
import type { AgentHandle } from "./agent.ts";
import type { AgentResult } from "./agent-runtime.ts";
import type { DelegationRuntime } from "./delegation.ts";
import type { FanoutChildExecution, FanoutExecution, FanoutSnapshot } from "./fanout.ts";
import type { Identity } from "./state.ts";

export const MAX_JOIN_OUTCOME_BYTES = 2 * 1024 * 1024;
export type JoinChildState = "succeeded" | "failed" | "cancelled" | "unknown" | "not-dispatched";
export interface JoinChildOutcome {
  id: string;
  state: JoinChildState;
  handle?: AgentHandle;
  result?: AgentResult;
  error?: string;
}
export interface JoinOutcome {
  id: string;
  state: "succeeded" | "failed" | "cancelled" | "unknown" | "partial";
  coordinator: "complete" | "interrupted";
  completed: boolean;
  children: readonly JoinChildOutcome[];
  bytes: number;
}
interface JoinEntry { digest: string; pending?: Promise<JoinOutcome>; outcome?: JoinOutcome }
function digest(snapshot: FanoutSnapshot): string {
  return createHash("sha256").update(JSON.stringify({ id: snapshot.id,
    children: snapshot.children.map(child => ({ id: child.id, task: child.task })) })).digest("hex");
}
function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1024); }
function terminal(outcome: JoinOutcome): boolean { return outcome.children.every(child => child.state !== "unknown"); }

/** Concurrent joins share reads. Only an explicit later inspection may refresh a partial outcome. */
export class JoinCache {
  private readonly entries = new Map<string, JoinEntry>();
  run(snapshot: FanoutSnapshot, operation: () => Promise<JoinOutcome>): Promise<JoinOutcome> {
    const key = digest(snapshot), prior = this.entries.get(snapshot.id);
    if (prior) {
      if (prior.digest !== key) return Promise.reject(new Error("Conflicting fan-out join identity"));
      if (prior.pending) return prior.pending;
      if (prior.outcome && terminal(prior.outcome)) return Promise.resolve(prior.outcome);
    } else if (this.entries.size >= 64) return Promise.reject(new Error("Join history bound reached"));
    const entry = prior ?? { digest: key };
    const pending = Promise.resolve().then(operation).then(outcome => {
      entry.pending = undefined; entry.outcome = outcome; return outcome;
    }, error => { entry.pending = undefined; throw error; });
    entry.pending = pending; this.entries.set(snapshot.id, entry); return pending;
  }
}
function outcome(id: string, children: JoinChildOutcome[], interrupted: boolean): JoinOutcome {
  const states = new Set(children.map(child => child.state));
  const state = states.size === 0 ? "succeeded" : states.size > 1 ? "partial"
    : children[0].state === "succeeded" ? "succeeded" : children[0].state === "failed" ? "failed"
      : children[0].state === "cancelled" ? "cancelled" : children[0].state === "unknown" ? "unknown" : "failed";
  const value = { id, state, coordinator: interrupted ? "interrupted" : "complete",
    completed: !interrupted && children.every(child => child.state !== "unknown"), children, bytes: 0 } as const;
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > MAX_JOIN_OUTCOME_BYTES) throw new Error("Join outcome byte bound exceeded");
  return Object.freeze({ ...value, bytes });
}
function withoutResult(child: FanoutChildExecution): JoinChildOutcome {
  const base = { id: child.id, ...(child.handle ? { handle: child.handle } : {}) };
  if (child.state === "failed") return { ...base, state: "failed", ...(child.error ? { error: child.error } : {}) };
  if (child.state === "cancelled") return { ...base, state: "cancelled" };
  if (child.state === "blocked" || child.state === "revoked")
    return { ...base, state: "not-dispatched", ...(child.error ? { error: child.error } : {}) };
  if (child.state !== "delegated") return { ...base, state: "unknown" };
  return { ...base, state: "unknown" };
}
async function interrupted(execution: FanoutExecution, signal?: AbortSignal): Promise<boolean> {
  if (!signal) { await execution.settled; return false; }
  if (signal.aborted) return true;
  let abort: () => void;
  const stopped = new Promise<boolean>(resolve => {
    abort = () => resolve(true);
    signal.addEventListener("abort", abort, { once: true });
  });
  const completed = execution.settled.then(() => false);
  const result = await Promise.race([completed, stopped]);
  signal.removeEventListener("abort", abort!);
  return result;
}

export class JoinRuntime {
  private readonly delegation: Pick<DelegationRuntime, "result">;
  private readonly cache: JoinCache;
  constructor(delegation: Pick<DelegationRuntime, "result">, cache = new JoinCache()) {
    this.delegation = delegation; this.cache = cache;
  }
  join(execution: FanoutExecution, source: Identity, signal?: AbortSignal): Promise<JoinOutcome> {
    const snapshot = execution.snapshot();
    return this.cache.run(snapshot, async () => {
      if (await interrupted(execution, signal))
        return outcome(snapshot.id, snapshot.children.map(withoutResult), true);
      const current = execution.snapshot(), children = current.children.map(withoutResult);
      let index = 0;
      const worker = async () => {
        for (;;) {
          const position = index++, child = current.children[position];
          if (!child) break;
          if (child.state !== "delegated" || !child.handle) continue;
          try {
            const result = await this.delegation.result(child.handle, source, signal);
            if (result.state === "ready") children[position] = { id: child.id, state: "succeeded",
              handle: child.handle, result };
            else if (result.state === "failed") children[position] = { id: child.id, state: "failed",
              handle: child.handle, result };
            else if (result.state === "cancelled") children[position] = { id: child.id, state: "cancelled",
              handle: child.handle, result };
            else children[position] = { id: child.id, state: "unknown", handle: child.handle, result };
          } catch (error) {
            children[position] = { id: child.id, state: "unknown", handle: child.handle, error: errorText(error) };
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, () => worker()));
      return outcome(current.id, children, signal?.aborted === true);
    });
  }
}
