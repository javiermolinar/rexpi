import { isIP } from "node:net";

/** Literal-argv execution only. Implementations must not invoke a shell. */
export interface HostExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
  truncated?: boolean;
}
export type HostExec = (command: string, args: string[], options: {
  signal: AbortSignal;
  timeout: number;
  maxBuffer: number;
}) => Promise<HostExecResult>;
export type ReadHostText = (path: string, options: { signal: AbortSignal; maxBytes: number }) => Promise<string>;

export interface HostDiscoveryLimits {
  maxEntries: number;
  maxOutputBytes: number;
  timeoutMs: number;
}
export interface HostRegistrySettings { discovery: HostDiscoveryLimits }
export const DEFAULT_HOST_REGISTRY_SETTINGS: Readonly<HostRegistrySettings> = Object.freeze({
  discovery: Object.freeze({ maxEntries: 128, maxOutputBytes: 1024 * 1024, timeoutMs: 5000 }),
});

interface CommonHostState {
  /** Discovery never establishes readiness, installation, or Rex reachability. */
  readonly ready: false;
  readonly readiness: "unverified";
  readonly rexInstalled: "unknown";
  readonly rexReachable: "unknown";
}
export interface ConfiguredRexHost extends CommonHostState {
  readonly state: "configured";
  readonly source: "rex hosts";
  readonly rexConfigured: true;
  readonly id: string;
  readonly label: string;
  readonly alias: string;
  /** Canonical decoded absolute local Unix-socket paths. */
  readonly endpoints: readonly string[];
  /** Unsupported non-Unix endpoints are counted, never retained or probed. */
  readonly unsupportedEndpoints: number;
}
export interface SshHostCandidate extends CommonHostState {
  readonly state: "candidate";
  readonly source: "openssh";
  readonly rexConfigured: false;
  readonly alias: string;
}
export interface TailscaleHostCandidate extends CommonHostState {
  readonly state: "candidate";
  readonly source: "tailscale";
  readonly rexConfigured: false;
  readonly alias: string;
  readonly connectivity: {
    readonly dnsName: string;
    readonly addresses: readonly string[];
    readonly online?: boolean;
  };
}
export type HostCandidate = SshHostCandidate | TailscaleHostCandidate;
export interface HostRegistrySnapshot {
  readonly configured: readonly ConfiguredRexHost[];
  readonly candidates: readonly HostCandidate[];
}
export type OpenSshDiscovery = { configText: string } | { configPath: string };
export interface HostDiscoveryRequest {
  /** OpenSSH is read only when this property is explicitly supplied. */
  openSsh?: OpenSshDiscovery;
  /** Defaults to true; Rex configuration is always queried by discover(). */
  tailscale?: boolean;
}
export interface HostRegistryOptions {
  settings?: unknown;
  rexBinary?: string;
  tailscaleBinary?: string;
  readText?: ReadHostText;
}

export class HostRegistryError extends Error {
  constructor(message: string) { super(message); this.name = "HostRegistryError"; }
}

function failure(message: string): never { throw new HostRegistryError(message); }
function object(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return failure("Malformed " + source + " host discovery data");
  return value as Record<string, unknown>;
}
function list(value: unknown, source: string): unknown[] {
  if (!Array.isArray(value)) return failure("Malformed " + source + " host collection");
  return value;
}
function json(text: string, source: string): unknown {
  try { return JSON.parse(text); }
  catch { return failure("Invalid " + source + " JSON"); }
}
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** NFKC, case-folding, and separator folding; no fuzzy or partial matching. */
export function normalizeHostAlias(value: string): string {
  if (typeof value !== "string" || value.length > 1024) return failure("Invalid host alias");
  const alias = value.normalize("NFKC").trim().toLowerCase()
    .replace(/[\s_]+/g, "-").replace(/-+/g, "-");
  if (alias.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(alias) || alias.includes(".."))
    return failure("Invalid host alias");
  return alias;
}

