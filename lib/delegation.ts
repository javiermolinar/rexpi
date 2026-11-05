import { createHash } from "node:crypto";
import { parseCapabilityGrant, type CapabilityGrant, type LaunchOptions, type LaunchResult, type Launcher } from "./launch.ts";
import type { AgentHandle } from "./agent.ts";
import type { AgentCancellation, AgentResult, AgentRuntime, AgentStatus, AgentStop } from "./agent-runtime.ts";
import type { Identity } from "./state.ts";

export interface DelegateOptions {
  grant: CapabilityGrant;
  cwd?: string;
  project?: string;
  placement?: LaunchOptions["placement"];
  sessionName?: string;
  title?: string;
  focus?: boolean;
  provider?: string;
  model?: string;
  thinking?: LaunchOptions["thinking"];
  notifyParentOnSettlement?: boolean;
}
export interface DelegationResult {
  handle: AgentHandle;
  creation: LaunchResult["creation"];
  binding: LaunchResult["startup"]["state"];
  activity: "unknown";
  result: "pending";
  subscription: { settlement: boolean };
  returnSetup?: LaunchResult["returnSetup"];
  launch: LaunchResult;
}
export interface DelegationInspection {
  delegation: DelegationResult;
  status?: AgentStatus;
}

function canonical(value: unknown): string {
  const body = JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint" || typeof item === "function" || typeof item === "symbol")
      throw new Error("Invalid delegation input");
    if (Array.isArray(item)) return item;
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
    }
    return item;
  });
  if (!body || Buffer.byteLength(body) > 65_536) throw new Error("Delegation input byte bound exceeded");
  return body;
}

/** Extension-lifetime evidence; a replacement launcher cannot repeat uncertain logical work. */
export class DelegationCache {
  private readonly calls = new Map<string, { digest: string; result: Promise<DelegationResult> }>();
  run(id: string, task: string, options: DelegateOptions,
      operation: (task: string, options: DelegateOptions) => Promise<DelegationResult>): Promise<DelegationResult> {
    if (typeof id !== "string" || !id.length || id.length > 1024) return Promise.reject(new Error("Invalid delegation ID"));
    let digest: string, admitted: { task: string; options: DelegateOptions };
    try {
      const body = canonical({ task, options });
      digest = createHash("sha256").update(body).digest("hex"); admitted = JSON.parse(body);
    } catch (error) { return Promise.reject(error); }
    const prior = this.calls.get(id);
    if (prior) {
      if (prior.digest !== digest) return Promise.reject(new Error("Conflicting delegation logical ID"));
      return prior.result;
    }
    if (this.calls.size >= 256) return Promise.reject(new Error("Delegation logical history bound reached"));
    const result = Promise.resolve().then(() => operation(admitted.task, admitted.options));
    this.calls.set(id, { digest, result }); return result;
  }
  inspect(id: string): Promise<DelegationResult> {
    const prior = this.calls.get(id);
    return prior ? prior.result : Promise.reject(new Error("Unknown delegation logical ID"));
  }
}

type AgentControls = Pick<AgentRuntime, "status" | "result" | "cancel" | "stop">;
export class DelegationRuntime {
  private readonly launcher: Pick<Launcher, "launch">;
  private readonly agents?: AgentControls;
  private readonly cache: DelegationCache;
  constructor(launcher: Pick<Launcher, "launch">, agents?: AgentControls, cache = new DelegationCache()) {
    this.launcher = launcher; this.agents = agents; this.cache = cache;
  }

  delegate(id: string, task: string, options: DelegateOptions, cwd: string, signal?: AbortSignal): Promise<DelegationResult> {
    return this.cache.run(id, task, options, (admittedTask, admittedOptions) =>
      this.compose(id, admittedTask, admittedOptions, cwd, signal));
  }
  /** Uncached composition for an extension-lifetime admission cache. */
  async compose(id: string, task: string, options: DelegateOptions, cwd: string,
      signal?: AbortSignal): Promise<DelegationResult> {
    if (typeof task !== "string" || !task.trim() || task.length > 16_384 || task.includes("\0"))
      throw new Error("Invalid delegated task");
    const grant = parseCapabilityGrant(options.grant);
    const launch = await this.launcher.launch(id, {
      prompt: task, related: true, role: "chat", returnResults: grant.returnResults, grant,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.placement === undefined ? {} : { placement: options.placement }),
      ...(options.sessionName === undefined ? {} : { sessionName: options.sessionName }),
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.focus === undefined ? {} : { focus: options.focus }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
      notifyParentOnSettlement: options.notifyParentOnSettlement === true,
    }, cwd, signal);
    if (!launch.handle) throw new Error("Related delegation did not produce an agent handle");
    return { handle: launch.handle, creation: launch.creation, binding: launch.startup.state,
      activity: "unknown", result: "pending", subscription: { settlement: options.notifyParentOnSettlement === true },
      ...(launch.returnSetup ? { returnSetup: launch.returnSetup } : {}), launch };
  }
  private controls(): AgentControls {
    if (!this.agents) throw new Error("Agent evidence and controls are unavailable");
    return this.agents;
  }
  async inspect(id: string, signal?: AbortSignal): Promise<DelegationInspection> {
    const delegation = await this.cache.inspect(id);
    return { delegation, ...(this.agents ? { status: await this.agents.status(delegation.handle, signal) } : {}) };
  }
  status(handle: AgentHandle, signal?: AbortSignal): Promise<AgentStatus> { return this.controls().status(handle, signal); }
  result(handle: AgentHandle, source: Identity, signal?: AbortSignal): Promise<AgentResult> {
    return this.controls().result(handle, source, signal);
  }
  cancel(handle: AgentHandle, source: Identity, signal?: AbortSignal): Promise<AgentCancellation> {
    return this.controls().cancel(handle, source, signal);
  }
  stop(handle: AgentHandle, source: Identity, authorize: true, signal?: AbortSignal): Promise<AgentStop> {
    return this.controls().stop(handle, source, authorize, signal);
  }
}
