import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server as SocketServer, type Socket } from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { identity as parseIdentity, isLive, record, sameIdentity, uuid, type Identity } from "./state.ts";
import type { Runtime, Snapshot } from "./runtime.ts";
import { assertSameAgentRun, parseAgentHandle, type AgentHandle } from "./agent.ts";
import { assertLiveEndpoint, contextText, endpoint, endpointFromBinding, makeEnvelope, sameEndpoint,
  KINDS, type Endpoint, type Kind } from "./messaging/protocol.ts";

export const PEER_MESSAGE_TYPE = "pi-rex.peer.message";
export const MAX_PEER_REQUEST_BYTES = 40 * 1024;
export const MAX_PEER_RESPONSE_BYTES = 96 * 1024;
export const MAX_HISTORY_PAGE_BYTES = 48 * 1024;
export const MAX_HISTORY_ENTRY_BYTES = 48 * 1024;
export const MAX_PEER_AGENT_NOTIFICATION_TEXT_BYTES = 2048;
const PROTOCOL = "pi-rex.peer";
const VIEWS = ["branch", "context"] as const;
const DELIVERIES = ["steer", "followUp"] as const;
type View = typeof VIEWS[number];
type Delivery = typeof DELIVERIES[number];

export interface PeerReadInput { view?: View; limit?: number; cursor?: string }
export interface PeerSendInput {
  id: string; requestId: string; kind: Kind; text: string; delivery: Delivery; triggerTurn: boolean;
}
interface PeerRequest {
  type: typeof PROTOCOL; version: 1; id: string;
  op: "read" | "send" | "agentActivity" | "agentResult" | "agentCancel" | "agentStop";
  from: Endpoint; to: Endpoint; params: PeerReadInput | PeerSendInput | AgentHandle | PeerAgentControlInput | Record<string, never>;
}
export interface PeerAgentActivityResult {
  target: Identity;
  /** Opaque, secret-free fingerprint; only equality within an exact handle is meaningful. */
  endpointId: string;
  activity: { idle: boolean; pendingMessages: boolean; settled: boolean };
}
export interface PeerAgentResultResult {
  target: Identity;
  endpointId: string;
  handle: AgentHandle;
  completion?: unknown;
}
interface PeerAgentControlInput {
  handle: AgentHandle;
  endpointId: string;
}
/** Local retained-completion provider; it cannot select routes or mutate delivery/activity. */
export interface PeerAgentResultProvider {
  completion(handle: AgentHandle): unknown | undefined;
}
export type PeerAgentCancelState = "acknowledged" | "settled" | "unknown";
export type PeerAgentCancelReason = "busy" | "idle" | "already-settled" | "no-active-work" | "abort-throw";
export interface PeerAgentCancelLocalResult {
  state: PeerAgentCancelState;
  reason: PeerAgentCancelReason;
  error?: string;
}
export interface PeerAgentCancelResult extends PeerAgentCancelLocalResult {
  target: Identity;
  endpointId: string;
  handle: AgentHandle;
}
/** Exact local run validation and deduplication; the callback is the only abort authority. */
export interface PeerAgentCancelProvider {
  cancel(handle: AgentHandle, effect: () => PeerAgentCancelLocalResult): PeerAgentCancelLocalResult;
}
export type PeerAgentStopState = "accepted" | "closed" | "unknown";
export type PeerAgentStopReason = "shutdown-requested" | "already-exited" | "shutdown-throw";
export interface PeerAgentStopLocalResult {
  state: PeerAgentStopState;
  reason: PeerAgentStopReason;
  error?: string;
}
export interface PeerAgentStopResult extends PeerAgentStopLocalResult {
  target: Identity;
  endpointId: string;
  handle: AgentHandle;
}
/** Exact local endpoint validation and deduplication; the callback is the only shutdown authority. */
export interface PeerAgentStopProvider {
  stop(handle: AgentHandle, effect: () => PeerAgentStopLocalResult): PeerAgentStopLocalResult;
}
export class PeerAgentResultEvidenceError extends Error {}
export function isPeerAgentResultEvidenceError(error: unknown): error is PeerAgentResultEvidenceError {
  return error instanceof PeerAgentResultEvidenceError;
}

export interface PeerReadResult {
  target: Identity; sessionId: string; leafId: string | null; view: View;
  entries: unknown[]; bytes: number; next?: string;
  activity: { idle: boolean; pendingMessages: boolean };
}
export interface PeerSendResult {
  id: string; state: "accepted"; target: Identity; delivery: Delivery; triggerTurn: boolean;
  processingConfirmed: false; completionConfirmed: false;
}

/** Internal evidence notification. Result-available evidence is deliberately not implemented. */
export interface PeerAgentNotification {
  type: "activity.settled";
  handle: AgentHandle;
  eventId: string;
}

function notificationEventId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value))
    throw new Error("Invalid agent notification event correlation");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || String(id) !== value) throw new Error("Invalid agent notification event correlation");
  return value;
}