function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum)
    return failure("Invalid host discovery setting: " + name);
  return value as number;
}
/** Validates the standalone pi-rex.hosts settings value; unknown keys are rejected. */
export function parseHostRegistrySettings(value?: unknown): HostRegistrySettings {
  if (value === undefined) return DEFAULT_HOST_REGISTRY_SETTINGS;
  const root = object(value, "settings");
  if (Object.keys(root).some(key => key !== "discovery")) return failure("Unknown host registry setting");
  const discovery = root.discovery === undefined ? {} : object(root.discovery, "settings");
  const allowed = new Set(["maxEntries", "maxOutputBytes", "timeoutMs"]);
  if (Object.keys(discovery).some(key => !allowed.has(key))) return failure("Unknown host discovery setting");
  const defaults = DEFAULT_HOST_REGISTRY_SETTINGS.discovery;
  return { discovery: {
    maxEntries: integer(discovery.maxEntries, "maxEntries", defaults.maxEntries, 1, 256),
    maxOutputBytes: integer(discovery.maxOutputBytes, "maxOutputBytes", defaults.maxOutputBytes, 128, 4 * 1024 * 1024),
    timeoutMs: integer(discovery.timeoutMs, "timeoutMs", defaults.timeoutMs, 1, 30_000),
  } };
}

/** Returns a canonical local path, or undefined for a valid but unsupported non-Unix endpoint. */
function endpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\0-\x1f\x7f]/.test(value))
    return failure("Malformed configured Rex endpoint");
  if (value.includes("?") || value.includes("#")) return failure("Malformed configured Rex endpoint");
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith("unix:")) return undefined;
  let path: string;
  if (value.startsWith("/")) path = value;
  else {
    if (!value.startsWith("unix:///") && !value.startsWith("unix:/"))
      return failure("Configured Rex endpoint is not a local Unix socket or supported remote URI");
    const encoded = value.startsWith("unix://") ? value.slice("unix://".length) : value.slice("unix:".length);
    try { path = decodeURIComponent(encoded); }
    catch { return failure("Configured Rex endpoint has invalid percent encoding"); }
  }
  if (!path.startsWith("/") || /[\0-\x1f\x7f]/.test(path)) return failure("Malformed configured Rex endpoint path");
  return path;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,255}$/i.test(value))
    return failure("Malformed configured Rex host identity");
  return value;
}

