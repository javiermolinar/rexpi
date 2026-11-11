/** Standalone SSH Unix-socket forwarding. No platform I/O is performed at import time. */

import { randomUUID } from "node:crypto";

export interface SshTransportRequest {
  /** Exact configured host identity and normalized alias; neither is an SSH target. */
  readonly hostId: string;
  readonly hostAlias: string;
  /** Explicit OpenSSH destination. It is never inferred from hostId or hostAlias. */
  readonly sshTarget: string;
  readonly localSocketPath: string;
  readonly remoteSocketPath: string;
}

export type SocketInspection =
  | { readonly kind: "missing" }
  | { readonly kind: "other" }
  /** identity is an opaque filesystem identity (for example, device/inode), not a path. */
  | { readonly kind: "socket"; readonly identity: string };

export interface SshProcess {
  readonly pid: number;
  /** Registers for one-shot exit notification and returns an unsubscribe function. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
  /** Output is deliberately discarded and never copied into diagnostics. */
  onStderr?(listener: (chunk: string | Uint8Array) => void): () => void;
  kill(signal?: NodeJS.Signals): void | Promise<void>;
}

export interface SshSpawnOptions {
  readonly shell: false;
  readonly signal: AbortSignal;
  /** Minimal allowlisted environment; arbitrary inherited variables are not forwarded. */
  readonly env: Readonly<Record<string, string>>;
}
export type SpawnSsh = (command: string, args: readonly string[], options: SshSpawnOptions) => SshProcess;
export type RexHealthProbe = (request: SshTransportRequest, options: {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}) => Promise<boolean>;
export type InspectSocket = (path: string, options: {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}) => Promise<SocketInspection>;
/** Must leave the path untouched unless its current identity equals expectedIdentity. */
export type UnlinkSocket = (path: string, options: {
  readonly expectedIdentity: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}) => Promise<boolean>;

/** A private socket path used by one SSH attempt, never the configured public endpoint. */
export interface SocketStaging {
  readonly directory: string;
  readonly path: string;
}
export type CreateSocketStaging = (configuredPath: string, options: {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}) => Promise<SocketStaging>;
/** Atomically hard-links staging.path to configuredPath without replacing an existing path. */
export type PublishStagedSocket = (staging: SocketStaging, configuredPath: string, options: {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}) => Promise<"published" | "exists">;
/** Removes only an empty private attempt directory; socket unlinking remains identity-checked. */
export type RemoveSocketStaging = (staging: SocketStaging, options: {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}) => Promise<void>;

export interface TunnelProcessIdentity {
  readonly pid: number;
  readonly startToken: string;
}
export interface TunnelJournalRecord {
  readonly version: 1;
  readonly attemptId: string;
  readonly hostId: string;
  readonly hostAlias: string;
  readonly request: SshTransportRequest;
  readonly staging: SocketStaging;
  readonly controller: TunnelProcessIdentity;
  readonly ssh?: TunnelProcessIdentity;
  readonly stagingIdentity?: string;
  readonly publicIdentity?: string;
}
export interface TunnelJournal {
  create(record: TunnelJournalRecord): Promise<void>;
  update(record: TunnelJournalRecord): Promise<void>;
  read(hostId: string): Promise<TunnelJournalRecord[]>;
  remove(record: TunnelJournalRecord): Promise<void>;
}
export type ProcessStartToken = (pid: number) => Promise<string | undefined>;
export type AttachProcess = (pid: number, startToken: string) => SshProcess;

export interface SshTransportSettings {
  readonly connectTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly probeTimeoutMs: number;
  readonly inspectionTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly serverAliveIntervalSeconds: number;
  readonly serverAliveCountMax: number;
}
export const DEFAULT_SSH_TRANSPORT_SETTINGS: Readonly<SshTransportSettings> = Object.freeze({
  connectTimeoutMs: 5000,
  startupTimeoutMs: 10_000,
  probeTimeoutMs: 1500,
  inspectionTimeoutMs: 1500,
  cleanupTimeoutMs: 2000,
  pollIntervalMs: 25,
  serverAliveIntervalSeconds: 15,
  serverAliveCountMax: 3,
});

export interface SshTransportOptions {
  readonly spawn: SpawnSsh;
  readonly probe: RexHealthProbe;
  readonly inspectSocket: InspectSocket;
  readonly unlinkSocket: UnlinkSocket;
  readonly createSocketStaging: CreateSocketStaging;
  readonly publishStagedSocket: PublishStagedSocket;
  readonly removeSocketStaging: RemoveSocketStaging;
  readonly journal?: TunnelJournal;
  readonly processStartToken?: ProcessStartToken;
  readonly attachProcess?: AttachProcess;
  readonly sshBinary?: string;
  readonly settings?: unknown;
  /** Only HOME, PATH, and SSH_AUTH_SOCK are copied. No secret variables are accepted. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface SshConnectionTicket {
  readonly hostId: string;
  readonly hostAlias: string;
  /** Absolute local Unix-socket path to pass to the existing Rex adapter. */
  readonly endpoint: string;
  /** External tunnels are borrowed for an operation, never adopted for cleanup. */
  readonly ownership: "external" | "rexpi";
}

export type SshTransportErrorCode =
  | "invalid_request" | "cancelled" | "conflict" | "timeout"
  | "inspection_failed" | "probe_failed" | "stale_socket" | "spawn_failed"
  | "startup_failed" | "disconnected" | "cleanup_failed" | "recovery_failed" | "operation_uncertain";

export class SshTransportError extends Error {
  readonly code: SshTransportErrorCode;
  readonly phase: "connection" | "operation" | "cleanup";
  /** False means the operation callback was never invoked. */
  readonly operationStarted: boolean;
  /** True only before dispatch. No post-dispatch error is safe to retry automatically. */
  readonly retryable: boolean;

  constructor(code: SshTransportErrorCode, message: string,
      phase: "connection" | "operation" | "cleanup" = "connection") {
    super(message);
    this.name = "SshTransportError";
    this.code = code;
    this.phase = phase;
    this.operationStarted = phase === "operation";
    this.retryable = phase === "connection";
  }
}

