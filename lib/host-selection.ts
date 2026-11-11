import {
  normalizeHostAlias,
  parseHostRegistrySettings,
  type ConfiguredRexHost,
  type HostDiscoveryRequest,
  type HostRegistrySettings,
  type HostRegistrySnapshot,
} from "./hosts.ts";
import type {
  SshConnectionTicket,
  SshTransportRequest,
} from "./ssh-transport.ts";
import { uuid } from "./state.ts";
import type { Snapshot } from "./runtime.ts";

export const HOST_SELECTION_ENTRY = "pi-rex.host-selection";

export interface HostConnectionSettings {
  /** Explicit OpenSSH destination; never derived from the configured alias. */
  readonly sshTarget: string;
  readonly remoteSocketPath: string;
  /** UUID server identities returned by remote `rex whoami --json`. */
  readonly expectedServerHostId: string;
  readonly expectedServerInstanceId: string;
}
export interface HostSettings {
  readonly discovery: HostRegistrySettings;
  readonly connections: ReadonlyMap<string, HostConnectionSettings>;
}

export class HostSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostSelectionError";
  }
}

function failure(message: string): never { throw new HostSelectionError(message); }
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return failure("Invalid " + name);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) failure("Unknown " + name + " field");
}
function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
      || /[\0-\x1f\x7f]/.test(value) || value.trim() !== value)
    return failure("Invalid " + name);
  return value;
}
function configuredHostId(value: unknown): string {
  const id = text(value, "configured Rex host ID", 256);
  if (!/^[a-z0-9][a-z0-9._:-]{0,255}$/i.test(id)) return failure("Invalid configured Rex host ID");
  return id;
}
function serverUuid(value: unknown, name: string): string {
  if (!uuid(value)) return failure("Invalid " + name + "; an exact UUID is required");
  return value;
}
function socketPath(value: unknown): string {
  const path = text(value, "remote Rex socket path", 4096);
  if (!path.startsWith("/") || /[\0-\x1f\x7f:\[\]]/.test(path))
    return failure("Remote Rex socket path must be absolute and cannot contain ':' or brackets");
  return path;
}

/** Strict parser for the standalone pi-rex.hosts value. No connection setting is optional. */
export function parseHostSettings(value?: unknown): HostSettings {
  if (value === undefined) {
    return Object.freeze({
      discovery: parseHostRegistrySettings(),
      connections: new Map<string, HostConnectionSettings>(),
    });
  }
  const root = object(value, "pi-rex.hosts settings");
  exactKeys(root, ["discovery", "connections"], "pi-rex.hosts setting");
  const discovery = parseHostRegistrySettings(root.discovery === undefined
    ? undefined : { discovery: root.discovery });
  const connections = new Map<string, HostConnectionSettings>();
  if (root.connections !== undefined) {
    const configured = object(root.connections, "host connections");
    const rows = Object.entries(configured);
    if (rows.length > 128) return failure("Too many configured host connections");
    for (const [rawAlias, rawSettings] of rows) {
      const alias = normalizeHostAlias(rawAlias);
      if (alias === "local") return failure("The host alias 'local' is reserved");
      if (connections.has(alias)) return failure("Conflicting normalized host connection aliases");
      const row = object(rawSettings, "host connection");
      exactKeys(row, ["sshTarget", "remoteSocketPath", "expectedServerHostId", "expectedServerInstanceId"],
        "host connection");
      // All four fields are mandatory. In particular, there is no trust-on-first-use identity path.
      if (row.sshTarget === undefined || row.remoteSocketPath === undefined
          || row.expectedServerHostId === undefined || row.expectedServerInstanceId === undefined)
        return failure("Host connection requires sshTarget, remoteSocketPath, expectedServerHostId, and expectedServerInstanceId");
      const parsed = Object.freeze({
        sshTarget: text(row.sshTarget, "explicit SSH target", 1024),
        remoteSocketPath: socketPath(row.remoteSocketPath),
        expectedServerHostId: serverUuid(row.expectedServerHostId, "expected server host_id"),
        expectedServerInstanceId: serverUuid(row.expectedServerInstanceId, "expected server instance_id"),
      });
      connections.set(alias, parsed);
    }
  }
  return Object.freeze({ discovery, connections });
}