function parseConfigured(text: string, takeEntries: (count: number) => void): ConfiguredRexHost[] {
  const root = object(json(text, "rex hosts"), "rex hosts");
  object(root.home, "rex hosts home"); // Presence is structural evidence only; home metadata is not retained.
  const rows = list(root.hosts, "rex hosts");
  takeEntries(rows.length);
  const byAlias = new Map<string, ConfiguredRexHost>();
  const byId = new Map<string, ConfiguredRexHost>();
  const byEndpoint = new Map<string, string>();
  for (const raw of rows) {
    const row = object(raw, "rex hosts entry");
    if (!("from" in row) || !("held" in row)) return failure("Malformed rex hosts entry metadata");
    const host = object(row.host, "rex host");
    const id = identity(host.id);
    if (typeof host.label !== "string") return failure("Malformed configured Rex host label");
    const alias = normalizeHostAlias(host.label);
    const rawEndpoints = list(host.endpoints, "configured Rex endpoint");
    if (rawEndpoints.length === 0) return failure("Configured Rex host has no endpoint");
    takeEntries(rawEndpoints.length);
    const parsedEndpoints = rawEndpoints.map(endpoint);
    const endpoints = [...new Set(parsedEndpoints.filter((value): value is string => value !== undefined))].sort();
    const unsupportedEndpoints = parsedEndpoints.filter(value => value === undefined).length;
    const aliasHost = byAlias.get(alias), idHost = byId.get(id);
    if ((aliasHost && aliasHost.id !== id) || (idHost && idHost.alias !== alias))
      return failure("Conflicting configured Rex host alias or identity");
    const prior = aliasHost ?? idHost;
    if (prior) {
      if (!sameStrings(prior.endpoints, endpoints) || prior.unsupportedEndpoints !== unsupportedEndpoints)
        return failure("Conflicting configured Rex host endpoints");
      continue;
    }
    for (const value of endpoints) {
      const owner = byEndpoint.get(value);
      if (owner !== undefined && owner !== id) return failure("Conflicting configured Rex endpoint ownership");
    }
    const configured: ConfiguredRexHost = {
      state: "configured", source: "rex hosts", rexConfigured: true,
      ready: false, readiness: "unverified", rexInstalled: "unknown", rexReachable: "unknown",
      id, label: host.label.trim(), alias, endpoints, unsupportedEndpoints,
    };
    byAlias.set(alias, configured); byId.set(id, configured);
    for (const value of endpoints) byEndpoint.set(value, id);
  }
  return [...byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}

/** Tokenizes data, not a shell command. Comments and quoted OpenSSH values are supported. */
function sshTokens(line: string): string[] {
  const tokens: string[] = [];
  let token = "", started = false, escaped = false, quote = "";
  for (const char of line) {
    if (escaped) { token += char; started = true; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
      started = true;
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) { tokens.push(token); token = ""; started = false; }
      continue;
    }
    if (char === "#" && !started) break;
    token += char; started = true;
  }
  if (escaped || quote) return failure("Malformed OpenSSH quoting");
  if (started) tokens.push(token);
  return tokens;
}
function sshTarget(value: string): string {
  const target = value.toLowerCase();
  if (target.length > 253 || target.includes("@") || target.includes("/") || target.includes("%"))
    return failure("Unsupported OpenSSH HostName");
  if (isIP(target)) return target;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(target) || target.includes(".."))
    return failure("Invalid OpenSSH HostName");
  return target;
}
function parseOpenSsh(text: string, takeEntries: (count: number) => void): SshHostCandidate[] {
  if (text.includes("\0")) return failure("Malformed OpenSSH configuration");
  const targets = new Map<string, string | undefined>();
  let aliases: string[] = [], hostName: string | undefined, hostNameSeen = false;
  const commit = (): void => {
    for (const alias of aliases) if (!targets.has(alias)) targets.set(alias, hostName);
  };
  for (const line of text.split(/\r?\n/)) {
    let tokens = sshTokens(line);
    if (tokens.length === 0) continue;
    const equals = tokens[0].indexOf("=");
    if (equals > 0) tokens = [tokens[0].slice(0, equals), tokens[0].slice(equals + 1), ...tokens.slice(1)].filter(Boolean);
    if (tokens[1] === "=") tokens = [tokens[0], ...tokens.slice(2)];
    else if (tokens[1]?.startsWith("=")) tokens = [tokens[0], tokens[1].slice(1), ...tokens.slice(2)].filter(Boolean);
    const keyword = tokens[0].toLowerCase();
    if (keyword === "host") {
      if (tokens.length < 2) return failure("Malformed OpenSSH Host entry");
      commit();
      aliases = []; hostName = undefined; hostNameSeen = false;
      for (const raw of tokens.slice(1)) {
        if (/[*?!\[\]]/.test(raw)) continue; // Patterns are not explicitly named candidates.
        const alias = normalizeHostAlias(raw);
        aliases.push(alias); takeEntries(1);
      }
      continue;
    }
    if (keyword === "match") { commit(); aliases = []; hostName = undefined; hostNameSeen = false; continue; }
    // All other directives, especially identity/agent/command/proxy directives, are ignored.
    // Their values are never copied into candidates or diagnostics.
    if (keyword !== "hostname" || aliases.length === 0 || hostNameSeen) continue;
    if (tokens.length !== 2) return failure("Malformed OpenSSH HostName entry");
    hostNameSeen = true; hostName = sshTarget(tokens[1]);
    for (const alias of aliases) {
      const prior = targets.get(alias);
      if (targets.has(alias) && prior !== undefined && prior !== hostName)
        return failure("Conflicting OpenSSH candidate identity");
      targets.set(alias, prior ?? hostName);
    }
  }
  // Host stanzas without HostName are still explicit, alias-only candidates.
  commit();
  return [...targets.keys()].sort().map(alias => ({
    state: "candidate", source: "openssh", rexConfigured: false,
    ready: false, readiness: "unverified", rexInstalled: "unknown", rexReachable: "unknown", alias,
  }));
}