export function parsePeerAgentNotification(value: unknown): PeerAgentNotification {
  const input = record(value);
  keys(input, ["type", "handle", "eventId"]);
  if (input.type !== "activity.settled") throw new Error("Unsupported agent notification evidence");
  return { type: "activity.settled", handle: parseAgentHandle(input.handle),
    eventId: notificationEventId(input.eventId) };
}

/** Stable across sender replacement: exact run incarnation plus its retained local settlement event. */
export function peerAgentNotificationId(value: unknown): string {
  const notification = parsePeerAgentNotification(value);
  const hex = createHash("sha256").update(JSON.stringify(notification)).digest("hex").split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)]
    .map(part => part.join("")).join("-");
}

function notificationText(notification: PeerAgentNotification): string {
  const handle = notification.handle;
  const value = ["Rex child agent settlement notification.",
    `Run: ${handle.runId}`, `Runtime: ${handle.runtimeId}`, `Request: ${handle.requestId}`,
    `Settlement event: ${notification.eventId}`,
    "Local Pi agent-end evidence settled this exact registered run; this is not completion or result availability.",
    "Delivery acceptance does not confirm parent processing or completion."].join("\n");
  if (Buffer.byteLength(value) > MAX_PEER_AGENT_NOTIFICATION_TEXT_BYTES)
    throw new Error("Agent notification text bound exceeded");
  return value;
}

type PeerResult = PeerReadResult | PeerSendResult | PeerAgentActivityResult | PeerAgentResultResult
  | PeerAgentCancelResult | PeerAgentStopResult;

