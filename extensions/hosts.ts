import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rmdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HostRegistry, type HostExecResult } from "../lib/hosts.ts";
import {
  HostSelection,
  parseHostSettings,
  type HostSelectionIntent,
  type HostSettings,
} from "../lib/host-selection.ts";
import { Rex, type Exec } from "../lib/rex.ts";
import { NodeTunnelJournal } from "../lib/tunnel-journal.ts";
import { requireFeature, type Runtime } from "../lib/runtime.ts";
import {
  SshUnixSocketTransport,
  type CreateSocketStaging,
  type InspectSocket,
  type PublishStagedSocket,
  type RemoveSocketStaging,
  type ProcessStartToken,
  type AttachProcess,
  type RexHealthProbe,
  type SpawnSsh,
  type SshProcess,
  type SshTransportRequest,
  type UnlinkSocket,
} from "../lib/ssh-transport.ts";

/** Concrete literal-argv OpenSSH process boundary. stderr is streamed only to the transport's discarding listener. */
export const spawnSshProcess: SpawnSsh = (command, args, options): SshProcess => {
  const child = spawn(command, [...args], {
    shell: false,
    signal: options.signal,
    env: { ...options.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const listeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  let exited = false, exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exited) return;
    exited = true; exitCode = code; exitSignal = signal;
    for (const listener of [...listeners]) listener(code, signal);
  };
  // A spawn error is a terminal startup event and must also have an error listener to avoid an unhandled EventEmitter error.
  child.once("error", () => { if (child.pid === undefined) finish(null, null); });
  child.once("exit", (code, signal) => finish(code, signal));
  return {
    onExit(listener) {
      if (exited) queueMicrotask(() => listener(exitCode, exitSignal));
      else {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      }
      return () => { /* one-shot notification was already queued */ };
    },
    onStderr(listener) {
      if (!child.stderr) return () => { /* no stderr stream */ };
      const handler = (chunk: Buffer): void => { listener(chunk); };
      child.stderr.on("data", handler);
      return () => { child.stderr?.off("data", handler); };
    },
    pid: child.pid ?? -1,
    kill(signal = "SIGTERM") { child.kill(signal); },
  };
};

function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}

/** lstat never follows a symlink and supplies an opaque device/inode identity for conditional cleanup. */
export const inspectUnixSocket: InspectSocket = async (path, options) => {
  options.signal.throwIfAborted();
  let stats;
  try { stats = await lstat(path, { bigint: true }); }
  catch (error) { if (missing(error)) return { kind: "missing" }; throw error; }
  options.signal.throwIfAborted();
  if (!stats.isSocket()) return { kind: "other" };
  return { kind: "socket", identity: stats.dev.toString() + ":" + stats.ino.toString() };
};

/** Re-inspects immediately before unlink; mismatched or replaced paths are left untouched. */
export const unlinkOwnedUnixSocket: UnlinkSocket = async (path, options) => {
  options.signal.throwIfAborted();
  let stats;
  try { stats = await lstat(path, { bigint: true }); }
  catch (error) { if (missing(error)) return false; throw error; }
  options.signal.throwIfAborted();
  if (!stats.isSocket() || stats.dev.toString() + ":" + stats.ino.toString() !== options.expectedIdentity)
    return false;
  try { await unlink(path); }
  catch (error) { if (missing(error)) return false; throw error; }
  return true;
};

export const createUnixSocketStaging: CreateSocketStaging = async (configuredPath, options) => {
  options.signal.throwIfAborted();
  // A sibling directory keeps the atomic hard-link publication on the same filesystem.
  const directory = join(dirname(configuredPath), ".rexpi-" + randomUUID());
  await mkdir(directory, { mode: 0o700 });
  return { directory, path: join(directory, "forward.sock") };
};

export const publishUnixSocket: PublishStagedSocket = async (staging, configuredPath, options) => {
  options.signal.throwIfAborted();
  try {
    // link() publishes the same inode atomically and, unlike rename(), cannot replace a winner.
    await link(staging.path, configuredPath);
    return "published";
  } catch (error) {
    if (!!error && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST") return "exists";
    throw error;
  }
};

export const removeUnixSocketStaging: RemoveSocketStaging = async (staging, options) => {
  options.signal.throwIfAborted();
  // Never recursive: a replaced or unidentified socket makes this fail instead of deleting it.
  try { await rmdir(staging.directory); }
  catch (error) { if (!missing(error)) throw error; }
};

/**
 * Remote health is exactly a bounded `rex -S <forward> whoami --json` identity check.
 * No local same-UID/caller-block validation is applied, and a remote-reported endpoint is ignored.
 */
export function createRemoteRexHealthProbe(exec: Exec, rexBinary: string, settings: HostSettings): RexHealthProbe {
  return async (request: SshTransportRequest, options): Promise<boolean> => {
    const expected = settings.connections.get(request.hostAlias);
    if (!expected) return false;
    const rex = new Rex(rexBinary, exec, request.localSocketPath);
    const identity = await rex.json(["whoami", "--json"], options.signal);
    return identity.host_id === expected.expectedServerHostId
      && identity.instance_id === expected.expectedServerInstanceId;
  };
}

function processStartToken(exec: Exec): ProcessStartToken {
  return async pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    const result = await exec("ps", ["-p", String(pid), "-o", "lstart="],
      { timeout: 2000, maxBuffer: 4096 });
    if (result.killed || result.truncated) throw new Error("Process identity inspection was interrupted");
    if (result.code !== 0) return undefined;
    const token = result.stdout.trim().replace(/\s+/g, " ");
    return token || undefined;
  };
}

