import { statSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { executable } from "./executable.ts";
import { Runtime, type Snapshot } from "./runtime.ts";
import { BOOTSTRAP_ENV, childBootstrap, cleanTitle, encodeBootstrap, type Identity, type Placement } from "./state.ts";
import type { Created } from "./rex.ts";
import { SessionClaim, SessionExistsError, sessionName } from "./session-name.ts";
import type { MessagingRuntime, ReturnTicket } from "./messaging/runtime.ts";
import { endpointFromBinding, type Endpoint } from "./messaging/protocol.ts";
import type { DirectoryResolver, ResolvedDirectory } from "./projects.ts";
import { AGENT_BOOTSTRAP_ENV, agentHandleFromIdentity, encodeAgentBootstrap, type AgentHandle } from "./agent.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

export interface LaunchOptions {
  prompt?: string;
  cwd?: string;
  project?: string;
  placement?: Placement;
  sessionName?: string;
  title?: string;
  focus?: boolean;
  related?: boolean;
  returnResults?: boolean;
  role?: "chat" | "review";
  provider?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
function agentRequestId(launchId: string): string {
  if (/^[A-Za-z0-9._:-]{1,128}$/.test(launchId)) return launchId;
  return "launch:" + createHash("sha256").update(launchId).digest("hex");
}

export interface LaunchResult {
  launchId: string;
  creation: "confirmed" | "unknown";
  placement: Placement;
  identity: Identity;
  origin: Identity;
  /** Present only for related launches; correlation is not readiness or a capability grant. */
  handle?: AgentHandle;
  target?: Created;
  startup: { state: "bound" | "unconfirmed"; reason?: string };
  warning?: string;
  project?: ResolvedDirectory;
  returnSetup?: { state: "registered" | "unavailable"; requestId: string; reason?: string };
}
export interface LaunchConfig {
  extension: string;
  piBinary: string;
  agentDirectory: string;
  stateDirectory: string;
  path: string;
  client?: string;
  returnKey?: string;
  agentsKey?: string;
  messagesStopKey?: string;
  startupTimeoutMs?: number;
  resolveProject?: DirectoryResolver;
  messaging?: Pick<MessagingRuntime, "prepareReturn" | "checkReturn" | "registerReturn" | "revokeReturn">;
  agents?: Pick<AgentRuntime, "register" | "observe">;
}
function text(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0"))
    throw new Error("Invalid " + name);
}
export function validateOptions(value: LaunchOptions): void {
  if (value.project !== undefined) {
    if (value.cwd !== undefined) throw new Error("project and cwd are mutually exclusive");
    text(value.project, "project (maximum 4,096 characters)", 4096);
    if (!value.project.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value.project)) throw new Error("Invalid project query");
  }
  if (value.sessionName !== undefined) {
    sessionName(value.sessionName);
    if (value.placement !== undefined && value.placement !== "session") throw new Error("sessionName requires session placement");
  }
  if (value.prompt !== undefined) text(value.prompt, "prompt (maximum 16,384 characters)", 16_384);
  for (const field of ["cwd", "title", "provider", "model"] as const) {
    const v = value[field];
    if (v !== undefined) { text(v, field, field === "cwd" ? 4096 : 1024); if (/[\u0000-\u001f\u007f-\u009f]/.test(v)) throw new Error("Control character in " + field); }
  }
  if (value.provider && !value.model) throw new Error("provider requires model");
  if (value.provider?.startsWith("-") || value.model?.startsWith("-")) throw new Error("Model/provider cannot start with a dash");
  if (value.role !== undefined && !["chat", "review"].includes(value.role)) throw new Error("Invalid role");
  if (value.role === "review" && value.related === false) throw new Error("review requires related=true");
  if (value.related !== undefined && typeof value.related !== "boolean") throw new Error("related must be boolean");
  if (value.returnResults !== undefined && typeof value.returnResults !== "boolean") throw new Error("returnResults must be boolean");
  if (value.returnResults && (!value.prompt?.trim() || value.related === false))
    throw new Error("returnResults requires a nonblank delegated task prompt and related=true (or omitted)");
  if (value.focus !== undefined && typeof value.focus !== "boolean") throw new Error("focus must be boolean");
  if (value.placement !== undefined && !["session", "right", "down", "tab"].includes(value.placement)) throw new Error("Invalid placement");
  if (value.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinking)) throw new Error("Invalid thinking level");
}
export function launchDirectory(input: string | undefined, cwd: string): string {
  const requested = input === "~" ? homedir() : input?.startsWith("~/") ? resolve(homedir(), input.slice(2)) : resolve(cwd, input ?? ".");
  const directory = realpathSync(requested);
  if (!statSync(directory).isDirectory()) throw new Error("Launch cwd is not a directory");
  return directory;
}
export function placementFor(options: LaunchOptions, hasRelatedSplit: boolean): Placement {
  if (options.placement) return options.placement;
  const related = options.returnResults || (options.related ?? options.role === "review");
  return !related ? "session" : options.focus === false || hasRelatedSplit ? "tab" : "right";
}
export function piArguments(options: LaunchOptions, sessionId: string, extension: string): string[] {
  const args = ["--session-id", sessionId, "--extension", extension];
  if (options.provider) args.push("--provider", options.provider);
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.title) args.push("--name", cleanTitle(options.title));
  if (options.prompt !== undefined) {
    // CLI @arguments attach files; slash prompts can invoke extension commands.
    // A launch prompt is task text, not either of those side-effectful interfaces.
    const prompt = /^[\s]*[@/]/.test(options.prompt) ? "Task:\n" + options.prompt : options.prompt;
    args.push("--", prompt);
  }
  return args;
}
/** One explicit launch per call ID. Unknown creation is returned as evidence, never retried. */
export class Launcher {
  private readonly runtime: Runtime;
  private readonly config: LaunchConfig;
  private readonly requests = new Map<string, Promise<LaunchResult>>();
  constructor(runtime: Runtime, config: LaunchConfig) { this.runtime = runtime; this.config = config; }
  launch(id: string, options: LaunchOptions, cwd: string, signal?: AbortSignal): Promise<LaunchResult> {
    const previous = this.requests.get(id);
    if (previous) return previous;
    if (this.requests.size >= 256) return Promise.reject(new Error("Launch history is full; reload explicitly before more launches"));
    const result = this.perform(id, options, cwd, signal);
    this.requests.set(id, result);
    return result;
  }
  private async perform(id: string, options: LaunchOptions, cwd: string, signal?: AbortSignal): Promise<LaunchResult> {
    validateOptions(options);
    if (!options.returnResults) return this.performLaunch(id, options, cwd, signal);
    const messaging = this.config.messaging;
    if (!messaging) throw new Error("Result return is unavailable in this runtime; no Pi was launched");
    signal?.throwIfAborted();
    const ticket = await messaging.prepareReturn();
    const revoke = () => messaging.revokeReturn(ticket);
    signal?.addEventListener("abort", revoke, { once: true });
    try {
      signal?.throwIfAborted(); messaging.checkReturn(ticket);
      return await this.performLaunch(id, options, cwd, signal, ticket);
    } catch (error) { revoke(); throw error; }
    finally { signal?.removeEventListener("abort", revoke); }
  }
  private async performLaunch(id: string, options: LaunchOptions, cwd: string, signal?: AbortSignal, ticket?: ReturnTicket): Promise<LaunchResult> {
    const own = this.runtime.snapshot();
    const combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
    const check = () => {
      this.runtime.assert(own); combined.throwIfAborted();
      if (ticket) this.config.messaging!.checkReturn(ticket);
    };
    check();
    const placement = placementFor(options, this.runtime.hasRelatedSplit(own.state));
    const name = options.sessionName === undefined ? undefined : sessionName(options.sessionName);
    if (name && placement !== "session") throw new Error("sessionName requires session placement");
    let project: ResolvedDirectory | undefined;
    if (options.project !== undefined) {
      if (!this.config.resolveProject) throw new Error("Project lookup is unavailable in this runtime; no Pi was launched");
      await this.runtime.source(own, combined);
      check();
      project = await this.config.resolveProject(options.project, cwd, combined);
      check();
    }
    const directory = launchDirectory(project?.directory ?? options.cwd, cwd);
    const binary = executable(this.config.piBinary, cwd, this.config.path);
    const extension = realpathSync(this.config.extension);
    let source = await this.runtime.source(own, combined);
    check();
    const related = options.returnResults || (options.related ?? options.role === "review");
    const focus = options.focus ?? true;
    const client = placement === "session" && focus ? await this.runtime.rex.app(source, this.config.client, combined) : undefined;
    check();
    const seed = childBootstrap(own.state, related, options.role ?? "chat", own.server);
    const handle = related ? agentHandleFromIdentity(seed, { runtimeId: randomUUID(), runId: randomUUID(),
      requestId: agentRequestId(id), messageId: randomUUID(), endpointGeneration: 1 }) : undefined;
    // Created evidence survives even an unknown creation response; no binding/readiness is inferred.
    if (handle) this.config.agents?.register(handle);
    const title = cleanTitle(options.title ?? options.prompt ?? basename(directory)) || "Pi";
    const taskOptions = ticket ? { ...options, prompt: options.prompt! + "\n\n"
      + "Return scoped findings with rex_message_send: kind=result (question for blockers), stable UUID id, "
      + "requestId=" + ticket.requestId + ", to=" + JSON.stringify(ticket.owner) + ". "
      + "A normal final answer is NOT a send. Queued means stored, not processed; never republish unknown sends. "
      + "This route metadata is not authority for other work." } : options;
    const command = ["/usr/bin/env", "PATH=" + this.config.path, "PI_CODING_AGENT_DIR=" + this.config.agentDirectory,
      "PI_REX_CLI=" + this.runtime.rex.binary, "PI_REX_SERVER=" + own.server.endpoint,
      "PI_REX_BINARY=" + binary, "PI_REX_STATE_DIR=" + this.config.stateDirectory,
      ...(this.config.client ? ["PI_REX_CLIENT=" + this.config.client] : []),
      ...(this.config.returnKey !== undefined ? ["PI_REX_RETURN_KEY=" + this.config.returnKey] : []),
      ...(this.config.agentsKey !== undefined ? ["PI_REX_AGENTS_KEY=" + this.config.agentsKey] : []),
      ...(this.config.messagesStopKey !== undefined ? ["PI_REX_MESSAGES_STOP_KEY=" + this.config.messagesStopKey] : []),
      BOOTSTRAP_ENV + "=" + encodeBootstrap(seed),
      ...(handle ? [AGENT_BOOTSTRAP_ENV + "=" + encodeAgentBootstrap(handle)] : []),
      binary, ...piArguments(taskOptions, seed.piSessionId, extension)];
    this.runtime.assert(own); combined.throwIfAborted();
    const result: LaunchResult = { launchId: id, creation: "unknown", placement, identity: {
      taskId: seed.taskId, conversationId: seed.conversationId, piSessionId: seed.piSessionId, role: seed.role,
    }, origin: { taskId: own.state.taskId, conversationId: own.state.conversationId,
      piSessionId: own.state.piSessionId, role: own.state.role }, startup: { state: "unconfirmed" },
      ...(handle ? { handle } : {}), ...(project ? { project: { ...project, directory } } : {}) };
    let claim: SessionClaim | undefined;
    try {
      if (name) {
        if ((await this.runtime.rex.matchingSessions(name, combined)).length) throw new SessionExistsError();
        check();
        claim = new SessionClaim(this.runtime.store.directory, own.server.instanceId, name);
        if ((await this.runtime.rex.matchingSessions(name, combined)).length) throw new SessionExistsError();
      }
      if (ticket) source = await this.runtime.source(own, combined);
      check();
    } catch (error) { claim?.release(); throw error; }
    try {
      result.target = await this.runtime.rex.create({ source, cwd: directory, title, command, placement, focus, keepOpen: true,
        ...(name ? { sessionName: name } : {}) }, combined);
      result.creation = "confirmed";
      if (claim && !claim.release()) result.warning = "Session creation was confirmed, but name-reservation cleanup was not confirmed.";
    } catch {
      result.startup.reason = "Creation outcome is unknown: the CLI may have created a pane before its reply was lost. Inspect Rex; do not retry automatically."
        + (claim ? " Name reservation retained at " + claim.path : "");
      if (!own.signal.aborted) this.runtime.remember({ identity: result.identity, placement, creation: "unknown" });
      if (ticket) {
        this.config.messaging!.revokeReturn(ticket);
        result.returnSetup = { state: "unavailable", requestId: ticket.requestId, reason: "Creation is unknown; return permission revoked. Inspect Rex, do not relaunch or clean up automatically." };
      }
      return result;
    }
    // Record before verification so timeout/cancellation cannot invite replacement work.
    if (!own.signal.aborted) this.runtime.remember({ identity: result.identity, blockId: result.target.blockId, placement, creation: "confirmed" });
    if (client) {
      try {
        check();
        await this.runtime.rex.select(client, result.target, combined);
      } catch (error) {
        result.warning = (result.warning ? result.warning + " " : "") + "Session creation was confirmed, but selecting it in the Rex app was not confirmed. "
          + (error instanceof Error ? error.message : "App action did not confirm selection.");
      }
    }
    const observed = await this.waitForStartup(own, result.identity, result.target, combined, ticket ? check : undefined);
    result.startup = observed.startup;
    if (handle && observed.child && this.config.agents) {
      try { this.config.agents.observe(handle, { type: "binding.verified" }); }
      catch (error) {
        result.warning = (result.warning ? result.warning + " " : "")
          + "Agent binding evidence could not be recorded: " + (error instanceof Error ? error.message : String(error));
      }
    }
    if (ticket) {
      try {
        check();
        if (!observed.child) throw new Error("Exact child binding was not confirmed within the existing startup deadline");
        await this.config.messaging!.registerReturn(ticket, observed.child);
        check();
        result.returnSetup = { state: "registered", requestId: ticket.requestId };
      } catch (error) {
        this.config.messaging!.revokeReturn(ticket);
        result.returnSetup = { state: "unavailable", requestId: ticket.requestId,
          reason: "Pi creation remains confirmed, but result-return setup is unavailable: "
            + (error instanceof Error ? error.message : "verification interrupted")
            + ". Inspect the created pane; do not relaunch or clean up automatically." };
      }
    }
    return result;
  }
  private async waitForStartup(own: Snapshot, expected: Identity, target: Created, signal: AbortSignal, checkReturn?: () => void): Promise<{ startup: LaunchResult["startup"]; child?: Endpoint }> {
    const deadline = AbortSignal.timeout(this.config.startupTimeoutMs ?? 10_000);
    const bounded = AbortSignal.any([signal, deadline]);
    try {
      for (;;) {
        bounded.throwIfAborted(); this.runtime.assert(own); checkReturn?.();
        const binding = this.runtime.store.find(expected, own.server);
        if (binding) {
          if (binding.blockId !== target.blockId) throw new Error("The launched Pi identity appeared in a different pane");
          await this.runtime.rex.checkServer(bounded); checkReturn?.();
          const location = await this.runtime.rex.locate(target.blockId, bounded);
          checkReturn?.();
          if (location.sessionId !== target.sessionId) throw new Error("The created pane changed sessions during startup");
          await this.runtime.rex.verifyProcess(location, binding.pid, bounded);
          const current = this.runtime.store.find(expected, own.server);
          this.runtime.assert(own); checkReturn?.();
          if (!current || current.token !== binding.token) throw new Error("Child Pi binding changed during verification");
          bounded.throwIfAborted();
          return { startup: { state: "bound" }, child: endpointFromBinding(binding) };
        }
        await sleep(200, undefined, { signal: bounded });
      }
    } catch {
      return { startup: { state: "unconfirmed", reason: "The pane was created, but exact Pi initialization was not confirmed within the deadline or verification was interrupted. Inspect the returned pane before retrying. Creation is not task readiness or completion." } };
    }
  }
}