function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key)))
    throw new Error("Unexpected or missing peer fields");
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.length || value.length > max) throw new Error("Invalid peer text");
  return value;
}
function readInput(value: unknown): PeerReadInput {
  const v = record(value);
  keys(v, ["view", "limit", "cursor"].filter(key => Object.hasOwn(v, key)));
  const view = v.view ?? "branch", limit = v.limit ?? 20;
  if (typeof view !== "string" || !VIEWS.includes(view as View)
      || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100
      || (v.cursor !== undefined && (typeof v.cursor !== "string" || !v.cursor.length || v.cursor.length > 2048)))
    throw new Error("Invalid conversation read parameters");
  return { view: view as View, limit: Number(limit), ...(v.cursor === undefined ? {} : { cursor: v.cursor as string }) };
}
function sendInput(value: unknown): PeerSendInput {
  const v = record(value);
  keys(v, ["id", "requestId", "kind", "text", "delivery", "triggerTurn"]);
  if (!uuid(v.id) || typeof v.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(v.requestId)
      || typeof v.kind !== "string" || !KINDS.includes(v.kind as Kind)
      || typeof v.text !== "string" || !v.text.trim() || v.text.length > 32768
      || typeof v.delivery !== "string" || !DELIVERIES.includes(v.delivery as Delivery)
      || typeof v.triggerTurn !== "boolean") throw new Error("Invalid peer message parameters");
  return { id: v.id, requestId: v.requestId, kind: v.kind as Kind, text: v.text,
    delivery: v.delivery as Delivery, triggerTurn: v.triggerTurn };
}
function agentActivityInput(value: unknown): Record<string, never> {
  const input = record(value); keys(input, []);
  return {};
}
function agentResultInput(value: unknown): AgentHandle { return parseAgentHandle(value); }
function agentControlInput(value: unknown): PeerAgentControlInput {
  const input = record(value);
  keys(input, ["handle", "endpointId"]);
  if (typeof input.endpointId !== "string" || !/^[0-9a-f]{64}$/.test(input.endpointId))
    throw new Error("Invalid expected agent endpoint incarnation");
  return { handle: parseAgentHandle(input.handle), endpointId: input.endpointId };
}
export function decodePeerRequest(body: string): PeerRequest {
  if (Buffer.byteLength(body) > MAX_PEER_REQUEST_BYTES) throw new Error("Peer request exceeds 40 KiB");
  const v = record(JSON.parse(body));
  keys(v, ["type", "version", "id", "op", "from", "to", "params"]);
  if (v.type !== PROTOCOL || v.version !== 1 || !uuid(v.id)
      || !["read", "send", "agentActivity", "agentResult", "agentCancel", "agentStop"].includes(String(v.op)))
    throw new Error("Invalid peer request");
  const from = endpoint(v.from), to = endpoint(v.to);
  if (from.taskId !== to.taskId || from.serverInstance !== to.serverInstance || from.hostId !== to.hostId
      || from.conversationId === to.conversationId || from.blockId === to.blockId) throw new Error("Unrelated or invalid peer route");
  return { type: PROTOCOL, version: 1, id: v.id, op: v.op as PeerRequest["op"], from, to,
    params: v.op === "read" ? readInput(v.params) : v.op === "send" ? sendInput(v.params)
      : v.op === "agentResult" ? agentResultInput(v.params)
        : v.op === "agentActivity" ? agentActivityInput(v.params) : agentControlInput(v.params) };
}
function decodePeerResponse(body: string, id: string): PeerResult {
  if (Buffer.byteLength(body) > MAX_PEER_RESPONSE_BYTES) throw new Error("Peer response exceeds 96 KiB");
  const v = record(JSON.parse(body));
  keys(v, ["type", "version", "id", "ok", ...(v.ok ? ["result"] : ["error"])]);
  if (v.type !== PROTOCOL || v.version !== 1 || v.id !== id || typeof v.ok !== "boolean") throw new Error("Invalid peer response");
  if (!v.ok) throw new Error(text(record(v.error).message, 1024));
  return v.result as PeerResult;
}
function socketPath(directory: string, target: Endpoint): string {
  const digest = createHash("sha256").update([target.serverInstance, target.conversationId, target.token].join(":")).digest("hex");
  return join(directory, "peers", digest.slice(0, 40) + ".sock");
}
function encodeCursor(sessionId: string, leafId: string, view: View, after: string): string {
  return Buffer.from(JSON.stringify({ version: 1, sessionId, leafId, view, after })).toString("base64url");
}
function decodeCursor(raw: string, sessionId: string, leafId: string | null, view: View): string {
  const v = record(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  keys(v, ["version", "sessionId", "leafId", "view", "after"]);
  if (v.version !== 1 || v.sessionId !== sessionId || v.leafId !== leafId || v.view !== view
      || typeof v.after !== "string" || !v.after) throw new Error("Stale or mismatched conversation cursor");
  return v.after;
}
export function historyPage(entries: readonly unknown[], sessionId: string, leafId: string | null,
    input: Required<Pick<PeerReadInput, "view" | "limit">> & Pick<PeerReadInput, "cursor">): Omit<PeerReadResult, "target" | "activity"> {
  if (entries.length > 100_000) throw new Error("Conversation entry bound exceeded");
  const view = input.view;
  let start = 0;
  if (input.cursor !== undefined) {
    const after = decodeCursor(input.cursor, sessionId, leafId, view);
    start = entries.findIndex(raw => record(raw).id === after) + 1;
    if (!start) throw new Error("Conversation cursor is no longer on the active view");
  }
  const selected: unknown[] = [], seen = new Set<string>();
  let bytes = 0, index = 0;
  for (const raw of entries) {
    const id = record(raw).id;
    if (typeof id !== "string" || !id || seen.has(id)) throw new Error("Invalid conversation entries");
    seen.add(id);
  }
  for (index = start; index < entries.length && selected.length < input.limit; index++) {
    const raw = entries[index], body = JSON.stringify(raw), size = Buffer.byteLength(body);
    if (size > MAX_HISTORY_ENTRY_BYTES) throw new Error("Conversation entry " + record(raw).id + " exceeds 48 KiB");
    if (selected.length && bytes + size > MAX_HISTORY_PAGE_BYTES) break;
    if (bytes + size > MAX_HISTORY_PAGE_BYTES) throw new Error("Conversation page exceeds 48 KiB");
    selected.push(raw); bytes += size;
  }
  const next = index < entries.length
    ? encodeCursor(sessionId, leafId!, view, record(selected.at(-1)).id as string) : undefined;
  return { sessionId, leafId, view, entries: selected, bytes, ...(next ? { next } : {}) };
}
function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700)
    throw new Error("Unsafe peer endpoint directory");
}
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 1024);
}
export function agentEndpointId(endpoint: Endpoint): string {
  return createHash("sha256").update([endpoint.serverInstance, endpoint.conversationId, endpoint.blockId,
    String(endpoint.pid), endpoint.token].join(":")).digest("hex");
}

export class PeerSendUnknownError extends Error {}
export function isPeerSendUnknownError(error: unknown): error is PeerSendUnknownError {
  return error instanceof PeerSendUnknownError;
}
export class PeerAgentCancelUnknownError extends Error {}
export function isPeerAgentCancelUnknownError(error: unknown): error is PeerAgentCancelUnknownError {
  return error instanceof PeerAgentCancelUnknownError;
}
export class PeerAgentStopUnknownError extends Error {}
export function isPeerAgentStopUnknownError(error: unknown): error is PeerAgentStopUnknownError {
  return error instanceof PeerAgentStopUnknownError;
}
function unknownStop(error: unknown): Error {
  if (error instanceof PeerAgentStopUnknownError) return error;
  return new PeerAgentStopUnknownError("Agent stop outcome is unknown after a possible shutdown request; do not retry: "
    + errorMessage(error));
}
function unknownCancel(error: unknown): Error {
  if (error instanceof PeerAgentCancelUnknownError) return error;
  return new PeerAgentCancelUnknownError("Agent cancellation outcome is unknown after a possible request; do not retry: "
    + errorMessage(error));
}
function unknownSend(error: unknown): Error {
  if (error instanceof PeerSendUnknownError) return error;
  return new PeerSendUnknownError("Peer send outcome may be unknown; do not retry with a new message ID: " + errorMessage(error));
}

