import { createHash } from "node:crypto";
import type { DelegateOptions, DelegationResult, DelegationRuntime } from "./delegation.ts";
import type { AgentHandle } from "./agent.ts";

export interface FanoutChildInput {
  id: string;
  task: string;
  options: DelegateOptions;
}
export type FanoutChildState = "queued" | "dispatching" | "delegated" | "failed" | "blocked" | "cancelled" | "revoked";
export interface FanoutChildExecution extends FanoutChildInput {
  state: FanoutChildState;
  handle?: AgentHandle;
  delegation?: DelegationResult;
  error?: string;
}
export interface FanoutSnapshot {
  id: string;
  children: readonly FanoutChildExecution[];
  dispatching: number;
  completed: boolean;
  stopReason?: "failure" | "cancelled" | "revoked";
}
export interface FanoutExecution {
  readonly settled: Promise<void>;
  snapshot(): FanoutSnapshot;
  /** Stop new dispatch only. Existing handles and in-flight evidence are never cleaned up. */
  cancel(): void;
}
export interface FanoutOptions {
  concurrency: number;
  cwd: string;
  signal?: AbortSignal;
  /** Rechecked at every dispatch boundary; false/throw revokes only undispatched work. */
  authority?: () => boolean;
}
type Delegate = Pick<DelegationRuntime, "delegate">;
type StopReason = FanoutSnapshot["stopReason"];
function registryDigest(inputs: readonly FanoutChildInput[], options: FanoutOptions): string {
  const body = JSON.stringify({ inputs, concurrency: options.concurrency, cwd: options.cwd }, (_key, item) => {
    if (typeof item === "bigint" || typeof item === "function" || typeof item === "symbol")
      throw new Error("Invalid fan-out input");
    return item;
  });
  if (!body || Buffer.byteLength(body) > 1024 * 1024) throw new Error("Fan-out input byte bound exceeded");
  return createHash("sha256").update(body).digest("hex");
}
export class FanoutRegistry {
  private readonly executions = new Map<string, { digest: string; execution: FanoutExecution }>();
  start(id: string, inputs: readonly FanoutChildInput[], options: FanoutOptions,
      operation: () => FanoutExecution, identityInputs: readonly FanoutChildInput[] = inputs): FanoutExecution {
    const digest = registryDigest(identityInputs, options), prior = this.executions.get(id);
    if (prior) {
      if (prior.digest !== digest) throw new Error("Conflicting fan-out logical ID");
      return prior.execution;
    }
    if (this.executions.size >= 64) throw new Error("Fan-out history bound reached");
    const execution = operation();
    this.executions.set(id, { digest, execution }); return execution;
  }
  /** Match an existing batch without admitting new work; undefined means no prior execution. */
  match(id: string, inputs: readonly FanoutChildInput[], options: FanoutOptions): FanoutExecution | undefined {
    const digest = registryDigest(inputs, options), prior = this.executions.get(id);
    if (!prior) return undefined;
    if (prior.digest !== digest) throw new Error("Conflicting fan-out logical ID");
    return prior.execution;
  }
  get(id: string): FanoutExecution {
    const prior = this.executions.get(id);
    if (!prior) throw new Error("Unknown fan-out logical ID");
    return prior.execution;
  }
}
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1024);
}
function admittedInputs(value: readonly FanoutChildInput[]): FanoutChildInput[] {
  const body = JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint" || typeof item === "function" || typeof item === "symbol")
      throw new Error("Invalid fan-out input");
    return item;
  });
  if (!body || Buffer.byteLength(body) > 1024 * 1024) throw new Error("Fan-out input byte bound exceeded");
  return JSON.parse(body);
}

/** Coordinator-side dispatch only. Result retrieval and aggregation are deliberately separate. */
export class FanoutRuntime {
  private readonly delegation: Delegate;
  private readonly registry: FanoutRegistry;
  constructor(delegation: Delegate, registry = new FanoutRegistry()) {
    this.delegation = delegation; this.registry = registry;
  }

  start(id: string, inputs: readonly FanoutChildInput[], options: FanoutOptions,
      identityInputs: readonly FanoutChildInput[] = inputs): FanoutExecution {
    return this.registry.start(id, inputs, options, () => this.compose(id, inputs, options), identityInputs);
  }
  /** Uncached dispatch composition for an extension-lifetime registry. */
  compose(id: string, inputs: readonly FanoutChildInput[], options: FanoutOptions): FanoutExecution {
    if (typeof id !== "string" || !id.length || id.length > 1024) throw new Error("Invalid fan-out ID");
    if (!Array.isArray(inputs) || inputs.length > 64) throw new Error("Fan-out requires at most 64 children");
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8)
      throw new Error("Fan-out concurrency must be an integer from 1 to 8");
    if (typeof options.cwd !== "string" || !options.cwd) throw new Error("Fan-out cwd is required");
    const admitted = admittedInputs(inputs);
    if (new Set(admitted.map(child => child.id)).size !== admitted.length) throw new Error("Fan-out child IDs must be unique");
    for (const child of admitted) if (typeof child.id !== "string" || !child.id.length || child.id.length > 1024)
      throw new Error("Invalid fan-out child ID");
    const children: FanoutChildExecution[] = admitted.map(child => ({ ...child, state: "queued" }));
    const controller = new AbortController();
    let index = 0, completed = false, stopReason: StopReason;
    const stop = (reason: NonNullable<StopReason>) => {
      if (completed || stopReason) return;
      stopReason = reason;
      for (const child of children) if (child.state === "queued")
        child.state = reason === "failure" ? "blocked" : reason === "cancelled" ? "cancelled" : "revoked";
    };
    const cancelled = () => stop("cancelled");
    if (options.signal) {
      if (options.signal.aborted) cancelled();
      else options.signal.addEventListener("abort", cancelled, { once: true });
    }
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const dispatch = async (child: FanoutChildExecution) => {
      child.state = "dispatching";
      try {
        const delegationId = "fanout:" + createHash("sha256").update(JSON.stringify([id, child.id])).digest("hex");
        const delegation = await this.delegation.delegate(delegationId, child.task, child.options, options.cwd, signal);
        child.delegation = delegation; child.handle = delegation.handle;
        if (delegation.creation !== "confirmed" || delegation.binding !== "bound") {
          child.state = "failed"; child.error = "Delegation creation/binding is not confirmed";
          stop("failure"); return;
        }
        child.state = "delegated";
      } catch (error) {
        child.state = "failed"; child.error = errorText(error); stop("failure");
      }
    };
    const worker = async () => {
      while (!stopReason) {
        if (controller.signal.aborted) { stop("cancelled"); break; }
        try {
          if (options.authority && !options.authority()) { stop("revoked"); break; }
        } catch { stop("revoked"); break; }
        if (stopReason) break;
        const child = children[index++];
        if (!child) break;
        await dispatch(child);
      }
    };
    const settled = Promise.all(Array.from({ length: Math.min(options.concurrency, Math.max(children.length, 1)) },
      () => worker())).then(() => {
      completed = true;
      options.signal?.removeEventListener("abort", cancelled);
    });
    return {
      settled,
      snapshot: () => structuredClone({ id, children, completed,
        dispatching: children.filter(child => child.state === "dispatching").length,
        ...(stopReason ? { stopReason } : {}) }),
      cancel: () => { if (!completed) { controller.abort(); stop("cancelled"); } },
    };
  }
}