function dnsName(value: unknown): string {
  if (typeof value !== "string" || value.length > 254) return failure("Malformed Tailscale DNS name");
  const name = value.toLowerCase().replace(/\.$/, "");
  if (!name || name.length > 253 || name.includes("..") ||
      !name.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))
    return failure("Malformed Tailscale DNS name");
  return name;
}
interface ParsedTailscale { candidate: TailscaleHostCandidate; identity: string; signature: string }
function parseTailscale(text: string, takeEntries: (count: number) => void): TailscaleHostCandidate[] {
  const root = object(json(text, "Tailscale status"), "Tailscale status");
  const rows: Record<string, unknown>[] = [];
  if (root.Self !== undefined) rows.push(object(root.Self, "Tailscale self"));
  if (root.Peer !== undefined) {
    const peers = object(root.Peer, "Tailscale peers");
    for (const value of Object.values(peers)) rows.push(object(value, "Tailscale peer"));
  }
  takeEntries(rows.length);
  const parsed: ParsedTailscale[] = [];
  const byAlias = new Map<string, ParsedTailscale>(), byIdentity = new Map<string, ParsedTailscale>();
  for (const row of rows) {
    if (row.DNSName === undefined && row.HostName === undefined) return failure("Tailscale candidate has no name");
    const name = dnsName(typeof row.DNSName === "string" && row.DNSName.length > 0 ? row.DNSName : row.HostName);
    const alias = normalizeHostAlias(name.split(".")[0]);
    const rawAddresses = row.TailscaleIPs == null ? [] : list(row.TailscaleIPs, "Tailscale addresses");
    const addresses = [...new Set(rawAddresses.map(value => {
      if (typeof value !== "string" || !isIP(value)) return failure("Malformed Tailscale address");
      return value;
    }))].sort();
    if (row.Online !== undefined && typeof row.Online !== "boolean") return failure("Malformed Tailscale online state");
    let id: string;
    if (row.ID === undefined) id = "name:" + name;
    else if (typeof row.ID === "string" && row.ID.length > 0 && row.ID.length <= 256 && !/[\0-\x1f\x7f]/.test(row.ID)) id = "string:" + row.ID;
    else if (typeof row.ID === "number" && Number.isSafeInteger(row.ID)) id = "number:" + row.ID;
    else return failure("Malformed Tailscale identity");
    const connectivity: TailscaleHostCandidate["connectivity"] = {
      dnsName: name, addresses, ...(row.Online === undefined ? {} : { online: row.Online as boolean }),
    };
    const candidate: TailscaleHostCandidate = {
      state: "candidate", source: "tailscale", rexConfigured: false,
      ready: false, readiness: "unverified", rexInstalled: "unknown", rexReachable: "unknown", alias, connectivity,
    };
    const current = { candidate, identity: id, signature: JSON.stringify(connectivity) };
    const aliasPrior = byAlias.get(alias), identityPrior = byIdentity.get(id);
    if ((aliasPrior && aliasPrior.identity !== id) || (identityPrior && identityPrior.candidate.alias !== alias))
      return failure("Conflicting Tailscale candidate alias or identity");
    const prior = aliasPrior ?? identityPrior;
    if (prior) {
      if (prior.signature !== current.signature) return failure("Conflicting Tailscale candidate connectivity");
      continue;
    }
    byAlias.set(alias, current); byIdentity.set(id, current); parsed.push(current);
  }
  return parsed.map(value => value.candidate);
}

