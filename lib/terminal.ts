import { basename } from "node:path";
import { executable } from "./executable.ts";
import { launchDirectory } from "./launch.ts";
import { Runtime } from "./runtime.ts";
import { cleanTitle } from "./state.ts";
import type { Created } from "./rex.ts";

export type TerminalPlacement = "session" | "right" | "down" | "tab" | "floating";
/** Retained outcomes are small; the bound only forces an explicit reload in pathological sessions. */
const MAX_REQUESTS = 4096;
export type Bounds = [number, number, number, number];
export type Command = string | string[];
export interface TerminalOptions {
  command: Command;
  placement?: TerminalPlacement;
  cwd?: string;
  title?: string;
  focus?: boolean;
  keepOpen?: boolean;
  bounds?: Bounds;
}
export interface TerminalExecutionHost {
  kind: "local" | "remote";
  alias: string;
  configuration: "local" | "configured";
  /** Configured rex hosts identity, distinct from the server UUIDs below. */
  configuredHostId?: string;
  expectedServerHostId?: string;
  expectedServerInstanceId?: string;
  /** Identity verified at the server used for this operation. */
  serverHostId: string;
  serverInstanceId: string;
}
export interface TerminalLocalOrigin {
  blockId: string;
  serverHostId: string;
  serverInstanceId: string;
}
export interface TerminalResult {
  requestId: string;
  creation: "confirmed" | "unknown";
  placement: TerminalPlacement;
  executionHost: TerminalExecutionHost;
  localOrigin: TerminalLocalOrigin;
  target?: Created;
  reason?: string;
}
export function validateBounds(value: unknown): asserts value is Bounds {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(v => typeof v === "number" && Number.isFinite(v)))
    throw new Error("bounds must be four finite numbers: [x, y, width, height]");
  const [x, y, w, h] = value as number[];
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 || y + h > 1)
    throw new Error("Floating bounds must fit inside the window (fractions from 0 to 1)");
}
export function validateTerminal(options: TerminalOptions): void {
  const cmd = options.command;
  if (typeof cmd === "string") {
    if (!cmd.trim() || cmd.length > 16384 || cmd.includes("\0")) throw new Error("command must be nonempty shell text (maximum 16,384 characters)");
  } else if (!Array.isArray(cmd) || cmd.length === 0 || cmd.length > 128 || !cmd[0]
      || !cmd.every(v => typeof v === "string" && v.length <= 4096 && !v.includes("\0")))
    throw new Error("command must be a valid executable/argument array");
  else if (cmd.reduce((size, v) => size + v.length, 0) > 32768)
    throw new Error("command arguments exceed the 32,768-character total limit");
  if (options.placement !== undefined && !["session", "right", "down", "tab", "floating"].includes(options.placement)) throw new Error("Invalid terminal placement");
  for (const name of ["cwd", "title"] as const) {
    const value = options[name];
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > (name === "title" ? 120 : 4096)
        || /[\u0000-\u001f\u007f-\u009f]/.test(value))) throw new Error("Invalid terminal " + name);
  }
  for (const name of ["focus", "keepOpen"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "boolean") throw new Error(name + " must be boolean");
  }
  if (options.bounds !== undefined) {
    if (options.placement !== "floating") throw new Error("bounds apply only to floating placement");
    validateBounds(options.bounds);
  }
}
export function terminalArgv(command: Command, cwd: string, path: string): string[] {
  return ["/usr/bin/env", "PATH=" + path, ...(typeof command === "string"
    ? ["/bin/sh", "-c", command]
    : [executable(command[0], cwd, path), ...command.slice(1)])];
}
export function terminalText(result: TerminalResult): string {
  if (result.executionHost.kind === "local") {
    if (result.creation === "unknown") return "Terminal creation outcome is unknown. " + result.reason;
    return "Created " + result.placement + " terminal " + result.target!.blockId
      + ". Creation is not command readiness, success, or completion.";
  }
  if (result.creation === "unknown") return "Terminal creation outcome is unknown on host '" + result.executionHost.alias + "'. " + result.reason;
  return "Created " + result.placement + " terminal " + result.target!.blockId + " on host '" + result.executionHost.alias
    + "' (host_id=" + result.executionHost.serverHostId + ", instance_id=" + result.executionHost.serverInstanceId
    + "). Creation is not command readiness, success, or completion.";
}
export function localTerminalEvidence(own: { server: { hostId: string; instanceId: string }; blockId: string }): {
  executionHost: TerminalExecutionHost; localOrigin: TerminalLocalOrigin;
} {
  return {
    executionHost: { kind: "local", alias: "local", configuration: "local",
      serverHostId: own.server.hostId, serverInstanceId: own.server.instanceId },
    localOrigin: { blockId: own.blockId, serverHostId: own.server.hostId, serverInstanceId: own.server.instanceId },
  };
}
export function unknownTerminalResult(requestId: string, placement: TerminalPlacement,
    evidence: { executionHost: TerminalExecutionHost; localOrigin: TerminalLocalOrigin }): TerminalResult {
  return { requestId, creation: "unknown", placement, ...evidence,
    reason: "The command may have started before its creation reply was lost or interrupted. Inspect Rex before any deliberate retry; no retry or cleanup was attempted." };
}
/** Arbitrary terminal commands, separate from Pi conversation launches and configured shortcuts. */
export class TerminalOpener {
  private readonly runtime: Runtime;
  private readonly path: string;
  // Settled outcomes replace their promises: repeated IDs inspect compact evidence instead of
  // creating a second terminal, so entries are retained rather than evicted.
  private readonly requests = new Map<string, Promise<TerminalResult> | TerminalResult>();
  constructor(runtime: Runtime, path = process.env.PATH ?? "") { this.runtime = runtime; this.path = path; }
  open(id: string, options: TerminalOptions, cwd: string, signal?: AbortSignal): Promise<TerminalResult> {
    const previous = this.requests.get(id);
    if (previous) return Promise.resolve(previous);
    if (this.requests.size >= MAX_REQUESTS)
      return Promise.reject(new Error("Terminal request history is full (" + MAX_REQUESTS + "); reload explicitly before more opens"));
    const result = this.perform(id, options, cwd, signal);
    this.requests.set(id, result);
    void result.then(value => { this.requests.set(id, value); }, () => { /* rejected IDs keep their evidence */ });
    return result;
  }
  private async perform(id: string, options: TerminalOptions, cwd: string, signal?: AbortSignal): Promise<TerminalResult> {
    validateTerminal(options);
    const own = this.runtime.snapshot();
    const combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
    combined.throwIfAborted();
    const directory = launchDirectory(options.cwd, cwd);
    const command = terminalArgv(options.command, directory, this.path);
    const source = await this.runtime.source(own, combined);
    const placement = options.placement ?? "right";
    const title = cleanTitle(options.title ?? (Array.isArray(options.command) ? basename(options.command[0]) : "Terminal"));
    this.runtime.assert(own); combined.throwIfAborted();
    try {
      const target = await this.runtime.rex.create({ placement, source, cwd: directory, command, title,
        focus: options.focus ?? true, keepOpen: options.keepOpen ?? false, labelPrefix: "",
        ...(placement === "floating" ? { bounds: options.bounds ?? [0.1, 0.1, 0.8, 0.8] } : {}) }, combined);
      return { requestId: id, creation: "confirmed", placement, ...localTerminalEvidence(own), target };
    } catch {
      return unknownTerminalResult(id, placement, localTerminalEvidence(own));
    }
  }
}