export type LocalHostSelectionIntent = {
  readonly version: 1;
  readonly piSessionId: string;
  readonly kind: "local";
};
export type RemoteHostSelectionIntent = {
  readonly version: 1;
  readonly piSessionId: string;
  readonly kind: "remote";
  readonly alias: string;
  /** Rex hosts registry identity, distinct from the server UUIDs below. */
  readonly configuredHostId: string;
  readonly expectedServerHostId: string;
  readonly expectedServerInstanceId: string;
};
export type HostSelectionIntent = LocalHostSelectionIntent | RemoteHostSelectionIntent;

export interface HostTicketSnapshot {
  readonly hostId: string;
  readonly hostAlias: string;
  readonly endpoint: string;
  readonly ownership: "external" | "rexpi";
}
interface CommonExecutionHost {
  readonly alias: string;
  readonly state: "verified" | "disconnected";
}
export interface LocalExecutionHost extends CommonExecutionHost {
  readonly kind: "local";
  readonly alias: "local";
  readonly configuration: "local";
  readonly state: "verified";
  readonly serverHostId: string;
  readonly serverInstanceId: string;
}
export interface RemoteExecutionHost extends CommonExecutionHost {
  readonly kind: "remote";
  readonly configuration: "configured";
  readonly configuredHostId: string;
  readonly expectedServerHostId: string;
  readonly expectedServerInstanceId: string;
  readonly reconnectRequired: boolean;
  readonly monitoring?: "process+health" | "health";
  readonly lastVerifiedAt?: string;
  readonly ticket?: HostTicketSnapshot;
}
export type ExecutionHostSnapshot = LocalExecutionHost | RemoteExecutionHost;

function parseIntent(value: unknown, owner: string): HostSelectionIntent {
  const data = object(value, "host-selection intent");
  if (data.version !== 1 || data.piSessionId !== owner)
    return failure("Invalid or unsupported host-selection intent");
  if (data.kind === "local") {
    exactKeys(data, ["version", "piSessionId", "kind"], "local host-selection intent");
    return Object.freeze({ version: 1, piSessionId: owner, kind: "local" });
  }
  if (data.kind !== "remote") return failure("Invalid host-selection kind");
  exactKeys(data, ["version", "piSessionId", "kind", "alias", "configuredHostId",
    "expectedServerHostId", "expectedServerInstanceId"], "remote host-selection intent");
  const alias = normalizeHostAlias(data.alias as string);
  if (alias === "local") return failure("The host alias 'local' is reserved");
  return Object.freeze({
    version: 1,
    piSessionId: owner,
    kind: "remote",
    alias,
    configuredHostId: configuredHostId(data.configuredHostId),
    expectedServerHostId: serverUuid(data.expectedServerHostId, "expected server host_id"),
    expectedServerInstanceId: serverUuid(data.expectedServerInstanceId, "expected server instance_id"),
  });
}

/** Only an intent explicitly scoped to the new owner can be restored. Forks therefore get local state. */
export function restoreHostSelectionIntent(entries: readonly unknown[], owner: string): HostSelectionIntent | undefined {
  for (const raw of [...entries].reverse()) {
    const entry = object(raw, "Pi session entry");
    if (entry.type !== "custom" || entry.customType !== HOST_SELECTION_ENTRY) continue;
    const data = object(entry.data, "host-selection intent");
    if (data.piSessionId !== owner) continue;
    return parseIntent(data, owner);
  }
  return undefined;
}

