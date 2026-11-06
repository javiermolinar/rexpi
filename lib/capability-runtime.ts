import { resolve } from "node:path";
import { inheritCapabilityDeadline, parseCapabilityGrant, type CapabilityGrant, type LaunchOptions } from "./launch.ts";

export interface CapabilityContext {
  abort(): void;
}

export interface CapabilityTimer {
  unref?(): void;
}

export interface CapabilityClock {
  now(): number;
  setTimeout(callback: () => void, timeoutMs: number): CapabilityTimer;
  clearTimeout(timer: CapabilityTimer): void;
}

const systemClock: CapabilityClock = {
  now: () => Date.now(),
  setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface ToolGateResult {
  block: true;
  reason: string;
}

const blocked = (reason: string): ToolGateResult => ({ block: true, reason });
const subset = (child: readonly string[], parent: readonly string[]): boolean => {
  const allowed = new Set(parent);
  return child.every(value => allowed.has(value));
};

/** Resolve delegated paths against the parent cwd so a child launch directory cannot re-root them. */
export function attenuateCapabilityGrant(parent: CapabilityGrant, value: unknown, remainingTimeoutMs: number,
    cwd = process.cwd()): CapabilityGrant {
  if (value === undefined) throw new Error("Capability delegation denied: an explicit child grant is required");
  const requested = parseCapabilityGrant(value);
  const child = { ...requested, readPaths: requested.readPaths.map(path => resolve(cwd, path)),
    writePaths: requested.writePaths.map(path => resolve(cwd, path)) };
  const parentPaths = { readPaths: parent.readPaths.map(path => resolve(cwd, path)),
    writePaths: parent.writePaths.map(path => resolve(cwd, path)) };
  if (!subset(child.tools, parent.tools) || !subset(child.readPaths, parentPaths.readPaths)
      || !subset(child.writePaths, parentPaths.writePaths))
    throw new Error("Capability delegation denied: child tools/readPaths/writePaths must be parent subsets");
  if (child.delegation.maxDepth > parent.delegation.maxDepth - 1)
    throw new Error("Capability delegation denied: child maxDepth exceeds the attenuated parent depth");
  if (child.returnResults && !parent.returnResults)
    throw new Error("Capability delegation denied: child returnResults exceeds the parent grant");
  if (child.turns > parent.turns)
    throw new Error("Capability delegation denied: child turns exceed the parent grant");
  if (child.timeoutMs > remainingTimeoutMs)
    throw new Error("Capability delegation denied: child timeoutMs exceeds the remaining parent timeout");
  return child;
}

/**
 * Authority for one decoded child incarnation. It is never persisted or restored.
 * The sole timer begins at construction (bootstrap consumption), not at agent_start.
 */
export class CapabilityRuntime {
  private readonly grant: CapabilityGrant;
  private readonly clock: CapabilityClock;
  private readonly cwd: string;
  private readonly deadlineAt: number;
  private readonly controller = new AbortController();
  private readonly onNotice?: (message: string) => void;
  private timer: CapabilityTimer | undefined;
  private state: "active" | "completed" | "expired" | "revoked" = "active";
  private context: CapabilityContext | undefined;
  private turnsStarted = 0;
  private turnLimitDenied = false;
  private turnNotice = false;
  private timeoutNotice = false;
  private retainedNotice: string | undefined;

  constructor(grant: CapabilityGrant, options: { clock?: CapabilityClock; cwd?: string; deadlineAt?: number;
      onNotice?: (message: string) => void } = {}) {
    this.grant = parseCapabilityGrant(grant);
    this.clock = options.clock ?? systemClock;
    this.cwd = options.cwd ?? process.cwd();
    this.onNotice = options.onNotice;
    const startedAt = this.clock.now();
    this.deadlineAt = Math.min(startedAt + this.grant.timeoutMs, options.deadlineAt ?? Number.MAX_SAFE_INTEGER);
    const remaining = this.deadlineAt - startedAt;
    if (remaining <= 0) { this.expire(); return; }
    const timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.expire();
    }, remaining);
    this.timer = timer;
    timer.unref?.();
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get notice(): string | undefined { return this.retainedNotice; }

  allowsTool(name: string): boolean { return this.grant.tools.includes(name); }

  /** Child-cwd-independent roots; launch encoding still preserves the original literal grant. */
  pathGrants(): { readPaths: string[]; writePaths: string[] } {
    return { readPaths: this.grant.readPaths.map(path => resolve(this.cwd, path)),
      writePaths: this.grant.writePaths.map(path => resolve(this.cwd, path)) }; }

  attachContext(context: CapabilityContext): void { this.context = context; }

  private abortCurrent(): void {
    try { this.context?.abort(); } catch { /* denial remains enforced even if the host abort hook fails */ }
  }

  private emitNotice(message: string): void {
    this.retainedNotice = message;
    try { this.onNotice?.(message); } catch { /* a UI failure cannot weaken enforcement */ }
  }

  private inactiveDenial(): ToolGateResult {
    if (this.state === "completed") return blocked("Capability grant already completed; future work is denied");
    return blocked(this.state === "expired"
      ? "Capability grant expired; current and future work is denied"
      : "Capability grant was revoked; this incarnation has no tool authority");
  }

  /** Explicit agent completion disarms the deadline quietly; it is not revocation or an abort. */
  finish(): void {
    if (this.state !== "active") return;
    this.state = "completed";
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private expire(): void {
    if (this.state !== "active") return;
    this.state = "expired";
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.controller.abort();
    this.abortCurrent();
    if (!this.timeoutNotice) {
      this.timeoutNotice = true;
      this.emitNotice("Capability grant expired; aborted current work and denied future turns");
    }
  }

  /** Replacement and shutdown are permanent revocation, never a reset into an ungoverned runtime. */
  revoke(): void {
    if (this.state === "revoked") return;
    this.state = "revoked";
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.controller.abort();
    this.abortCurrent();
  }

  private ensureActive(): boolean {
    if (this.state !== "active") return false;
    if (this.clock.now() < this.deadlineAt) return true;
    this.expire();
    return false;
  }

  private remainingTimeoutMs(): number {
    if (!this.ensureActive()) return 0;
    return this.deadlineAt - this.clock.now();
  }

  deriveChildGrant(value: unknown): CapabilityGrant {
    if (!this.ensureActive()) throw new Error(this.inactiveDenial().reason);
    if (this.grant.delegation.maxDepth <= 0)
      throw new Error("Capability delegation denied: delegation.maxDepth must be greater than zero");
    if (this.turnLimitDenied) throw new Error("Capability grant turn limit exhausted; delegation is denied");
    const child = attenuateCapabilityGrant(this.grant, value, this.remainingTimeoutMs(), this.cwd);
    inheritCapabilityDeadline(child, this.deadlineAt);
    return child;
  }

  deriveChildOptions(options: LaunchOptions): LaunchOptions {
    return { ...options, grant: this.deriveChildGrant(options.grant) };
  }

  /** Also aborts in-flight launcher work when the host has supplied its tool signal. */
  toolSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
  }

  /** Called at Pi's actual turn_start boundary, not at agent_start or message construction. */
  startTurn(context: CapabilityContext): boolean {
    this.attachContext(context);
    if (this.state === "completed") { this.abortCurrent(); return false; }
    const wasActive = this.state === "active";
    if (!this.ensureActive()) {
      // ensureActive aborts a newly expired context; already inactive incarnations need it too.
      if (!wasActive) this.abortCurrent();
      return false;
    }
    if (this.turnsStarted >= this.grant.turns) {
      this.turnLimitDenied = true;
      this.abortCurrent();
      if (!this.turnNotice) {
        this.turnNotice = true;
        this.emitNotice(`Capability grant denied turn ${this.turnsStarted + 1}: at most ${this.grant.turns} model turns are allowed`);
      }
      return false;
    }
    this.turnsStarted++;
    return true;
  }

  /** Global gate: applies to Rex, built-in, custom, and nested tool_call events alike. */
  guardTool(toolName: string, input: unknown, context?: CapabilityContext): ToolGateResult | undefined {
    if (context) this.attachContext(context);
    if (!this.ensureActive()) return this.inactiveDenial();
    if (this.turnLimitDenied) return blocked("Capability grant turn limit exhausted; tool execution is denied");
    if (!this.allowsTool(toolName)) return blocked("Capability grant denied: tool is not whitelisted");
    if (toolName === "rexpi_jump" || toolName === "rexpi_open_session")
      return blocked("Capability grant denied: this Pi-opening route cannot propagate a grant");
    if (toolName === "rexpi_message_send" && !this.grant.returnResults
        && typeof input === "object" && input !== null && (input as { kind?: unknown }).kind === "result")
      return blocked("Capability grant denied: returnResults=false blocks kind=result");
    if (toolName === "rexpi_start_pi" || toolName === "rexpi_delegate") {
      const child = typeof input === "object" && input !== null
        ? (input as { grant?: unknown }).grant : undefined;
      try { this.deriveChildGrant(child); }
      catch (error) { return blocked(error instanceof Error ? error.message : "Capability delegation denied"); }
    }
    if (toolName === "rexpi_fanout") {
      const children = typeof input === "object" && input !== null
        ? (input as { children?: unknown }).children : undefined;
      if (!Array.isArray(children) || !children.length || children.length > 64)
        return blocked("Capability delegation denied: rexpi_fanout requires 1 to 64 explicit children");
      try {
        for (const child of children) this.deriveChildGrant(typeof child === "object" && child !== null
          ? (child as { grant?: unknown }).grant : undefined);
      } catch (error) { return blocked(error instanceof Error ? error.message : "Capability delegation denied"); }
    }
    return undefined;
  }
}