/** A cooperating live Pi endpoint. Binding identity authorizes neither unrelated tasks nor human-role injection. */
export class PeerRuntime {
  private readonly pi: Pick<ExtensionAPI, "sendMessage">;
  private readonly runtime: Runtime;
  private readonly stateDirectory: string;
  private ctx?: ExtensionContext;
  private own?: Snapshot;
  private owner?: Endpoint;
  private file?: string;
  private anchor: string | null = null;
  private server?: SocketServer;
  private path?: string;
  private socketStat?: { dev: number; ino: number };
  private sockets = new Set<Socket>();
  private requests = new Map<string, { digest: string; result: Promise<PeerResult> }>();
  private resultProvider?: PeerAgentResultProvider;
  private cancelProvider?: PeerAgentCancelProvider;
  private stopProvider?: PeerAgentStopProvider;
  private controller = new AbortController();
  private generation = 0;
  private settled = false;
  constructor(pi: Pick<ExtensionAPI, "sendMessage">, runtime: Runtime, stateDirectory: string) {
    this.pi = pi; this.runtime = runtime; this.stateDirectory = stateDirectory;
  }
  /** Narrow local handler links; incoming routes remain authenticated by dispatch/verifySource. */
  setAgentResultProvider(provider?: PeerAgentResultProvider): void { this.resultProvider = provider; }
  setAgentCancelProvider(provider?: PeerAgentCancelProvider): void { this.cancelProvider = provider; }
  setAgentStopProvider(provider?: PeerAgentStopProvider): void { this.stopProvider = provider; }