export interface HostSelectionRuntime {
  snapshot(): Snapshot;
  assert(snapshot: Snapshot): void;
  setHostStatus(status: string): void;
}
export interface HostSelectionRegistry {
  discover(request?: HostDiscoveryRequest, signal?: AbortSignal): Promise<HostRegistrySnapshot>;
  snapshot(): HostRegistrySnapshot;
  resolve(alias: string): ConfiguredRexHost | undefined;
}
export interface HostSelectionTransport {
  connect(request: SshTransportRequest, signal?: AbortSignal): Promise<SshConnectionTicket>;
  withOperation<T>(request: SshTransportRequest,
    operation: (ticket: SshConnectionTicket, signal: AbortSignal) => T | Promise<T>, signal?: AbortSignal): Promise<T>;
  close(binding: Pick<SshTransportRequest, "hostId" | "hostAlias">, signal?: AbortSignal): Promise<void>;
  closeAll(signal?: AbortSignal): Promise<void>;
  probe(ticket: SshConnectionTicket, signal?: AbortSignal): Promise<boolean>;
  onDisconnect(ticket: SshConnectionTicket, listener: () => void): () => void;
}
export interface HostHealthCheckSettings {
  readonly intervalMs: number;
  readonly failureThreshold: number;
}
export const DEFAULT_HOST_HEALTH_CHECK_SETTINGS: Readonly<HostHealthCheckSettings> = Object.freeze({
  intervalMs: 30_000,
  failureThreshold: 3,
});
export interface HostSelectionOptions {
  readonly settings?: unknown;
  readonly entries?: readonly unknown[];
  readonly persist: (intent: HostSelectionIntent) => void;
  /** Test/runtime timing boundary; connection settings remain strict and unchanged. */
  readonly healthCheck?: HostHealthCheckSettings;
}
export interface RemoteOperationHost {
  readonly kind: "remote";
  readonly configuration: "configured";
  readonly alias: string;
  readonly configuredHostId: string;
  readonly expectedServerHostId: string;
  readonly expectedServerInstanceId: string;
}
export interface RemoteHostOperationContext {
  readonly host: RemoteOperationHost;
  readonly ticket: SshConnectionTicket;
  readonly localOrigin: { readonly blockId: string; readonly serverHostId: string; readonly serverInstanceId: string };
  /** Rechecks conversation, selection generation, and cancellation immediately before mutation. */
  readonly check: () => void;
}

function healthCheckSettings(value?: HostHealthCheckSettings): Readonly<HostHealthCheckSettings> {
  if (value === undefined) return DEFAULT_HOST_HEALTH_CHECK_SETTINGS;
  const root = object(value, "host health-check settings");
  exactKeys(root, ["intervalMs", "failureThreshold"], "host health-check setting");
  if (!Number.isInteger(root.intervalMs) || (root.intervalMs as number) < 1 || (root.intervalMs as number) > 300_000)
    return failure("Invalid host health-check interval");
  if (!Number.isInteger(root.failureThreshold) || (root.failureThreshold as number) < 1
      || (root.failureThreshold as number) > 10) return failure("Invalid host health-check failure threshold");
  return Object.freeze({ intervalMs: root.intervalMs as number, failureThreshold: root.failureThreshold as number });
}

function localSelection(snapshot: Snapshot): LocalExecutionHost {
  return Object.freeze({
    kind: "local", alias: "local", configuration: "local", state: "verified",
    serverHostId: snapshot.server.hostId, serverInstanceId: snapshot.server.instanceId,
  });
}
function restoredSelection(intent: RemoteHostSelectionIntent): RemoteExecutionHost {
  return Object.freeze({
    kind: "remote", alias: intent.alias, configuration: "configured", state: "disconnected",
    configuredHostId: intent.configuredHostId,
    expectedServerHostId: intent.expectedServerHostId,
    expectedServerInstanceId: intent.expectedServerInstanceId,
    reconnectRequired: true,
  });
}
function ticketSnapshot(ticket: SshConnectionTicket): HostTicketSnapshot {
  return Object.freeze({
    hostId: ticket.hostId, hostAlias: ticket.hostAlias,
    endpoint: ticket.endpoint, ownership: ticket.ownership,
  });
}
function localSocketPath(endpoint: string): string {
  let path: string;
  if (endpoint.startsWith("/")) path = endpoint;
  else {
    if (!endpoint.startsWith("unix:///") && !endpoint.startsWith("unix:/"))
      return failure("Configured Rex endpoint is not a local Unix socket");
    const encoded = endpoint.startsWith("unix://") ? endpoint.slice("unix://".length) : endpoint.slice("unix:".length);
    try { path = decodeURIComponent(encoded); }
    catch { return failure("Configured Rex endpoint has invalid percent encoding"); }
  }
  if (!path.startsWith("/") || /[\0-\x1f\x7f]/.test(path))
    return failure("Configured Rex endpoint does not contain an absolute local socket path");
  return path;
}
function assertUnambiguousSnapshot(snapshot: HostRegistrySnapshot): void {
  for (const host of [...snapshot.configured, ...snapshot.candidates])
    if (host.alias === "local") return failure("The discovered host alias 'local' is reserved");
}