interface HostEntry {
  readonly hostId: string;
  readonly hostAlias: string;
  pending?: PendingConnect;
  active?: OwnedTunnel;
  recovered: boolean;
}
interface PendingConnect {
  readonly request: SshTransportRequest;
  readonly controller: AbortController;
  promise: Promise<SshConnectionTicket>;
  consumers: number;
  settled: boolean;
}
interface OwnedTunnel {
  readonly request: SshTransportRequest;
  readonly process: SshProcess;
  readonly exitPromise: Promise<void>;
  readonly finishExit: () => void;
  readonly disconnectListeners: Set<() => void>;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  staging?: SocketStaging;
  stagingIdentity?: string;
  journal?: TunnelJournalRecord;
  published: boolean;
  socketIdentity?: string;
  retired: boolean;
  cleanupPromise?: Promise<void>;
  removeExitListener?: () => void;
  removeStderrListener?: () => void;
}

function failure(code: SshTransportErrorCode, message: string,
    phase: "connection" | "operation" | "cleanup" = "connection"): SshTransportError {
  return new SshTransportError(code, message, phase);
}
function cancelled(): SshTransportError {
  return failure("cancelled", "SSH transport operation was cancelled before Rex dispatch");
}
function unknown(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failure("invalid_request", "Invalid " + source);
  return value as Record<string, unknown>;
}
function integer(root: Record<string, unknown>, key: keyof SshTransportSettings,
    fallback: number, minimum: number, maximum: number): number {
  const value = root[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw failure("invalid_request", "Invalid SSH transport setting: " + key);
  return value as number;
}
function settings(value: unknown): SshTransportSettings {
  if (value === undefined) return DEFAULT_SSH_TRANSPORT_SETTINGS;
  const root = unknown(value, "SSH transport settings");
  const allowed = new Set(Object.keys(DEFAULT_SSH_TRANSPORT_SETTINGS));
  if (Object.keys(root).some(key => !allowed.has(key)))
    throw failure("invalid_request", "Unknown SSH transport setting");
  const d = DEFAULT_SSH_TRANSPORT_SETTINGS;
  return Object.freeze({
    connectTimeoutMs: integer(root, "connectTimeoutMs", d.connectTimeoutMs, 1, 60_000),
    startupTimeoutMs: integer(root, "startupTimeoutMs", d.startupTimeoutMs, 1, 120_000),
    probeTimeoutMs: integer(root, "probeTimeoutMs", d.probeTimeoutMs, 1, 30_000),
    inspectionTimeoutMs: integer(root, "inspectionTimeoutMs", d.inspectionTimeoutMs, 1, 30_000),
    cleanupTimeoutMs: integer(root, "cleanupTimeoutMs", d.cleanupTimeoutMs, 1, 30_000),
    pollIntervalMs: integer(root, "pollIntervalMs", d.pollIntervalMs, 1, 1000),
    serverAliveIntervalSeconds: integer(root, "serverAliveIntervalSeconds", d.serverAliveIntervalSeconds, 1, 300),
    serverAliveCountMax: integer(root, "serverAliveCountMax", d.serverAliveCountMax, 1, 10),
  });
}
function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0-\x1f\x7f]/.test(value))
    throw failure("invalid_request", "Invalid " + name);
  return value;
}
function hostId(value: unknown): string {
  const id = text(value, "host ID", 256);
  if (!/^[a-z0-9][a-z0-9._:-]{0,255}$/i.test(id)) throw failure("invalid_request", "Invalid host ID");
  return id;
}
function hostAlias(value: unknown): string {
  const alias = text(value, "host alias", 253);
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(alias) || alias.includes(".."))
    throw failure("invalid_request", "Invalid normalized host alias");
  return alias;
}
function socketPath(value: unknown, name: string): string {
  const path = text(value, name, 4096);
  if (!path.startsWith("/") || /[:\[\]]/.test(path))
    throw failure("invalid_request", name + " must be absolute and cannot contain ':' or brackets");
  return path;
}
function request(value: unknown): SshTransportRequest {
  const root = unknown(value, "SSH transport request");
  const allowed = new Set(["hostId", "hostAlias", "sshTarget", "localSocketPath", "remoteSocketPath"]);
  if (Object.keys(root).some(key => !allowed.has(key)))
    throw failure("invalid_request", "Unknown SSH transport request field");
  const target = text(root.sshTarget, "explicit SSH target", 1024);
  if (target.trim() !== target) throw failure("invalid_request", "Invalid explicit SSH target");
  return Object.freeze({
    hostId: hostId(root.hostId),
    hostAlias: hostAlias(root.hostAlias),
    sshTarget: target,
    localSocketPath: socketPath(root.localSocketPath, "local socket path"),
    remoteSocketPath: socketPath(root.remoteSocketPath, "remote Rex socket path"),
  });
}
function sameRequest(a: SshTransportRequest, b: SshTransportRequest): boolean {
  return a.hostId === b.hostId && a.hostAlias === b.hostAlias && a.sshTarget === b.sshTarget
    && a.localSocketPath === b.localSocketPath && a.remoteSocketPath === b.remoteSocketPath;
}
function safeEnvironment(source: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "SSH_AUTH_SOCK"] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 32_768 || value.includes("\0"))
      throw failure("invalid_request", "Unsafe SSH environment value");
    if (key === "SSH_AUTH_SOCK" && !value.startsWith("/"))
      throw failure("invalid_request", "SSH agent socket must be an absolute path");
    result[key] = value;
  }
  return Object.freeze(result);
}
function validInspection(value: SocketInspection): SocketInspection {
  if (!value || typeof value !== "object" || !["missing", "other", "socket"].includes(value.kind))
    throw new Error("Malformed socket inspection");
  if (value.kind === "socket" && (typeof value.identity !== "string" || value.identity.length === 0))
    throw new Error("Malformed socket identity");
  return value;
}