const EMPTY_SNAPSHOT: HostRegistrySnapshot = Object.freeze({ configured: Object.freeze([]), candidates: Object.freeze([]) });
function freezeSnapshot(configured: ConfiguredRexHost[], candidates: HostCandidate[]): HostRegistrySnapshot {
  const frozenConfigured = configured.map(host => Object.freeze({ ...host, endpoints: Object.freeze([...host.endpoints]) }));
  const frozenCandidates = candidates.map(candidate => {
    if (candidate.source === "openssh") return Object.freeze({ ...candidate });
    const connectivity = Object.freeze({ ...candidate.connectivity, addresses: Object.freeze([...candidate.connectivity.addresses]) });
    return Object.freeze({ ...candidate, connectivity });
  });
  return Object.freeze({ configured: Object.freeze(frozenConfigured), candidates: Object.freeze(frozenCandidates) });
}

/** No I/O occurs at import or construction. discover() is the sole operation that reads sources. */
export class HostRegistry {
  readonly settings: HostRegistrySettings;
  private readonly exec: HostExec;
  private readonly readText?: ReadHostText;
  private readonly rexBinary: string;
  private readonly tailscaleBinary: string;
  private current: HostRegistrySnapshot = EMPTY_SNAPSHOT;
  private queue: Promise<void> = Promise.resolve();

  constructor(exec: HostExec, options: HostRegistryOptions = {}) {
    if (typeof exec !== "function") throw new HostRegistryError("A host discovery executor is required");
    this.exec = exec;
    this.readText = options.readText;
    this.rexBinary = options.rexBinary ?? "rex";
    this.tailscaleBinary = options.tailscaleBinary ?? "tailscale";
    this.settings = parseHostRegistrySettings(options.settings);
  }

  snapshot(): HostRegistrySnapshot { return this.current; }
  /** Resolves configured Rex hosts only. Unknown/candidate aliases never select a local or default host. */
  resolve(alias: string): ConfiguredRexHost | undefined {
    const normalized = normalizeHostAlias(alias);
    return this.current.configured.find(host => host.alias === normalized);
  }