/** Per-activation conversation state. Construction and restore perform no discovery, probes, or SSH. */
export class HostSelection {
  private readonly runtime: HostSelectionRuntime;
  private readonly registry: HostSelectionRegistry;
  private readonly transport: HostSelectionTransport;
  private readonly settings: HostSettings;
  private readonly healthCheck: Readonly<HostHealthCheckSettings>;
  private readonly persist: (intent: HostSelectionIntent) => void;
  private readonly piSessionId: string;
  private readonly lifecycle = new AbortController();
  private generation = 0;
  private selected: ExecutionHostSnapshot;
  private stopped = false;
  private removeDisconnectListener?: () => void;
  private healthMonitor?: AbortController;
  private lastVerifiedAt?: string;
  private verifiedSnapshot?: RemoteExecutionHost;
  private cleanupPromise?: Promise<void>;

  constructor(runtime: HostSelectionRuntime, registry: HostSelectionRegistry,
      transport: HostSelectionTransport, options: HostSelectionOptions) {
    if (typeof options.persist !== "function") throw new HostSelectionError("Host-selection persistence is required");
    this.runtime = runtime;
    this.registry = registry;
    this.transport = transport;
    this.settings = parseHostSettings(options.settings);
    this.healthCheck = healthCheckSettings(options.healthCheck);
    this.persist = options.persist;
    const own = runtime.snapshot();
    this.piSessionId = own.state.piSessionId;
    const restored = restoreHostSelectionIntent(options.entries ?? [], own.state.piSessionId);
    this.selected = restored?.kind === "remote" ? restoredSelection(restored) : localSelection(own);
    this.publishStatus();
  }

  /** Immutable execution-host and (when verified) transport-ticket evidence for the next step. */
  snapshot(): ExecutionHostSnapshot {
    this.lifecycle.signal.throwIfAborted();
    if (this.stopped) return failure("Host selection is no longer active");
    this.runtime.snapshot();
    return this.selected.kind === "remote" && this.selected.state === "verified"
      ? this.verifiedSnapshot ?? this.selected
      : this.selected;
  }

  /** A one-off configured-host lookup; it neither discovers nor changes selection. */
  lookup(alias: string): ConfiguredRexHost | undefined {
    this.lifecycle.signal.throwIfAborted();
    if (this.stopped) return failure("Host selection is no longer active");
    this.runtime.snapshot();
    const normalized = normalizeHostAlias(alias);
    if (normalized === "local") return undefined;
    return this.registry.resolve(normalized);
  }