function attachOwnedProcess(pid: number, startToken: string, identify: ProcessStartToken): SshProcess {
  const listeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let exited = false;
  const finish = (): void => {
    if (exited) return;
    exited = true;
    if (timer) clearInterval(timer);
    for (const listener of [...listeners]) listener(null, null);
  };
  return {
    pid,
    onExit(listener) {
      listeners.add(listener);
      if (!timer) {
        timer = setInterval(() => {
          void identify(pid).then(token => { if (token !== startToken) finish(); }).catch(() => { /* Unknown stays alive/fail-closed. */ });
        }, 250);
        timer.unref();
      }
      return () => { listeners.delete(listener); };
    },
    async kill(signal = "SIGTERM") {
      const current = await identify(pid);
      if (current !== startToken) { finish(); return; }
      process.kill(pid, signal);
    },
  };
}

export interface NodeHostSelectionOptions {
  readonly settings?: unknown;
  readonly entries?: readonly unknown[];
  readonly persist: (intent: HostSelectionIntent) => void;
  readonly exec: Exec;
  readonly rexBinary: string;
  readonly journalDirectory: string;
  readonly tailscaleBinary?: string;
  readonly sshBinary?: string;
}

/** Builds all platform boundaries without performing I/O. Discovery and connection remain invocation-only. */
export function createNodeHostSelection(runtime: Runtime, options: NodeHostSelectionOptions): HostSelection {
  const settings = parseHostSettings(options.settings);
  const exec = options.exec;
  const registry = new HostRegistry(
    async (command, args, execOptions): Promise<HostExecResult> => exec(command, args, execOptions),
    {
      settings: settings.discovery,
      rexBinary: options.rexBinary,
      tailscaleBinary: options.tailscaleBinary,
      readText: async (path, readOptions) => {
        const metadata = await stat(path);
        if (!metadata.isFile() || metadata.size > readOptions.maxBytes) throw new Error("OpenSSH configuration is not a bounded regular file");
        return readFile(path, { encoding: "utf8", signal: readOptions.signal });
      },
    },
  );
  const identify = processStartToken(exec);
  const transport = new SshUnixSocketTransport({
    spawn: spawnSshProcess,
    probe: createRemoteRexHealthProbe(exec, options.rexBinary, settings),
    inspectSocket: inspectUnixSocket,
    unlinkSocket: unlinkOwnedUnixSocket,
    createSocketStaging: createUnixSocketStaging,
    publishStagedSocket: publishUnixSocket,
    removeSocketStaging: removeUnixSocketStaging,
    journal: new NodeTunnelJournal(options.journalDirectory),
    processStartToken: identify,
    attachProcess: (pid, startToken) => attachOwnedProcess(pid, startToken, identify),
    sshBinary: options.sshBinary,
  });
  return new HostSelection(runtime, registry, transport, {
    settings: options.settings,
    entries: options.entries,
    persist: options.persist,
  });
}

export interface HostToolsState {
  runtime?: Runtime;
  hostSelection?: HostSelection;
}

function currentHostSelection(current: () => HostToolsState, sessionId: string): HostSelection {
  const { runtime, hostSelection } = current();
  requireFeature(runtime, runtime, sessionId);
  if (!hostSelection) throw new Error("Rexpi host selection is unavailable; local Rexpi remains active");
  return hostSelection;
}

export function registerHostTools(pi: ExtensionAPI, current: () => HostToolsState): void {
  pi.registerTool({
    name: "rexpi_hosts",
    label: "List Rex hosts",
    description: "List Rex hosts.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    parameters: Type.Object({
      openSsh: Type.Optional(Type.Boolean()),
      tailscale: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const selected = currentHostSelection(current, ctx.sessionManager.getSessionId());
      const details = await selected.discover({
        tailscale: params.tailscale === true,
        ...(params.openSsh === true ? { openSsh: { configPath: join(homedir(), ".ssh", "config") } } : {}),
      }, signal);
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "rexpi_connect_host",
    label: "Select conversation Rex host",
    description: "Select this conversation's host.",
    executionMode: "sequential",
    parameters: Type.Object({
      host: Type.String({ minLength: 1, maxLength: 1024 }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const selected = currentHostSelection(current, ctx.sessionManager.getSessionId());
      const details = await selected.connect(params.host, signal);
      const text = details.kind === "local"
        ? "Selected the already verified local Rex server for only this Pi conversation. host_id="
          + details.serverHostId + " instance_id=" + details.serverInstanceId
        : "Verified and selected configured host '" + details.alias + "' for only this Pi conversation. Rex server host_id="
          + details.expectedServerHostId + " instance_id=" + details.expectedServerInstanceId;
      return { content: [{ type: "text", text }], details };
    },
  });
}
