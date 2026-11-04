import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BindingStore } from "./store.ts";
import { Rex } from "./rex.ts";
import { LEASE_MS, RENEW_MS, isLive, parseOrientation, restoreOrientation, rootOrientation, sameIdentity,
  type Binding, type Bootstrap, type Identity, type Orientation, type Server, type Target } from "./state.ts";

export interface Snapshot {
  state: Orientation;
  server: Server;
  blockId: string;
  token: string;
  generation: number;
  signal: AbortSignal;
}
/** Fail closed unless this Pi conversation is still the verified one backing `feature`.
    Identity metadata is not execution permission. */
export function requireFeature<T>(runtime: Runtime | undefined, feature: T | undefined, sessionId?: string): T {
  if (!runtime || feature === undefined) throw new Error("No verified pi-rex conversation");
  if (sessionId !== undefined && runtime.snapshot().state.piSessionId !== sessionId)
    throw new Error("Pi source conversation changed");
  return feature;
}
export interface Child {
  identity: Identity;
  blockId?: string;
  placement: "session" | "right" | "down" | "tab";
  creation: "confirmed" | "unknown";
}
/** Conversation state, not a scheduler. Identity and parent links confer no execution authority. */
export class Runtime {
  readonly rex: Rex;
  readonly store: BindingStore;
  private readonly blockId: string;
  private readonly pid: number;
  private state?: Orientation;
  private server?: Server;
  private token = randomUUID();
  private generation = 0;
  private lifecycle = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private context?: ExtensionContext;
  private children: Child[] = [];
  constructor(rex: Rex, store: BindingStore, blockId: string, pid = process.pid) {
    this.rex = rex; this.store = store; this.blockId = blockId; this.pid = pid;
  }
  stop(): void {
    this.generation++;
    this.lifecycle.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.state) {
      try { this.store.remove(this.state.conversationId, this.token); } catch { /* lease expires if cleanup is unavailable */ }
    }
    try { this.context?.ui.setStatus("pi-rex", undefined); } catch { /* context may be shutting down */ }
    this.state = undefined; this.server = undefined; this.context = undefined; this.children = [];
  }
  async start(ctx: ExtensionContext, persist: (state: Orientation) => void, seed?: Bootstrap): Promise<void> {
    this.stop();
    if (ctx.mode !== "tui") return;
    this.lifecycle = new AbortController(); this.token = randomUUID();
    const generation = this.generation;
    const signal = this.lifecycle.signal;
    const check = () => {
      signal.throwIfAborted();
      if (generation !== this.generation) throw new Error("Pi conversation changed during initialization");
    };
    const server = await this.rex.initialize(this.blockId, signal);
    check();
    const target = await this.rex.locate(this.blockId, signal);
    await this.rex.verifyProcess(target, this.pid, signal);
    check();
    const owner = ctx.sessionManager.getSessionId();
    const restored = restoreOrientation(ctx.sessionManager.getBranch(), owner);
    if (seed && (seed.piSessionId !== owner || seed.serverInstance !== server.instanceId))
      throw new Error("Launch bootstrap does not match this Pi session and Rex server");
    if (seed && restored && !sameIdentity(seed, restored)) throw new Error("Launch bootstrap conflicts with saved Pi identity");
    const state = seed ? parseOrientation(seed) : restored ?? rootOrientation(owner);
    const occupied = this.store.all().some(b => b.blockId === this.blockId && isLive(b, server));
    if (occupied) throw new Error("Another live pi-rex runtime already claims this pane");
    check();
    const binding = this.binding(state, server);
    this.store.write(binding);
    try {
      if (!restored) persist(state);
      check();
      this.state = state; this.server = server; this.context = ctx;
      this.timer = setInterval(() => {
        try { this.renew(); } catch {
          this.stop();
          ctx.ui.notify("pi-rex lost its conversation binding; reload before launching or navigating", "warning");
        }
      }, RENEW_MS);
      this.timer.unref();
      this.updateStatus();
    } catch (error) {
      this.store.remove(state.conversationId, this.token);
      throw error;
    }
  }
  private binding(state: Orientation, server: Server): Binding {
    return { version: 1, taskId: state.taskId, conversationId: state.conversationId, piSessionId: state.piSessionId,
      role: state.role, serverInstance: server.instanceId, hostId: server.hostId, blockId: this.blockId,
      token: this.token, pid: this.pid, expiresAt: Date.now() + LEASE_MS };
  }
  private renew(): void {
    if (!this.state || !this.server || !this.context) return;
    if (this.context.sessionManager.getSessionId() !== this.state.piSessionId) throw new Error("Pi session changed");
    const existing = this.store.own(this.state.conversationId, this.token);
    if (!existing || !sameIdentity(existing, this.state)) throw new Error("Binding ownership was lost");
    if (this.store.all().some(b => b.blockId === this.blockId && b.token !== this.token && isLive(b, this.server!)))
      throw new Error("Rex pane has a competing conversation binding");
    this.store.write(this.binding(this.state, this.server));
  }
  private updateStatus(): void {
    if (!this.state) return;
    this.context?.ui.setStatus("pi-rex", "rex · " + this.state.role + " [" + this.state.taskId.slice(0, 4) + "]"
      + (this.state.origin ? " · parent linked" : ""));
  }
  snapshot(): Snapshot {
    if (!this.state || !this.server) throw new Error("No verified pi-rex conversation; use interactive Pi inside Rex");
    const snapshot = { state: this.state, server: this.server, blockId: this.blockId, token: this.token,
      generation: this.generation, signal: this.lifecycle.signal };
    this.assert(snapshot);
    return snapshot;
  }
  assert(snapshot: Snapshot): void {
    snapshot.signal.throwIfAborted();
    if (snapshot.generation !== this.generation || snapshot.state !== this.state
        || this.context?.sessionManager.getSessionId() !== snapshot.state.piSessionId)
      throw new Error("Pi conversation changed; the operation was not continued");
    const current = this.store.find(snapshot.state, snapshot.server);
    if (!current || current.token !== snapshot.token || current.pid !== this.pid || current.blockId !== this.blockId)
      throw new Error("The source conversation binding is no longer uniquely live");
  }
  async source(snapshot: Snapshot, signal?: AbortSignal): Promise<Target> {
    const combined = signal ? AbortSignal.any([signal, snapshot.signal]) : snapshot.signal;
    this.assert(snapshot);
    await this.rex.checkServer(combined);
    const target = await this.rex.locate(snapshot.blockId, combined);
    await this.rex.verifyProcess(target, this.pid, combined);
    this.assert(snapshot);
    return target;
  }
  remember(child: Child): void {
    this.children.push(child);
    if (this.children.length > 64) this.children.shift();
  }
  hasRelatedSplit(state: Identity): boolean {
    // Uncertain previous launches still reserve their split preference. Never refill automatically.
    return this.children.some(c => c.identity.taskId === state.taskId && ["right", "down"].includes(c.placement));
  }
  childStatus(): Array<Child & { binding: "bound" | "unknown" }> {
    const own = this.snapshot();
    return this.children.map(child => {
      const binding = this.store.find(child.identity, own.server);
      return { ...child, binding: binding && binding.blockId === child.blockId ? "bound" : "unknown" };
    });
  }
  async returnToOrigin(configuredClient?: string, signal?: AbortSignal): Promise<Target> {
    const own = this.snapshot();
    const origin = own.state.origin;
    if (!origin) throw new Error("This Pi conversation has no recorded parent");
    const combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
    const source = await this.source(own, combined);
    const parent = this.store.find(origin, own.server);
    if (!parent) throw new Error("Origin Pi conversation is closed, stale, or unavailable");
    const target = await this.rex.locate(parent.blockId, combined);
    await this.rex.verifyProcess(target, parent.pid, combined);
    // Same-session pane/tab focus is server state and does not require app Remote Control.
    const client = source.sessionId === target.sessionId ? undefined
      : await this.rex.app(source, configuredClient, combined);
    const check = () => {
      this.assert(own);
      const current = this.store.find(origin, own.server);
      if (!current || current.token !== parent.token || current.blockId !== parent.blockId)
        throw new Error("Origin Pi conversation changed during return");
    };
    check();
    await this.rex.focus(target, client, check, combined);
    return target;
  }
}