  /**
   * Runs one remote Rex operation without changing the conversation selection. An omitted alias
   * requires the currently verified remote selection; an explicit alias uses discovered configuration only.
   */
  async withRemoteOperation<T>(alias: string | undefined,
      operation: (context: RemoteHostOperationContext, signal: AbortSignal) => T | Promise<T>,
      signal?: AbortSignal): Promise<T> {
    const own = this.runtime.snapshot();
    const generation = this.generation;
    const selected = this.selected;
    const normalized = alias === undefined ? undefined : normalizeHostAlias(alias);
    if (normalized === "local") return failure("A remote Rex operation cannot use the local host");
    if (alias === undefined && (selected.kind !== "remote" || selected.state !== "verified"
        || selected.reconnectRequired || !selected.ticket))
      return failure("The selected remote Rex host is disconnected or requires reconnection");
    const wanted = normalized ?? selected.alias;
    const matches = this.registry.snapshot().configured.filter(host => host.alias === wanted);
    if (matches.length === 0) return failure("Unknown configured Rex host; discover or connect it explicitly first");
    if (matches.length !== 1) return failure("Configured Rex host alias is ambiguous");
    const configured = matches[0];
    if (alias === undefined && (selected.kind !== "remote" || configured.id !== selected.configuredHostId
        || configured.alias !== selected.alias))
      return failure("The selected remote Rex host is stale");
    const endpoints = configured.endpoints.filter(endpoint =>
      endpoint.startsWith("/") || endpoint.startsWith("unix:///") || endpoint.startsWith("unix:/"));
    if (endpoints.length !== 1)
      return failure("Configured Rex host selection requires exactly one local Unix endpoint");
    const connection = this.settings.connections.get(configured.alias);
    if (!connection) return failure("No explicit pi-rex.hosts.connections entry exists for " + configured.alias);
    if (alias === undefined && (selected.kind !== "remote"
        || connection.expectedServerHostId !== selected.expectedServerHostId
        || connection.expectedServerInstanceId !== selected.expectedServerInstanceId))
      return failure("The selected remote Rex host configuration is stale");
    const request: SshTransportRequest = Object.freeze({
      hostId: configured.id, hostAlias: configured.alias,
      sshTarget: connection.sshTarget, localSocketPath: localSocketPath(endpoints[0]),
      remoteSocketPath: connection.remoteSocketPath,
    });
    if (alias === undefined && (selected.kind !== "remote" || !selected.ticket
        || selected.ticket.hostId !== request.hostId || selected.ticket.hostAlias !== request.hostAlias
        || selected.ticket.endpoint !== request.localSocketPath))
      return failure("The selected remote Rex transport is stale");
    const host: RemoteOperationHost = Object.freeze({
      kind: "remote", configuration: "configured", alias: configured.alias, configuredHostId: configured.id,
      expectedServerHostId: connection.expectedServerHostId,
      expectedServerInstanceId: connection.expectedServerInstanceId,
    });
    const combined = this.combined(own, signal);
    const checkCurrent = (currentSignal: AbortSignal): void => {
      this.check(own, generation, currentSignal);
      // Owned disconnects revoke selection without incrementing the explicit-connect generation.
      if (alias === undefined && this.selected !== selected)
        return failure("The selected remote Rex host changed or disconnected");
    };
    checkCurrent(combined);
    return this.transport.withOperation(request, (ticket, operationSignal) => {
      const currentSignal = AbortSignal.any([combined, operationSignal]);
      checkCurrent(currentSignal);
      if (ticket.hostId !== request.hostId || ticket.hostAlias !== request.hostAlias
          || ticket.endpoint !== request.localSocketPath)
        return failure("SSH transport returned a ticket for a different configured host or endpoint");
      return operation(Object.freeze({
        host, ticket,
        localOrigin: Object.freeze({ blockId: own.blockId, serverHostId: own.server.hostId,
          serverInstanceId: own.server.instanceId }),
        check: () => checkCurrent(currentSignal),
      }), currentSignal);
    }, combined);
  }