/** Races a dependency even when it ignores its signal. Dependency errors are sanitized. */
async function bounded<T>(start: (signal: AbortSignal) => Promise<T>, timeoutMs: number,
    signal: AbortSignal | undefined, onTimeout: () => SshTransportError,
    onFailure: () => SshTransportError): Promise<T> {
  if (signal?.aborted) throw cancelled();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let interrupt!: (error: SshTransportError) => void;
  const interruption = new Promise<never>((_resolve, reject) => { interrupt = reject; });
  const onAbort = (): void => { controller.abort(); interrupt(cancelled()); };
  signal?.addEventListener("abort", onAbort, { once: true });
  timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    interrupt(onTimeout());
  }, timeoutMs);
  const work = Promise.resolve().then(() => start(controller.signal));
  try {
    return await Promise.race([work, interruption]);
  } catch (error) {
    if (timedOut) throw onTimeout();
    if (signal?.aborted) throw cancelled();
    throw onFailure();
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
function pause(timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, timeoutMs);
    const onAbort = (): void => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(cancelled()); };
    function done(): void { signal.removeEventListener("abort", onAbort); resolve(); }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class SshUnixSocketTransport {
  private readonly spawnProcess: SpawnSsh;
  private readonly probeHealth: RexHealthProbe;
  private readonly inspectPath: InspectSocket;
  private readonly unlinkPath: UnlinkSocket;
  private readonly createStaging: CreateSocketStaging;
  private readonly publishStaging: PublishStagedSocket;
  private readonly removeStaging: RemoveSocketStaging;
  private readonly journal?: TunnelJournal;
  private readonly processStartToken?: ProcessStartToken;
  private readonly attachProcess?: AttachProcess;
  private readonly binary: string;
  private readonly limits: SshTransportSettings;
  private readonly env: Readonly<Record<string, string>>;
  private readonly hosts = new Map<string, HostEntry>();
  private readonly ticketRequests = new WeakMap<SshConnectionTicket, SshTransportRequest>();
  private readonly ticketOwners = new WeakMap<SshConnectionTicket, OwnedTunnel>();

  constructor(options: SshTransportOptions) {
    const root = unknown(options, "SSH transport options");
    if (typeof root.spawn !== "function" || typeof root.probe !== "function"
        || typeof root.inspectSocket !== "function" || typeof root.unlinkSocket !== "function"
        || typeof root.createSocketStaging !== "function" || typeof root.publishStagedSocket !== "function"
        || typeof root.removeSocketStaging !== "function")
      throw failure("invalid_request", "SSH transport requires spawn, probe, socket ownership, and cleanup boundaries");
    if (root.journal && (typeof root.processStartToken !== "function" || typeof root.attachProcess !== "function"))
      throw failure("invalid_request", "SSH transport requires spawn, probe, socket ownership, and cleanup boundaries");
    this.spawnProcess = root.spawn as SpawnSsh;
    this.probeHealth = root.probe as RexHealthProbe;
    this.inspectPath = root.inspectSocket as InspectSocket;
    this.unlinkPath = root.unlinkSocket as UnlinkSocket;
    this.createStaging = root.createSocketStaging as CreateSocketStaging;
    this.publishStaging = root.publishStagedSocket as PublishStagedSocket;
    this.removeStaging = root.removeSocketStaging as RemoveSocketStaging;
    this.journal = root.journal as TunnelJournal | undefined;
    this.processStartToken = root.processStartToken as ProcessStartToken | undefined;
    this.attachProcess = root.attachProcess as AttachProcess | undefined;
    this.binary = text(root.sshBinary ?? "ssh", "OpenSSH binary", 4096);
    this.limits = settings(root.settings);
    this.env = safeEnvironment((root.environment ?? process.env) as Readonly<Record<string, string | undefined>>);
  }

  /** Concurrent identical requests share startup; conflicting host-scoped configurations fail. */
  connect(value: SshTransportRequest, signal?: AbortSignal): Promise<SshConnectionTicket> {
    const req = request(value);
    if (signal?.aborted) return Promise.reject(cancelled());
    let entry = this.hosts.get(req.hostId);
    if (entry && entry.hostAlias !== req.hostAlias)
      return Promise.reject(failure("conflict", "Host ID is already bound to a different alias"));
    for (const other of this.hosts.values())
      if (other.hostId !== req.hostId && other.hostAlias === req.hostAlias)
        return Promise.reject(failure("conflict", "Host alias is already bound to a different ID"));
    if (!entry) {
      entry = { hostId: req.hostId, hostAlias: req.hostAlias, recovered: false };
      this.hosts.set(req.hostId, entry);
    }
    if (entry.pending) {
      if (!sameRequest(entry.pending.request, req))
        return Promise.reject(failure("conflict", "Conflicting concurrent SSH transport configuration"));
      if (entry.pending.controller.signal.aborted) {
        const abandoned = entry.pending;
        // A new caller must not inherit another caller's cancellation. Join only the bounded cleanup.
        return abandoned.promise.catch(() => undefined).then(() => this.connect(req, signal));
      }
      return this.joinPending(entry.pending, signal);
    }
    if (entry.active && !sameRequest(entry.active.request, req))
      return Promise.reject(failure("conflict", "Conflicting active SSH transport configuration"));

    const controller = new AbortController();
    const pending = {
      request: req, controller, consumers: 0, settled: false,
    } as PendingConnect;
    entry.pending = pending;
    pending.promise = this.establish(entry, req, controller.signal).finally(() => {
      pending.settled = true;
      if (entry?.pending === pending) entry.pending = undefined;
    });
    return this.joinPending(pending, signal);
  }

  private joinPending(pending: PendingConnect, signal?: AbortSignal): Promise<SshConnectionTicket> {
    pending.consumers += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      pending.consumers -= 1;
      if (pending.consumers === 0 && !pending.settled) pending.controller.abort();
    };
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { release(); reject(cancelled()); };
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.promise.then(
        ticket => { release(); resolve(ticket); },
        error => { release(); reject(error); },
      ).finally(() => signal?.removeEventListener("abort", onAbort));
    });
  }

  private ticket(req: SshTransportRequest, owned?: OwnedTunnel): SshConnectionTicket {
    const ticket = Object.freeze({
      hostId: req.hostId, hostAlias: req.hostAlias, endpoint: req.localSocketPath,
      ownership: owned ? "rexpi" as const : "external" as const,
    });
    this.ticketRequests.set(ticket, req);
    if (owned) this.ticketOwners.set(ticket, owned);
    return ticket;
  }

  private async inspect(req: SshTransportRequest, timeoutMs: number,
      signal?: AbortSignal): Promise<SocketInspection> {
    const result = await bounded(
      boundary => this.inspectPath(req.localSocketPath, { signal: boundary, timeoutMs }), timeoutMs, signal,
      () => failure("timeout", "Socket inspection timed out"),
      () => failure("inspection_failed", "Socket inspection failed"),
    );
    try { return validInspection(result); }
    catch { throw failure("inspection_failed", "Socket inspection returned malformed data"); }
  }

  private async healthy(req: SshTransportRequest, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const result = await bounded(
      boundary => this.probeHealth(req, { signal: boundary, timeoutMs }), timeoutMs, signal,
      () => failure("timeout", "Rex health probe timed out"),
      () => failure("probe_failed", "Rex health probe failed"),
    );
    return result === true;
  }

  private journalRecord(value: unknown, req: SshTransportRequest): TunnelJournalRecord {
    const root = unknown(value, "tunnel journal record");
    if (root.version !== 1 || typeof root.attemptId !== "string" || !/^[0-9a-f-]{36}$/.test(root.attemptId)
        || root.hostId !== req.hostId || root.hostAlias !== req.hostAlias)
      throw failure("recovery_failed", "Tunnel journal identity is invalid");
    const savedRequest = request(root.request);
    if (!sameRequest(savedRequest, req)) throw failure("conflict", "Tunnel journal uses a different host configuration");
    const staging = unknown(root.staging, "tunnel staging");
    if (typeof staging.directory !== "string" || typeof staging.path !== "string"
        || !staging.directory.startsWith("/") || !staging.path.startsWith(staging.directory + "/"))
      throw failure("recovery_failed", "Tunnel journal staging is invalid");
    const processIdentity = (value: unknown, name: string): TunnelProcessIdentity => {
      const identity = unknown(value, name);
      if (!Number.isSafeInteger(identity.pid) || Number(identity.pid) <= 0
          || typeof identity.startToken !== "string" || !identity.startToken || identity.startToken.length > 4096)
        throw failure("recovery_failed", "Tunnel journal process identity is invalid");
      return { pid: Number(identity.pid), startToken: identity.startToken };
    };
    const controller = processIdentity(root.controller, "tunnel controller");
    const ssh = root.ssh === undefined ? undefined : processIdentity(root.ssh, "tunnel SSH process");
    for (const key of ["stagingIdentity", "publicIdentity"] as const)
      if (root[key] !== undefined && (typeof root[key] !== "string" || !(root[key] as string).length))
        throw failure("recovery_failed", "Tunnel journal socket identity is invalid");
    return { ...root, request: savedRequest,
      staging: { directory: staging.directory, path: staging.path }, controller, ssh } as TunnelJournalRecord;
  }

  private async cleanupJournalRecord(record: TunnelJournalRecord, signal: AbortSignal): Promise<void> {
    const timeout = this.limits.cleanupTimeoutMs;
    const publicIdentity = record.publicIdentity ?? record.stagingIdentity;
    if (publicIdentity) {
      const inspected = await this.inspect(record.request, timeout, signal);
      if (inspected.kind === "socket") {
        if (inspected.identity !== publicIdentity) throw failure("stale_socket", "Journaled public socket was replaced");
        await bounded(boundary => this.unlinkPath(record.request.localSocketPath, {
          expectedIdentity: publicIdentity, signal: boundary, timeoutMs: timeout,
        }), timeout, signal,
        () => failure("cleanup_failed", "Journaled public socket cleanup timed out", "cleanup"),
        () => failure("cleanup_failed", "Journaled public socket cleanup failed", "cleanup"));
      } else if (inspected.kind !== "missing") throw failure("stale_socket", "Journaled public path is not a socket");
    }
    if (record.stagingIdentity) {
      await bounded(boundary => this.unlinkPath(record.staging.path, {
        expectedIdentity: record.stagingIdentity as string, signal: boundary, timeoutMs: timeout,
      }), timeout, signal,
      () => failure("cleanup_failed", "Journaled staging socket cleanup timed out", "cleanup"),
      () => failure("cleanup_failed", "Journaled staging socket cleanup failed", "cleanup"));
    }
    await bounded(boundary => this.removeStaging(record.staging, { signal: boundary, timeoutMs: timeout }), timeout, signal,
      () => failure("cleanup_failed", "Journaled staging directory cleanup timed out", "cleanup"),
      () => failure("cleanup_failed", "Journaled staging directory cleanup failed", "cleanup"));
    await bounded(() => this.journal!.remove(record), timeout, signal,
      () => failure("cleanup_failed", "Tunnel journal removal timed out", "cleanup"),
      () => failure("cleanup_failed", "Tunnel journal removal failed", "cleanup"));
  }

  private trackOwnedProcess(entry: HostEntry, request: SshTransportRequest, process: SshProcess,
      state: Pick<OwnedTunnel, "published" | "staging" | "stagingIdentity" | "journal" | "socketIdentity">): OwnedTunnel {
    let finishExit!: () => void;
    const exitPromise = new Promise<void>(resolve => { finishExit = resolve; });
    const owned: OwnedTunnel = {
      request, process, exitPromise, finishExit, disconnectListeners: new Set(),
      exited: false, exitCode: null, exitSignal: null, retired: false, ...state,
    };
    entry.active = owned;
    owned.removeExitListener = process.onExit((code, exitSignal) => {
      if (owned.exited) return;
      owned.exited = true; owned.exitCode = code; owned.exitSignal = exitSignal;
      owned.finishExit(); this.notifyDisconnect(owned);
    });
    return owned;
  }

  private async recoverOwned(entry: HostEntry, req: SshTransportRequest,
      signal: AbortSignal): Promise<SshConnectionTicket | undefined> {
    if (!this.journal) return undefined;
    const records = await bounded(() => this.journal!.read(req.hostId), this.limits.inspectionTimeoutMs, signal,
      () => failure("timeout", "Tunnel journal read timed out"),
      () => failure("recovery_failed", "Tunnel journal read failed"));
    if (records.length === 0) return undefined;
    if (records.length !== 1) throw failure("conflict", "Multiple tunnel journal records claim this host");
    const record = this.journalRecord(records[0], req);
    const token = this.processStartToken!;
    const controllerToken = await bounded(() => token(record.controller.pid), this.limits.inspectionTimeoutMs, signal,
      () => failure("timeout", "Tunnel controller inspection timed out"),
      () => failure("recovery_failed", "Tunnel controller inspection failed"));
    const controllerAlive = controllerToken === record.controller.startToken;
    const stagedRequest: SshTransportRequest = { ...req, localSocketPath: record.staging.path };
    const publicInspection = await this.inspect(req, this.limits.inspectionTimeoutMs, signal);
    const stagingInspection = await this.inspect(stagedRequest, this.limits.inspectionTimeoutMs, signal);
    const expectedPublic = record.publicIdentity ?? record.stagingIdentity;
    const identitiesMatch = !!record.stagingIdentity && !!expectedPublic
      && publicInspection.kind === "socket" && publicInspection.identity === expectedPublic
      && stagingInspection.kind === "socket" && stagingInspection.identity === record.stagingIdentity
      && expectedPublic === record.stagingIdentity;
    if (controllerAlive) {
      if (identitiesMatch && await this.healthy(req, this.limits.probeTimeoutMs, signal))
        return this.ticket(req); // Another live controller owns cleanup; this conversation only borrows it.
      throw failure("stale_socket", "A live controller owns an unhealthy or replaced journaled tunnel");
    }
    if (!record.ssh) throw failure("stale_socket", "Journaled tunnel has no verified SSH process identity");
    const sshToken = await bounded(() => token(record.ssh!.pid), this.limits.inspectionTimeoutMs, signal,
      () => failure("timeout", "Journaled SSH process inspection timed out"),
      () => failure("recovery_failed", "Journaled SSH process inspection failed"));
    if (sshToken !== record.ssh.startToken) {
      // A missing PID or a changed start token proves the recorded child is gone; never signal its replacement.
      await this.cleanupJournalRecord(record, signal);
      return undefined;
    }
    const child = this.attachProcess!(record.ssh.pid, record.ssh.startToken);
    const owned = this.trackOwnedProcess(entry, req, child, {
      staging: record.staging, stagingIdentity: record.stagingIdentity, journal: record,
      published: true, socketIdentity: expectedPublic,
    });
    if (identitiesMatch && await this.healthy(req, this.limits.probeTimeoutMs, signal) && !owned.exited)
      return this.ticket(req, owned);
    await this.retireOwned(entry, owned);
    return undefined;
  }

  private async establish(entry: HostEntry, req: SshTransportRequest,
      signal: AbortSignal): Promise<SshConnectionTicket> {
    if (signal.aborted) throw cancelled();
    const active = entry.active;
    if (active) return this.reuseOwned(entry, active, signal);
    if (!entry.recovered) {
      const recovered = await this.recoverOwned(entry, req, signal);
      entry.recovered = true;
      if (recovered) return recovered;
    }

    const inspected = await this.inspect(req, this.limits.inspectionTimeoutMs, signal);
    if (inspected.kind === "other")
      throw failure("stale_socket", "Local forwarding path exists and is not a Unix socket");
    if (inspected.kind === "socket") {
      if (await this.healthy(req, this.limits.probeTimeoutMs, signal)) {
        if (signal.aborted) throw cancelled();
        return this.ticket(req); // Borrow only; do not retain process or cleanup ownership.
      }
      throw failure("stale_socket", "Existing Unix socket is stale or unhealthy; refusing to replace it");
    }
    return this.startOwned(entry, req, signal);
  }

  private async reuseOwned(entry: HostEntry, owned: OwnedTunnel,
      signal: AbortSignal): Promise<SshConnectionTicket> {
    if (owned.retired || owned.exited) {
      await this.retireOwned(entry, owned);
      throw failure("disconnected", "SSH tunnel disconnected before Rex dispatch");
    }
    const inspected = await this.inspect(owned.request, this.limits.inspectionTimeoutMs, signal);
    if (inspected.kind !== "socket" || inspected.identity !== owned.socketIdentity) {
      await this.retireOwned(entry, owned);
      throw failure("disconnected", "Owned SSH tunnel socket changed or disappeared before Rex dispatch");
    }
    if (!await this.healthy(owned.request, this.limits.probeTimeoutMs, signal) || owned.exited) {
      await this.retireOwned(entry, owned);
      throw failure("disconnected", "Owned SSH tunnel is unhealthy before Rex dispatch");
    }
    if (signal.aborted) throw cancelled();
    return this.ticket(owned.request, owned);
  }

  private sshArguments(req: SshTransportRequest): string[] {
    return [
      "-N", "-T",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      // Owned forwarding must not be adopted by, or persist inside, an external SSH control master.
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
      "-o", "ControlPersist=no",
      "-o", "ServerAliveInterval=" + this.limits.serverAliveIntervalSeconds,
      "-o", "ServerAliveCountMax=" + this.limits.serverAliveCountMax,
      "-o", "ConnectTimeout=" + Math.max(1, Math.ceil(this.limits.connectTimeoutMs / 1000)),
      "-L", req.localSocketPath + ":" + req.remoteSocketPath,
      "--", req.sshTarget,
    ];
  }

  private startupExit(owned: OwnedTunnel): SshTransportError {
    const detail = owned.exitCode !== null && Number.isInteger(owned.exitCode)
      ? " (exit " + owned.exitCode + ")" : "";
    return failure("startup_failed", "OpenSSH exited before Rex became healthy" + detail);
  }

  private async beforeExit<T>(work: Promise<T>, owned: OwnedTunnel): Promise<T> {
    return Promise.race([work, owned.exitPromise.then(() => { throw this.startupExit(owned); })]);
  }

  private async startOwned(entry: HostEntry, req: SshTransportRequest,
      signal: AbortSignal): Promise<SshConnectionTicket> {
    const deadline = Date.now() + this.limits.startupTimeoutMs;
    const remaining = (): number => {
      const left = deadline - Date.now();
      if (left <= 0) throw failure("timeout", "OpenSSH Unix-socket startup timed out");
      return left;
    };
    let staging: SocketStaging;
    try {
      staging = await bounded(
        boundary => this.createStaging(req.localSocketPath, { signal: boundary, timeoutMs: remaining() }),
        remaining(), signal,
        () => failure("timeout", "SSH staging creation timed out"),
        () => failure("startup_failed", "SSH staging creation failed"),
      );
      if (!staging || typeof staging.directory !== "string" || typeof staging.path !== "string"
          || !staging.directory.startsWith("/") || !staging.path.startsWith(staging.directory + "/")
          || staging.path === req.localSocketPath) throw new Error("Invalid staging");
    } catch (error) {
      if (error instanceof SshTransportError) throw error;
      throw failure("startup_failed", "SSH staging creation failed");
    }
    const stagedRequest: SshTransportRequest = Object.freeze({ ...req, localSocketPath: staging.path });
    let journalRecord: TunnelJournalRecord | undefined;
    if (this.journal) {
      try {
        const startToken = await bounded(() => this.processStartToken!(process.pid), remaining(), signal,
          () => failure("timeout", "Controller identity inspection timed out"),
          () => failure("startup_failed", "Controller identity inspection failed"));
        if (!startToken) throw failure("startup_failed", "Controller process identity is unavailable");
        journalRecord = {
          version: 1, attemptId: randomUUID(), hostId: req.hostId, hostAlias: req.hostAlias,
          request: req, staging, controller: { pid: process.pid, startToken },
        };
        await bounded(() => this.journal!.create(journalRecord!), remaining(), signal,
          () => failure("timeout", "Tunnel journal creation timed out"),
          () => failure("startup_failed", "Tunnel journal creation failed"));
      } catch (error) {
        try { await this.removeStaging(staging, { signal, timeoutMs: remaining() }); } catch { /* Leave private residue for diagnosis. */ }
        throw error;
      }
    }
    let child: SshProcess;
    try {
      child = this.spawnProcess(this.binary, this.sshArguments(stagedRequest), { shell: false, signal, env: this.env });
    } catch {
      try {
        await bounded(boundary => this.removeStaging(staging, { signal: boundary, timeoutMs: remaining() }),
          remaining(), undefined,
          () => failure("cleanup_failed", "SSH staging cleanup timed out", "cleanup"),
          () => failure("cleanup_failed", "SSH staging cleanup failed", "cleanup"));
      } catch { /* Preserve the sanitized spawn failure. */ }
      if (journalRecord) {
        try { await this.journal!.remove(journalRecord); } catch { /* Leave recovery evidence if removal fails. */ }
      }
      throw failure("spawn_failed", "OpenSSH could not be started");
    }
    if (journalRecord) {
      try {
        const startToken = await bounded(() => this.processStartToken!(child.pid), remaining(), signal,
          () => failure("timeout", "SSH process identity inspection timed out"),
          () => failure("startup_failed", "SSH process identity inspection failed"));
        if (!startToken) throw failure("startup_failed", "SSH process identity is unavailable");
        journalRecord = { ...journalRecord, ssh: { pid: child.pid, startToken } };
        await bounded(() => this.journal!.update(journalRecord!), remaining(), signal,
          () => failure("timeout", "Tunnel journal update timed out"),
          () => failure("startup_failed", "Tunnel journal update failed"));
      } catch (error) {
        try { await child.kill("SIGTERM"); } catch { /* No process authority is inferred. */ }
        let empty = false;
        try { await this.removeStaging(staging, { signal, timeoutMs: remaining() }); empty = true; } catch { /* Leave private residue and its journal. */ }
        if (empty) {
          try { await this.journal!.remove(journalRecord); } catch { /* Preserve recovery evidence. */ }
        }
        throw error;
      }
    }
    let owned: OwnedTunnel;
    try {
      owned = this.trackOwnedProcess(entry, req, child, { staging, published: false, journal: journalRecord });
    } catch {
      entry.active = undefined;
      try { await child.kill("SIGTERM"); } catch { /* The process handle is already unusable. */ }
      let empty = false;
      try {
        await bounded(boundary => this.removeStaging(staging, { signal: boundary, timeoutMs: remaining() }),
          remaining(), undefined,
          () => failure("cleanup_failed", "SSH staging cleanup timed out", "cleanup"),
          () => failure("cleanup_failed", "SSH staging cleanup failed", "cleanup"));
        empty = true;
      } catch { /* An unidentified socket or directory is left untouched. */ }
      if (journalRecord && empty) {
        try { await this.journal!.remove(journalRecord); } catch { /* Preserve recovery evidence. */ }
      }
      throw failure("spawn_failed", "OpenSSH process monitoring could not be established");
    }
    try {
      owned.removeStderrListener = child.onStderr?.(() => { /* Deliberately discard untrusted output. */ });
    } catch { /* Diagnostics are optional and never affect forwarding health. */ }

    try {
      for (;;) {
        if (signal.aborted) throw cancelled();
        if (owned.exited) throw this.startupExit(owned);
        const inspected = await this.beforeExit(
          this.inspect(stagedRequest, Math.min(this.limits.inspectionTimeoutMs, remaining()), signal), owned);
        if (inspected.kind === "other")
          throw failure("startup_failed", "OpenSSH staging path is not a Unix socket");
        if (inspected.kind === "socket") {
          // A private per-attempt path proves this identity belongs to this child, not another Rexpi process.
          owned.stagingIdentity = inspected.identity;
          if (journalRecord) {
            journalRecord = { ...journalRecord, stagingIdentity: inspected.identity };
            owned.journal = journalRecord;
            await bounded(() => this.journal!.update(journalRecord!), remaining(), signal,
              () => failure("timeout", "Tunnel journal socket update timed out"),
              () => failure("startup_failed", "Tunnel journal socket update failed"));
          }
          const healthy = await this.beforeExit(
            this.healthy(stagedRequest, Math.min(this.limits.probeTimeoutMs, remaining()), signal), owned);
          if (healthy) {
            if (owned.exited) throw this.startupExit(owned);
            if (signal.aborted) throw cancelled();
            const publication = await this.beforeExit(bounded(
              boundary => this.publishStaging(staging, req.localSocketPath, {
                signal: boundary, timeoutMs: Math.min(this.limits.inspectionTimeoutMs, remaining()),
              }), Math.min(this.limits.inspectionTimeoutMs, remaining()), signal,
              () => failure("timeout", "SSH socket publication timed out"),
              () => failure("startup_failed", "SSH socket publication failed"),
            ), owned);
            if (publication === "exists")
              throw failure("conflict", "Configured SSH forwarding path appeared during startup; it was left untouched");
            if (publication !== "published") throw failure("startup_failed", "SSH socket publication returned invalid evidence");
            // Only an atomic no-replace link from our private staging path establishes public-path ownership.
            owned.published = true;
            owned.socketIdentity = inspected.identity;
            if (journalRecord) {
              journalRecord = { ...journalRecord, publicIdentity: inspected.identity };
              owned.journal = journalRecord;
              await bounded(() => this.journal!.update(journalRecord!), remaining(), signal,
                () => failure("timeout", "Tunnel journal publication update timed out"),
                () => failure("startup_failed", "Tunnel journal publication update failed"));
            }
            const published = await this.beforeExit(
              this.inspect(req, Math.min(this.limits.inspectionTimeoutMs, remaining()), signal), owned);
            if (published.kind !== "socket" || published.identity !== owned.socketIdentity)
              throw failure("startup_failed", "Published SSH socket identity changed during startup");
            if (owned.exited) throw this.startupExit(owned);
            if (signal.aborted) throw cancelled();
            return this.ticket(req, owned);
          }
        }
        await this.beforeExit(pause(Math.min(this.limits.pollIntervalMs, remaining()), signal), owned);
      }
    } catch (error) {
      try { await this.retireOwned(entry, owned); } catch { /* Preserve the sanitized startup error. */ }
      if (signal.aborted) throw cancelled();
      if (error instanceof SshTransportError) throw error;
      throw failure("startup_failed", "OpenSSH Unix-socket startup failed");
    }
  }

  private notifyDisconnect(owned: OwnedTunnel): void {
    for (const listener of [...owned.disconnectListeners]) {
      try { listener(); } catch { /* Notification cannot alter process ownership. */ }
    }
  }

  private retireOwned(entry: HostEntry, owned: OwnedTunnel, signal?: AbortSignal): Promise<void> {
    owned.retired = true;
    this.notifyDisconnect(owned);
    if (owned.cleanupPromise) return owned.cleanupPromise;
    const cleanup = this.cleanupOwned(entry, owned, signal);
    owned.cleanupPromise = cleanup;
    void cleanup.then(
      () => { if (owned.cleanupPromise === cleanup) owned.cleanupPromise = undefined; },
      () => { if (owned.cleanupPromise === cleanup) owned.cleanupPromise = undefined; },
    );
    return cleanup;
  }

  private async cleanupOwned(entry: HostEntry, owned: OwnedTunnel, signal?: AbortSignal): Promise<void> {
    const timeout = this.limits.cleanupTimeoutMs;
    try {
      if (!owned.exited) {
        try { await owned.process.kill("SIGTERM"); }
        catch { throw failure("cleanup_failed", "Owned OpenSSH process could not be signalled", "cleanup"); }
        try {
          await bounded(() => owned.exitPromise, timeout, signal,
            () => failure("cleanup_failed", "Owned OpenSSH process did not exit before the cleanup deadline", "cleanup"),
            () => failure("cleanup_failed", "Owned OpenSSH process cleanup failed", "cleanup"));
        } catch (error) {
          if (signal?.aborted || !(error instanceof SshTransportError)) throw error;
          try { await owned.process.kill("SIGKILL"); }
          catch { throw failure("cleanup_failed", "Owned OpenSSH process could not be killed", "cleanup"); }
          await bounded(() => owned.exitPromise, timeout, undefined,
            () => failure("cleanup_failed", "Owned OpenSSH process did not exit after SIGKILL", "cleanup"),
            () => failure("cleanup_failed", "Owned OpenSSH process cleanup failed", "cleanup"));
        }
      }
      let pathError: unknown;
      // Public-path ownership exists only after the atomic staging publication succeeded.
      try {
        if (owned.published && owned.socketIdentity !== undefined) {
          const inspected = validInspection(await bounded(
            boundary => this.inspectPath(owned.request.localSocketPath, { signal: boundary, timeoutMs: timeout }),
            timeout, signal,
            () => failure("cleanup_failed", "Owned socket inspection timed out", "cleanup"),
            () => failure("cleanup_failed", "Owned socket inspection failed", "cleanup"),
          ));
          if (inspected.kind === "socket" && inspected.identity === owned.socketIdentity) {
            await bounded(
              boundary => this.unlinkPath(owned.request.localSocketPath, {
                expectedIdentity: owned.socketIdentity as string, signal: boundary, timeoutMs: timeout,
              }), timeout, signal,
              () => failure("cleanup_failed", "Owned socket removal timed out", "cleanup"),
              () => failure("cleanup_failed", "Owned socket removal failed", "cleanup"),
            );
          }
        }
      } catch (error) { pathError = error; }
      try {
        if (owned.staging) {
          if (owned.stagingIdentity !== undefined) {
            await bounded(
              boundary => this.unlinkPath(owned.staging!.path, {
                expectedIdentity: owned.stagingIdentity as string, signal: boundary, timeoutMs: timeout,
              }), timeout, signal,
              () => failure("cleanup_failed", "Staged socket removal timed out", "cleanup"),
              () => failure("cleanup_failed", "Staged socket removal failed", "cleanup"),
            );
          }
          // This boundary may remove only an empty directory, never an unidentified socket or recursive tree.
          await bounded(
            boundary => this.removeStaging(owned.staging!, { signal: boundary, timeoutMs: timeout }), timeout, signal,
            () => failure("cleanup_failed", "SSH staging directory cleanup timed out", "cleanup"),
            () => failure("cleanup_failed", "SSH staging directory cleanup failed", "cleanup"),
          );
        }
      } catch (error) { if (!pathError) pathError = error; }
      if (pathError) throw pathError;
      if (owned.journal) {
        await bounded(() => this.journal!.remove(owned.journal!), timeout, signal,
          () => failure("cleanup_failed", "Tunnel journal removal timed out", "cleanup"),
          () => failure("cleanup_failed", "Tunnel journal removal failed", "cleanup"));
      }
      owned.removeExitListener?.();
      owned.removeStderrListener?.();
      if (entry.active === owned) entry.active = undefined;
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (error instanceof SshTransportError && error.phase === "cleanup") throw error;
      throw failure("cleanup_failed", "Owned SSH tunnel cleanup failed", "cleanup");
    }
  }

  /**
   * Dispatches operation exactly once. Connection attempts happen only before dispatch.
   * Any callback error, cancellation, or owned-tunnel disconnect after dispatch is uncertain.
   */
  async withOperation<T>(value: SshTransportRequest,
      operation: (ticket: SshConnectionTicket, signal: AbortSignal) => T | Promise<T>,
      signal?: AbortSignal): Promise<T> {
    if (typeof operation !== "function") throw failure("invalid_request", "A Rex operation callback is required");
    const ticket = await this.connect(value, signal);
    const owned = this.ticketOwners.get(ticket);
    if (signal?.aborted) throw cancelled();
    if (owned && (owned.exited || owned.retired || this.hosts.get(ticket.hostId)?.active !== owned))
      throw failure("disconnected", "SSH tunnel disconnected before Rex dispatch");

    const controller = new AbortController();
    let interrupt!: (error: SshTransportError) => void;
    const interruption = new Promise<never>((_resolve, reject) => { interrupt = reject; });
    const uncertain = (): SshTransportError => failure("operation_uncertain",
      "Rex operation failed after dispatch; its outcome is uncertain and it must not be retried automatically", "operation");
    const onAbort = (): void => { controller.abort(); interrupt(uncertain()); };
    const onDisconnect = (): void => { controller.abort(); interrupt(uncertain()); };
    signal?.addEventListener("abort", onAbort, { once: true });
    owned?.disconnectListeners.add(onDisconnect);

    let work: Promise<T>;
    try {
      // Invoke synchronously and exactly once; no transport code retries this callback.
      work = Promise.resolve(operation(ticket, controller.signal));
    } catch {
      signal?.removeEventListener("abort", onAbort);
      owned?.disconnectListeners.delete(onDisconnect);
      throw uncertain();
    }
    try {
      return await Promise.race([work, interruption]);
    } catch {
      throw uncertain();
    } finally {
      signal?.removeEventListener("abort", onAbort);
      owned?.disconnectListeners.delete(onDisconnect);
    }
  }

  /**
   * Rechecks the exact ticket without connecting or replacing its tunnel. Operational failure is
   * unhealthy rather than exceptional; cancellation remains exceptional. External tickets verify
   * the current endpoint, while owned tickets must still reference the same process and socket.
   */
  async probe(ticket: SshConnectionTicket, signal?: AbortSignal): Promise<boolean> {
    const req = this.ticketRequests.get(ticket);
    if (!req) throw failure("invalid_request", "Unknown SSH connection ticket");
    if (signal?.aborted) throw cancelled();
    const owned = this.ticketOwners.get(ticket);
    if (ticket.ownership === "rexpi" && !owned) return false;
    if (owned && (owned.exited || owned.retired || this.hosts.get(req.hostId)?.active !== owned)) return false;
    try {
      if (owned) {
        const inspected = await this.inspect(req, this.limits.inspectionTimeoutMs, signal);
        if (inspected.kind !== "socket" || inspected.identity !== owned.socketIdentity) return false;
      }
      if (!await this.healthy(req, this.limits.probeTimeoutMs, signal)) return false;
      return !owned || (!owned.exited && !owned.retired && this.hosts.get(req.hostId)?.active === owned);
    } catch (error) {
      if (signal?.aborted || (error instanceof SshTransportError && error.code === "cancelled")) throw cancelled();
      return false;
    }
  }

  /** Subscribes only Rexpi-owned process lifecycle; external tunnels use probe() for health monitoring. */
  onDisconnect(ticket: SshConnectionTicket, listener: () => void): () => void {
    const owned = this.ticketOwners.get(ticket);
    if (!owned) return () => { /* External tunnels have no process handle to monitor. */ };
    owned.disconnectListeners.add(listener);
    if (owned.exited || owned.retired) queueMicrotask(listener);
    return () => { owned.disconnectListeners.delete(listener); };
  }

  /** Closes only a tunnel spawned by this connector. Borrowed external tunnels are untouched. */
  async close(binding: Pick<SshTransportRequest, "hostId" | "hostAlias">, signal?: AbortSignal): Promise<void> {
    const id = hostId(binding?.hostId), alias = hostAlias(binding?.hostAlias);
    if (signal?.aborted) throw cancelled();
    const entry = this.hosts.get(id);
    if (!entry) return;
    if (entry.hostAlias !== alias) throw failure("conflict", "Host ID is bound to a different alias");
    if (entry.pending) {
      entry.pending.controller.abort();
      try { await entry.pending.promise; } catch { /* Startup performs its own bounded cleanup. */ }
    }
    if (entry.active) await this.retireOwned(entry, entry.active, signal);
  }

  async closeAll(signal?: AbortSignal): Promise<void> {
    // Start every close before awaiting any: shutdown must signal all owned children immediately.
    const results = await Promise.allSettled([...this.hosts.values()]
      .map(entry => this.close({ hostId: entry.hostId, hostAlias: entry.hostAlias }, signal)));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
  }
}