  /** Serializes independent discoveries instead of failing overlapping read-only calls. */
  discover(request: HostDiscoveryRequest = {}, externalSignal?: AbortSignal): Promise<HostRegistrySnapshot> {
    const run = this.queue.then(() => this.performDiscovery(request, externalSignal));
    this.queue = run.then(() => undefined, () => undefined);
    if (!externalSignal) return run;
    if (externalSignal.aborted) return Promise.reject(new HostRegistryError("Host discovery was cancelled"));
    let listener: (() => void) | undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      listener = () => reject(new HostRegistryError("Host discovery was cancelled"));
      externalSignal.addEventListener("abort", listener, { once: true });
    });
    return Promise.race([run, interruption]).finally(() => {
      if (listener) externalSignal.removeEventListener("abort", listener);
    });
  }

  private async performDiscovery(request: HostDiscoveryRequest = {}, externalSignal?: AbortSignal): Promise<HostRegistrySnapshot> {
    if (request.tailscale !== undefined && typeof request.tailscale !== "boolean")
      throw new HostRegistryError("Invalid host discovery request");
    this.current = EMPTY_SNAPSHOT;
    const controller = new AbortController();
    const started = Date.now(), timeoutMs = this.settings.discovery.timeoutMs;
    let timedOut = false, usedOutput = 0, usedEntries = 0, timer: NodeJS.Timeout | undefined;
    const aborted = () => new HostRegistryError(timedOut ? "Host discovery timed out" : "Host discovery was cancelled");
    const onExternalAbort = () => controller.abort();
    const remaining = (): number => {
      const value = timeoutMs - (Date.now() - started);
      if (value <= 0) { timedOut = true; controller.abort(); throw aborted(); }
      return value;
    };
    const takeEntries = (count: number): void => {
      usedEntries += count;
      if (usedEntries > this.settings.discovery.maxEntries) failure("Host discovery exceeded its entry limit");
    };
    const takeOutput = (text: string): void => {
      usedOutput += Buffer.byteLength(text, "utf8");
      if (usedOutput > this.settings.discovery.maxOutputBytes) failure("Host discovery exceeded its output limit");
    };
    const raceAbort = async <T>(promise: Promise<T>): Promise<T> => {
      if (controller.signal.aborted) throw aborted();
      let listener: (() => void) | undefined;
      const interruption = new Promise<never>((_resolve, reject) => {
        listener = () => reject(aborted());
        controller.signal.addEventListener("abort", listener, { once: true });
      });
      try { return await Promise.race([promise, interruption]); }
      finally { if (listener) controller.signal.removeEventListener("abort", listener); }
    };
    const run = async (source: string, binary: string, args: string[]): Promise<string> => {
      try {
        const result = await raceAbort(this.exec(binary, args, {
          signal: controller.signal, timeout: remaining(), maxBuffer: Math.max(1, this.settings.discovery.maxOutputBytes - usedOutput),
        }));
        takeOutput(result.stdout); takeOutput(result.stderr);
        if (!Number.isInteger(result.code)) failure("Malformed " + source + " discovery result");
        if (result.truncated) failure(source + " discovery exceeded its output limit");
        if (result.killed) failure(source + " discovery was interrupted");
        if (result.code !== 0) failure(source + " discovery failed (exit " + result.code + ")");
        return result.stdout;
      } catch (error) {
        if (error instanceof HostRegistryError) throw error;
        if (controller.signal.aborted || externalSignal?.aborted) throw aborted();
        throw new HostRegistryError(source + " discovery failed");
      }
    };

    try {
      if (externalSignal?.aborted) throw aborted();
      externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const rexTimeout = Math.max(1, Math.ceil(this.settings.discovery.timeoutMs / 1000)) + "s";
      const configured = parseConfigured(await run("Rex", this.rexBinary,
        ["--autostart=false", "--timeout", rexTimeout, "hosts", "--json"]), takeEntries);
      const aliases = new Set(configured.map(host => host.alias));
      const candidates: HostCandidate[] = [];
      const addCandidates = (values: HostCandidate[]): void => {
        for (const candidate of values) {
          if (aliases.has(candidate.alias)) failure("Conflicting host alias across discovery sources");
          aliases.add(candidate.alias); candidates.push(candidate);
        }
      };
      if (request.openSsh !== undefined) {
        const openSsh = request.openSsh;
        let text: string;
        if ("configText" in openSsh) {
          if (typeof openSsh.configText !== "string") failure("Invalid OpenSSH discovery input");
          text = openSsh.configText;
        } else {
          const readText = this.readText;
          if (typeof openSsh.configPath !== "string" || !readText) failure("OpenSSH discovery requires a text reader");
          try {
            text = await raceAbort(readText(openSsh.configPath, {
              signal: controller.signal, maxBytes: Math.max(1, this.settings.discovery.maxOutputBytes - usedOutput),
            }));
          }
          catch (error) {
            if (error instanceof HostRegistryError) throw error;
            if (controller.signal.aborted || externalSignal?.aborted) throw aborted();
            throw new HostRegistryError("OpenSSH configuration read failed");
          }
        }
        takeOutput(text);
        addCandidates(parseOpenSsh(text, takeEntries));
      }
      if (request.tailscale !== false)
        addCandidates(parseTailscale(await run("Tailscale", this.tailscaleBinary, ["status", "--json"]), takeEntries));
      candidates.sort((a, b) => a.alias.localeCompare(b.alias) || a.source.localeCompare(b.source));
      this.current = freezeSnapshot(configured, candidates);
      return this.current;
    } catch (error) {
      this.current = EMPTY_SNAPSHOT;
      if (error instanceof HostRegistryError) throw error;
      if (controller.signal.aborted || externalSignal?.aborted) throw aborted();
      throw new HostRegistryError("Host discovery failed");
    } finally {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