  async attach(ctx: ExtensionContext): Promise<void> {
    this.detach();
    this.settled = false;
    if (ctx.mode !== "tui") throw new Error("Peer access requires interactive Pi in verified local Rex");
    const own = this.runtime.snapshot(), binding = this.runtime.store.find(own.state, own.server);
    if (!binding || ctx.sessionManager.getSessionId() !== own.state.piSessionId) throw new Error("Peer owner changed");
    const generation = this.generation;
    this.ctx = ctx; this.own = own; this.owner = Object.freeze(endpointFromBinding(binding));
    this.file = ctx.sessionManager.getSessionFile(); this.anchor = ctx.sessionManager.getLeafId();
    this.guard();
    const directory = join(this.stateDirectory, "peers");
    const path = socketPath(this.stateDirectory, this.owner);
    const server = createServer(socket => { void this.serve(socket); });
    this.server = server; this.path = path;
    server.on("error", () => { if (this.server === server) this.detach(); });
    try {
      // BindingStore.start has already pinned the private parent. Never create a broader tree here.
      this.runtime.store.all();
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      privateDirectory(directory);
      await new Promise<void>((resolve, reject) => {
        const error = (error: Error) => reject(error);
        server.once("error", error);
        server.listen(path, () => { server.off("error", error); resolve(); });
      });
      if (generation !== this.generation || this.server !== server) throw new Error("Peer runtime changed during startup");
      chmodSync(path, 0o600);
      const stat = lstatSync(path);
      if (!stat.isSocket()) throw new Error("Unsafe peer socket");
      this.socketStat = { dev: stat.dev, ino: stat.ino };
      this.guard();
    } catch (error) { this.detach(); throw error; }
  }
  detach(): void {
    this.generation++; this.controller.abort(); this.controller = new AbortController();
    this.settled = false;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server?.close(); this.server = undefined;
    const path = this.path, expected = this.socketStat;
    if (path && expected) {
      try {
        const stat = lstatSync(path);
        if (stat.isSocket() && stat.dev === expected.dev && stat.ino === expected.ino) unlinkSync(path);
      } catch { /* shutdown leaves stale evidence if exact cleanup is unavailable */ }
    }
    this.path = undefined; this.socketStat = undefined; this.requests.clear(); this.resultProvider = undefined;
    this.cancelProvider = undefined; this.stopProvider = undefined;
    this.ctx = undefined; this.own = undefined; this.owner = undefined; this.file = undefined; this.anchor = null;
  }
  private guard(): void {
    const ctx = this.ctx, own = this.own, owner = this.owner;
    this.controller.signal.throwIfAborted();
    if (!ctx || !own || !owner || ctx.sessionManager.getSessionId() !== owner.piSessionId
        || ctx.sessionManager.getSessionFile() !== this.file) throw new Error("Peer session changed");
    this.runtime.assert(own); assertLiveEndpoint(owner, this.runtime.store, own.server);
    if (this.anchor && !ctx.sessionManager.getBranch().some(entry => entry.id === this.anchor))
      throw new Error("Peer branch changed; endpoint is stale");
  }
  /** Pi lifecycle hooks update observations only; they never inject input or start work. */
  observeAgentStart(ctx: ExtensionContext): void {
    if (!this.ctx || ctx.sessionManager !== this.ctx.sessionManager) throw new Error("Stale Pi agent-start context");
    this.guard(); this.settled = false;
  }
  observeAgentEnd(ctx: ExtensionContext): void {
    if (!this.ctx || ctx.sessionManager !== this.ctx.sessionManager) throw new Error("Stale Pi agent-end context");
    this.guard(); this.settled = true;
  }
  private async verifySource(source: Endpoint, signal: AbortSignal): Promise<void> {
    this.guard();
    if (source.taskId !== this.owner!.taskId) throw new Error("Cross-task peer access requires a separate authorization flow");
    assertLiveEndpoint(source, this.runtime.store, this.own!.server);
    const target = await this.runtime.rex.locate(source.blockId, signal);
    await this.runtime.rex.verifyProcess(target, source.pid, signal);
    await this.runtime.rex.checkServer(signal); signal.throwIfAborted();
    this.guard(); assertLiveEndpoint(source, this.runtime.store, this.own!.server);
  }
  private async dispatch(request: PeerRequest, signal: AbortSignal): Promise<PeerResult> {
    if (!sameEndpoint(request.to, this.owner!)) throw new Error("Stale or mismatched peer recipient");
    await this.verifySource(request.from, signal); signal.throwIfAborted(); this.guard();
    if (request.op === "agentActivity") {
      const owner = this.owner!;
      return { target: this.own!.state, endpointId: agentEndpointId(owner),
        activity: { idle: this.ctx!.isIdle(), pendingMessages: this.ctx!.hasPendingMessages(), settled: this.settled } };
    }
    if (request.op === "agentResult") {
      const owner = this.owner!, handle = request.params as AgentHandle;
      if (handle.taskId !== this.own!.state.taskId || handle.conversationId !== this.own!.state.conversationId)
        throw new Error("Agent result provider serves only its own verified conversation");
      if (!this.resultProvider) throw new Error("Agent result provider is unavailable");
      const completion = this.resultProvider.completion(handle);
      this.guard();
      return { target: this.own!.state, handle,
        endpointId: agentEndpointId(owner),
        ...(completion === undefined ? {} : { completion }) };
    }
    if (request.op === "agentCancel") {
      const owner = this.owner!, input = request.params as PeerAgentControlInput, handle = input.handle, provider = this.cancelProvider;
      if (handle.taskId !== this.own!.state.taskId || handle.conversationId !== this.own!.state.conversationId)
        throw new Error("Agent cancel provider serves only its own verified conversation");
      if (input.endpointId !== agentEndpointId(owner)) throw new Error("Stale expected agent endpoint incarnation");
      if (!provider) throw new Error("Agent cancel provider is unavailable");
      // The exact-run provider synchronously fences completion and deduplicates before yielding abort authority.
      this.guard(); signal.throwIfAborted();
      const outcome = provider.cancel(handle, () => {
        this.guard(); signal.throwIfAborted();
        if (this.ctx!.isIdle()) return { state: "settled", reason: "idle" };
        try {
          // This is the sole native effect. Its acknowledgement is not evidence of quiescence or a result.
          this.ctx!.abort();
          return { state: "acknowledged", reason: "busy" };
        } catch (error) {
          return { state: "unknown", reason: "abort-throw", error: errorMessage(error) };
        }
      });
      return { target: this.own!.state, handle, ...outcome,
        endpointId: agentEndpointId(owner) };
    }
    if (request.op === "agentStop") {
      const owner = this.owner!, input = request.params as PeerAgentControlInput, handle = input.handle, provider = this.stopProvider;
      if (handle.taskId !== this.own!.state.taskId || handle.conversationId !== this.own!.state.conversationId)
        throw new Error("Agent stop provider serves only its own verified conversation");
      if (input.endpointId !== agentEndpointId(owner)) throw new Error("Stale expected agent endpoint incarnation");
      if (!provider) throw new Error("Agent stop provider is unavailable");
      // Exact endpoint/run validation and synchronous deduplication precede the sole native shutdown effect.
      this.guard(); signal.throwIfAborted();
      const outcome = provider.stop(handle, () => {
        this.guard(); signal.throwIfAborted();
        try {
          // Acceptance means Pi shutdown was requested, never that the endpoint exited.
          this.ctx!.shutdown();
          return { state: "accepted", reason: "shutdown-requested" };
        } catch (error) {
          return { state: "unknown", reason: "shutdown-throw", error: errorMessage(error) };
        }
      });
      return { target: this.own!.state, handle, ...outcome,
        endpointId: agentEndpointId(owner) };
    }
    if (request.op === "read") {
      const input = request.params as PeerReadInput, ctx = this.ctx!;
      const entries = input.view === "context" ? ctx.sessionManager.buildContextEntries() : ctx.sessionManager.getBranch();
      const result = historyPage(entries, ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId(),
        { view: input.view ?? "branch", limit: input.limit ?? 20, ...(input.cursor ? { cursor: input.cursor } : {}) });
      this.guard();
      return { target: this.own!.state, ...result,
        activity: { idle: ctx.isIdle(), pendingMessages: ctx.hasPendingMessages() } };
    }
    const input = request.params as PeerSendInput;
    const envelope = makeEnvelope(request.from, request.to, input.requestId, input.kind, input.text, input.id);
    // Final synchronous fence: no native await may separate ownership validation from the void SDK call.
    this.guard(); signal.throwIfAborted();
    this.pi.sendMessage({ customType: PEER_MESSAGE_TYPE, display: true,
      details: { envelope, delivery: input.delivery, triggerTurn: input.triggerTurn }, content: contextText(envelope) },
      { triggerTurn: input.triggerTurn, deliverAs: input.delivery });
    return { id: input.id, state: "accepted", target: this.own!.state, delivery: input.delivery,
      triggerTurn: input.triggerTurn, processingConfirmed: false, completionConfirmed: false };
  }
  private async serve(socket: Socket): Promise<void> {
    this.sockets.add(socket);
    const controller = new AbortController();
    const abort = () => controller.abort();
    socket.once("close", abort);
    let buffer = "", id = "";
    try {
      const decoder = new StringDecoder("utf8");
      const body = await new Promise<string>((resolve, reject) => {
        socket.on("data", chunk => {
          buffer += decoder.write(chunk);
          if (Buffer.byteLength(buffer) > MAX_PEER_REQUEST_BYTES + 1) { reject(new Error("Peer request exceeds 40 KiB")); return; }
          const end = buffer.indexOf("\n");
          if (end >= 0) {
            if (buffer.slice(end + 1).length) reject(new Error("One peer request per connection"));
            else resolve(buffer.slice(0, end));
          }
        });
        socket.once("error", reject); socket.once("close", () => reject(new Error("Peer connection closed")));
        socket.setTimeout(7000, () => reject(new Error("Peer request timed out")));
      });
      const request = decodePeerRequest(body); id = request.id;
      const digest = createHash("sha256").update(body).digest("hex");
      let prior = request.op === "send" ? this.requests.get(id) : undefined;
      if (prior && prior.digest !== digest) throw new Error("Conflicting peer request ID");
      if (!prior) {
        if (request.op === "send" && this.requests.size >= 1024) throw new Error("Peer request history bound reached");
        const signal = AbortSignal.any([this.controller.signal, this.own!.signal, controller.signal]);
        prior = { digest, result: Promise.resolve().then(() => this.dispatch(request, signal)) };
        // Reads are snapshots, not logical effects; retaining them would exhaust the send deduplication budget.
        if (request.op === "send") this.requests.set(id, prior);
      }
      const result = await prior.result;
      const response = JSON.stringify({ type: PROTOCOL, version: 1, id, ok: true, result });
      if (Buffer.byteLength(response) > MAX_PEER_RESPONSE_BYTES) throw new Error("Peer response exceeds 96 KiB");
      if (!socket.destroyed) socket.end(response + "\n");
    } catch (error) {
      if (!socket.destroyed) socket.end(JSON.stringify({ type: PROTOCOL, version: 1, id,
        ok: false, error: { message: errorMessage(error) } }) + "\n");
    } finally { this.sockets.delete(socket); }
  }
  private target(conversationId: string): Endpoint {
    if (!uuid(conversationId)) throw new Error("Invalid target conversation ID");
    const own = this.own!, candidates = this.runtime.store.all().filter(binding => isLive(binding, own.server)
      && binding.taskId === own.state.taskId && binding.conversationId === conversationId);
    if (candidates.length !== 1) throw new Error("Target conversation is not uniquely live in this related task");
    const binding = this.runtime.store.find(candidates[0], own.server);
    if (!binding || sameIdentity(binding, own.state)) throw new Error("Invalid or ambiguous peer target");
    return endpointFromBinding(binding);
  }
  private async request(targetId: string,
      op: "read" | "send" | "agentActivity" | "agentResult" | "agentCancel" | "agentStop",
      params: PeerReadInput | PeerSendInput | AgentHandle | PeerAgentControlInput | Record<string, never>, id: string,
      external?: AbortSignal): Promise<PeerResult> {
    this.guard();
    const own = this.own!, from = this.owner!, to = this.target(targetId), generation = this.generation;
    const signal = AbortSignal.any([this.controller.signal, own.signal, AbortSignal.timeout(10_000), ...(external ? [external] : [])]);
    const request: PeerRequest = { type: PROTOCOL, version: 1, id, op, from, to, params };
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > MAX_PEER_REQUEST_BYTES) throw new Error("Peer request exceeds 40 KiB");
    if (op === "send") {
      const input = params as PeerSendInput;
      // Fail aggregate byte-limit violations before native preflight; the target validates again at dispatch.
      makeEnvelope(from, to, input.requestId, input.kind, input.text, input.id);
    }
    const path = socketPath(this.stateDirectory, to), stat = lstatSync(path);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe or stale peer socket");
    let writeAttempted = false;
    try {
      await this.runtime.source(own, signal);
      const location = await this.runtime.rex.locate(to.blockId, signal);
      await this.runtime.rex.verifyProcess(location, to.pid, signal);
      await this.runtime.rex.checkServer(signal); this.guard(); assertLiveEndpoint(to, this.runtime.store, own.server);
      const result = await new Promise<PeerResult>((resolve, reject) => {
        const socket = createConnection(path);
        let buffer = "", settled = false;
        const decoder = new StringDecoder("utf8");
        const done = (error?: Error, value?: PeerResult) => {
          if (settled) return; settled = true; signal.removeEventListener("abort", aborted);
          socket.removeAllListeners(); socket.destroy();
          if (error) reject(error); else resolve(value!);
        };
        const aborted = () => done(new Error("Peer request aborted or timed out; send outcome may be unknown"));
        signal.addEventListener("abort", aborted, { once: true });
        socket.once("error", error => done(error));
        socket.once("close", () => done(new Error("Peer connection closed before a response; send outcome may be unknown")));
        socket.on("connect", () => {
          writeAttempted = true;
          try { socket.write(body + "\n"); } catch (error) { done(error as Error); }
        });
        socket.on("data", chunk => {
          buffer += decoder.write(chunk);
          if (Buffer.byteLength(buffer) > MAX_PEER_RESPONSE_BYTES + 1) { done(new Error("Peer response exceeds 96 KiB")); return; }
          const end = buffer.indexOf("\n");
          if (end >= 0) {
            try { done(undefined, decodePeerResponse(buffer.slice(0, end), id)); } catch (error) { done(error as Error); }
          }
        });
        if (signal.aborted) aborted();
      });
      signal.throwIfAborted();
      const current = await this.runtime.rex.locate(to.blockId, signal);
      await this.runtime.rex.verifyProcess(current, to.pid, signal);
      await this.runtime.rex.checkServer(signal);
      if (generation !== this.generation) throw new Error("Peer source changed during request");
      this.guard(); assertLiveEndpoint(to, this.runtime.store, own.server);
      return result;
    } catch (error) {
      if (op === "send" && writeAttempted) throw unknownSend(error);
      if (op === "agentCancel" && writeAttempted) throw unknownCancel(error);
      if (op === "agentStop" && writeAttempted) throw unknownStop(error);
      throw error;
    }
  }
  async read(target: string, input: PeerReadInput, signal?: AbortSignal): Promise<PeerReadResult> {
    const result = await this.request(target, "read", readInput(input), randomUUID(), signal) as PeerReadResult;
    if (!Array.isArray(result.entries) || result.target.conversationId !== target || result.view !== (input.view ?? "branch"))
      throw new Error("Mismatched conversation read response");
    return result;
  }
  async agentActivity(target: string, signal?: AbortSignal): Promise<PeerAgentActivityResult> {
    const result = await this.request(target, "agentActivity", {}, randomUUID(), signal) as PeerAgentActivityResult;
    if (result.target?.conversationId !== target || !/^[0-9a-f]{64}$/.test(result.endpointId)
        || typeof result.activity?.idle !== "boolean" || typeof result.activity?.pendingMessages !== "boolean"
        || typeof result.activity?.settled !== "boolean") throw new Error("Mismatched agent activity response");
    return result;
  }
  async agentResult(value: unknown, signal?: AbortSignal): Promise<PeerAgentResultResult> {
    const handle = agentResultInput(value), target = handle.conversationId;
    const result = await this.request(target, "agentResult", handle, randomUUID(), signal);
    try {
      const input = record(result);
      keys(input, ["target", "endpointId", "handle", ...(Object.hasOwn(input, "completion") ? ["completion"] : [])]);
      const targetIdentity = parseIdentity(input.target), responseHandle = parseAgentHandle(input.handle);
      if (targetIdentity.conversationId !== target || typeof input.endpointId !== "string"
          || !/^[0-9a-f]{64}$/.test(input.endpointId)) throw new Error("Mismatched agent result response");
      assertSameAgentRun(responseHandle, handle);
      return { target: targetIdentity, endpointId: input.endpointId, handle: responseHandle,
        ...(Object.hasOwn(input, "completion") ? { completion: input.completion } : {}) };
    } catch (error) {
      throw new PeerAgentResultEvidenceError(errorMessage(error));
    }
  }
  async agentCancel(value: unknown, signal?: AbortSignal, expectedEndpointId?: string): Promise<PeerAgentCancelResult> {
    const handle = agentResultInput(value), target = handle.conversationId;
    const endpointId = expectedEndpointId ?? (await this.agentActivity(target, signal)).endpointId;
    const params = agentControlInput({ handle, endpointId });
    let result: PeerResult;
    try { result = await this.request(target, "agentCancel", params, randomUUID(), signal); }
    catch (error) {
      // Disconnects are conservative unknowns even when the transport failed before its write.
      // Exact local handle/authority rejection happens before this remote request in AgentRuntime.
      throw unknownCancel(error);
    }
    try {
      const input = record(result), optionalError = Object.hasOwn(input, "error");
      keys(input, ["target", "endpointId", "handle", "state", "reason", ...(optionalError ? ["error"] : [])]);
      const targetIdentity = parseIdentity(input.target), responseHandle = parseAgentHandle(input.handle);
      if (targetIdentity.conversationId !== target || typeof input.endpointId !== "string"
          || !/^[0-9a-f]{64}$/.test(input.endpointId)) throw new Error("Mismatched agent cancel response");
      assertSameAgentRun(responseHandle, handle);
      const acknowledged = input.state === "acknowledged" && input.reason === "busy";
      const settled = input.state === "settled"
        && ["idle", "already-settled", "no-active-work"].includes(String(input.reason));
      const unknown = input.state === "unknown" && input.reason === "abort-throw";
      if (!acknowledged && !settled && !unknown) throw new Error("Invalid agent cancel outcome");
      if (optionalError && (typeof input.error !== "string" || !input.error.length || input.error.length > 1024))
        throw new Error("Invalid agent cancel error evidence");
      return { target: targetIdentity, endpointId: input.endpointId, handle: responseHandle,
        state: input.state as PeerAgentCancelState, reason: input.reason as PeerAgentCancelReason,
        ...(optionalError ? { error: input.error as string } : {}) };
    } catch (error) {
      // A response that cannot be correlated cannot retract an abort that may already have run.
      throw unknownCancel(error);
    }
  }
  async agentStop(value: unknown, signal?: AbortSignal, expectedEndpointId?: string): Promise<PeerAgentStopResult> {
    const handle = agentResultInput(value), target = handle.conversationId;
    const endpointId = expectedEndpointId ?? (await this.agentActivity(target, signal)).endpointId;
    const params = agentControlInput({ handle, endpointId });
    // Unlike cancellation, a definite pre-write/unavailable failure remains disconnected. PeerRuntime
    // reserves PeerAgentStopUnknownError for failures after the request write or during response correlation.
    const result = await this.request(target, "agentStop", params, randomUUID(), signal);
    try {
      const input = record(result), optionalError = Object.hasOwn(input, "error");
      keys(input, ["target", "endpointId", "handle", "state", "reason", ...(optionalError ? ["error"] : [])]);
      const targetIdentity = parseIdentity(input.target), responseHandle = parseAgentHandle(input.handle);
      if (targetIdentity.conversationId !== target || typeof input.endpointId !== "string"
          || !/^[0-9a-f]{64}$/.test(input.endpointId)) throw new Error("Mismatched agent stop response");
      assertSameAgentRun(responseHandle, handle);
      const accepted = input.state === "accepted" && input.reason === "shutdown-requested";
      const closed = input.state === "closed" && input.reason === "already-exited";
      const unknown = input.state === "unknown" && input.reason === "shutdown-throw";
      if (!accepted && !closed && !unknown) throw new Error("Invalid agent stop outcome");
      if (optionalError && (typeof input.error !== "string" || !input.error.length || input.error.length > 1024))
        throw new Error("Invalid agent stop error evidence");
      return { target: targetIdentity, endpointId: input.endpointId, handle: responseHandle,
        state: input.state as PeerAgentStopState, reason: input.reason as PeerAgentStopReason,
        ...(optionalError ? { error: input.error as string } : {}) };
    } catch (error) {
      // A response that cannot be correlated cannot prove that shutdown was not requested.
      throw unknownStop(error);
    }
  }
  async send(target: string, input: PeerSendInput, signal?: AbortSignal): Promise<PeerSendResult> {
    const checked = sendInput(input);
    const result = await this.request(target, "send", checked, checked.id, signal) as PeerSendResult;
    try {
      if (result.id !== checked.id || result.state !== "accepted" || result.target?.conversationId !== target
          || result.delivery !== checked.delivery || result.triggerTurn !== checked.triggerTurn)
        throw new Error("Mismatched peer send response");
      return result;
    } catch (error) { throw unknownSend(error); }
  }

  /** Authenticated child-to-origin delivery only; callers cannot select an arbitrary parent. */
  async notifyParent(value: unknown, signal?: AbortSignal): Promise<PeerSendResult> {
    const notification = parsePeerAgentNotification(value), handle = notification.handle;
    this.guard();
    const own = this.own!, origin = own.state.origin;
    if (handle.taskId !== own.state.taskId || handle.conversationId !== own.state.conversationId)
      throw new Error("Agent notification is not for the local child conversation");
    if (!origin) throw new Error("This child has no verified notification origin");
    const parent = this.target(origin.conversationId);
    if (!sameIdentity(parent, origin)) throw new Error("Verified origin identity changed; notification authority is revoked");
    return this.send(origin.conversationId, { id: peerAgentNotificationId(notification),
      requestId: handle.requestId, kind: "progress", text: notificationText(notification),
      delivery: "followUp", triggerTurn: true }, signal);
  }
}