  private combined(own: Snapshot, signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, own.signal, this.lifecycle.signal])
      : AbortSignal.any([own.signal, this.lifecycle.signal]);
  }
  private check(own: Snapshot, generation: number, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    this.lifecycle.signal.throwIfAborted();
    this.runtime.assert(own);
    if (this.stopped || generation !== this.generation)
      return failure("Host selection changed; the connection was not continued");
  }
  private stopWatching(): void {
    this.removeDisconnectListener?.();
    this.removeDisconnectListener = undefined;
    this.healthMonitor?.abort();
    this.healthMonitor = undefined;
  }
  private revokeRemote(snapshot: HostTicketSnapshot, generation: number): void {
    const current = this.selected;
    if (this.stopped || generation !== this.generation || current.kind !== "remote" || current.ticket !== snapshot) return;
    this.selected = restoredSelection({
      version: 1, piSessionId: this.piSessionId,
      kind: "remote", alias: current.alias, configuredHostId: current.configuredHostId,
      expectedServerHostId: current.expectedServerHostId, expectedServerInstanceId: current.expectedServerInstanceId,
    });
    this.lastVerifiedAt = undefined;
    this.verifiedSnapshot = undefined;
    this.stopWatching();
    this.publishStatus();
  }
  private watch(ticket: SshConnectionTicket, snapshot: HostTicketSnapshot, generation: number): void {
    this.stopWatching();
    const monitor = new AbortController();
    this.healthMonitor = monitor;
    if (ticket.ownership === "rexpi")
      this.removeDisconnectListener = this.transport.onDisconnect(ticket, () => this.revokeRemote(snapshot, generation));
    void this.monitorHealth(ticket, snapshot, generation, monitor.signal);
  }
  private async monitorHealth(ticket: SshConnectionTicket, snapshot: HostTicketSnapshot,
      generation: number, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      if (!await this.waitForHealthCheck(signal)) return;
      let healthy = false;
      try { healthy = await this.transport.probe(ticket, signal); }
      catch { /* Cancellation and operational failure both finish below; stale generations are fenced. */ }
      if (signal.aborted || this.stopped || generation !== this.generation) return;
      const current = this.selected;
      if (current.kind !== "remote" || current.ticket !== snapshot) return;
      if (healthy) {
        failures = 0;
        this.lastVerifiedAt = new Date().toISOString();
        this.verifiedSnapshot = Object.freeze({ ...current, lastVerifiedAt: this.lastVerifiedAt });
        continue;
      }
      failures++;
      if (failures >= this.healthCheck.failureThreshold) {
        this.revokeRemote(snapshot, generation);
        return;
      }
    }
  }
  private waitForHealthCheck(signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(done, this.healthCheck.intervalMs);
      timer.unref();
      const onAbort = (): void => { clearTimeout(timer); resolve(false); };
      function done(): void { signal.removeEventListener("abort", onAbort); resolve(true); }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  private async discardUnlessSelected(ticket: SshConnectionTicket): Promise<void> {
    const current = this.selected;
    if (current.kind === "remote" && current.state === "verified" && current.ticket
        && current.ticket.hostId === ticket.hostId && current.ticket.hostAlias === ticket.hostAlias
        && current.ticket.endpoint === ticket.endpoint) return;
    try { await this.transport.close(ticket); } catch { /* Never turn a stale result into authority or local fallback. */ }
  }
  private async retirePrevious(previous: ExecutionHostSnapshot, selected: ExecutionHostSnapshot): Promise<void> {
    if (previous.kind !== "remote" || previous.state !== "verified" || !previous.ticket) return;
    if (selected.kind === "remote" && selected.ticket
        && selected.ticket.hostId === previous.ticket.hostId && selected.ticket.endpoint === previous.ticket.endpoint) return;
    try { await this.transport.close(previous.ticket); } catch { /* New selection remains explicit; cleanup is best-effort. */ }
  }
  private publishStatus(): void {
    const selected = this.selected;
    this.runtime.setHostStatus(selected.kind === "local" ? "local"
      : selected.alias + (selected.state === "disconnected" ? " disconnected/reconnect-required" : " verified"));
  }

  /** Read-only, on-demand discovery. The default omits every candidate source. */
  async discover(request: HostDiscoveryRequest = { tailscale: false }, signal?: AbortSignal): Promise<HostRegistrySnapshot> {
    const own = this.runtime.snapshot();
    const combined = this.combined(own, signal);
    const discovered = await this.registry.discover({ ...request, tailscale: request.tailscale === true }, combined);
    combined.throwIfAborted();
    this.runtime.assert(own);
    assertUnambiguousSnapshot(discovered);
    return discovered;
  }

  private async selectLocal(own: Snapshot, generation: number, signal?: AbortSignal): Promise<LocalExecutionHost> {
    this.check(own, generation, signal);
    const previous = this.selected;
    const selected = localSelection(own);
    this.lastVerifiedAt = undefined;
    this.verifiedSnapshot = undefined;
    // No process, socket, health check, or local-Rex fallback is needed: Runtime already verified it.
    this.persist(Object.freeze({ version: 1, piSessionId: own.state.piSessionId, kind: "local" }));
    this.stopWatching();
    this.selected = selected;
    this.publishStatus();
    await this.retirePrevious(previous, selected);
    return selected;
  }

  /** Explicit local selection or a fresh, exact configured-alias discovery and verified remote connection. */
  async connect(alias: string, signal?: AbortSignal): Promise<ExecutionHostSnapshot> {
    const normalized = normalizeHostAlias(alias);
    const own = this.runtime.snapshot();
    const generation = ++this.generation;
    const combined = this.combined(own, signal);
    if (normalized === "local") return this.selectLocal(own, generation, combined);

    const discovered = await this.registry.discover({ tailscale: false }, combined);
    this.check(own, generation, combined);
    assertUnambiguousSnapshot(discovered);
    const matches = discovered.configured.filter(host => host.alias === normalized);
    if (matches.length === 0)
      return failure("Unknown configured Rex host; candidates and implicit local hosts cannot be selected");
    if (matches.length !== 1) return failure("Configured Rex host alias is ambiguous");
    const configured = matches[0];
    const endpoints = configured.endpoints.filter(endpoint =>
      endpoint.startsWith("/") || endpoint.startsWith("unix:///") || endpoint.startsWith("unix:/"));
    if (endpoints.length !== 1)
      return failure("Configured Rex host selection requires exactly one local Unix endpoint");
    const connection = this.settings.connections.get(normalized);
    if (!connection)
      return failure("No explicit pi-rex.hosts.connections entry exists for " + normalized);
    const request: SshTransportRequest = Object.freeze({
      hostId: configured.id,
      hostAlias: configured.alias,
      sshTarget: connection.sshTarget,
      localSocketPath: localSocketPath(endpoints[0]),
      remoteSocketPath: connection.remoteSocketPath,
    });
    const ticket = await this.transport.connect(request, combined);
    try {
      this.check(own, generation, combined);
      if (ticket.hostId !== configured.id || ticket.hostAlias !== configured.alias
          || ticket.endpoint !== request.localSocketPath)
        return failure("SSH transport returned a ticket for a different configured host or endpoint");
    } catch (error) {
      await this.discardUnlessSelected(ticket);
      throw error;
    }
    const previous = this.selected;
    const intent: RemoteHostSelectionIntent = Object.freeze({
      version: 1,
      piSessionId: own.state.piSessionId,
      kind: "remote",
      alias: configured.alias,
      configuredHostId: configured.id,
      expectedServerHostId: connection.expectedServerHostId,
      expectedServerInstanceId: connection.expectedServerInstanceId,
    });
    // A successful transport connect means its bounded whoami probe verified both exact expected UUIDs.
    const selected: RemoteExecutionHost = Object.freeze({
      kind: "remote", alias: configured.alias, configuration: "configured", state: "verified",
      configuredHostId: configured.id,
      expectedServerHostId: connection.expectedServerHostId,
      expectedServerInstanceId: connection.expectedServerInstanceId,
      reconnectRequired: false,
      monitoring: ticket.ownership === "rexpi" ? "process+health" : "health",
      ticket: ticketSnapshot(ticket),
    });
    // The freshness check above immediately precedes persistence and this same-turn publication.
    this.persist(intent);
    this.selected = selected;
    this.lastVerifiedAt = new Date().toISOString();
    this.verifiedSnapshot = Object.freeze({ ...selected, lastVerifiedAt: this.lastVerifiedAt });
    this.publishStatus();
    this.watch(ticket, selected.ticket!, generation);
    await this.retirePrevious(previous, selected);
    return this.snapshot();
  }

  /** Idempotent bounded cleanup; lifecycle owners must await it before process exit or replacement. */
  stop(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.stopped = true;
    this.generation++;
    this.stopWatching();
    this.lifecycle.abort();
    this.cleanupPromise = this.transport.closeAll();
    return this.cleanupPromise;
  }
}
