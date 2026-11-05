import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server as SocketServer, type Socket } from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isLive, record, sameIdentity, uuid, type Identity } from "./state.ts";
import type { Runtime, Snapshot } from "./runtime.ts";
import { assertLiveEndpoint, contextText, endpoint, endpointFromBinding, makeEnvelope, sameEndpoint,
  KINDS, type Endpoint, type Kind } from "./messaging/protocol.ts";

export const PEER_MESSAGE_TYPE = "pi-rex.peer.message";
export const MAX_PEER_REQUEST_BYTES = 40 * 1024;
export const MAX_PEER_RESPONSE_BYTES = 96 * 1024;
export const MAX_HISTORY_PAGE_BYTES = 48 * 1024;
export const MAX_HISTORY_ENTRY_BYTES = 48 * 1024;
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
  type: typeof PROTOCOL; version: 1; id: string; op: "read" | "send";
  from: Endpoint; to: Endpoint; params: PeerReadInput | PeerSendInput;
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
type PeerResult = PeerReadResult | PeerSendResult;

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
export function decodePeerRequest(body: string): PeerRequest {
  if (Buffer.byteLength(body) > MAX_PEER_REQUEST_BYTES) throw new Error("Peer request exceeds 40 KiB");
  const v = record(JSON.parse(body));
  keys(v, ["type", "version", "id", "op", "from", "to", "params"]);
  if (v.type !== PROTOCOL || v.version !== 1 || !uuid(v.id) || (v.op !== "read" && v.op !== "send"))
    throw new Error("Invalid peer request");
  const from = endpoint(v.from), to = endpoint(v.to);
  if (from.taskId !== to.taskId || from.serverInstance !== to.serverInstance || from.hostId !== to.hostId
      || from.conversationId === to.conversationId || from.blockId === to.blockId) throw new Error("Unrelated or invalid peer route");
  return { type: PROTOCOL, version: 1, id: v.id, op: v.op, from, to,
    params: v.op === "read" ? readInput(v.params) : sendInput(v.params) };
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
class PeerSendUnknownError extends Error {}
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
  private controller = new AbortController();
  private generation = 0;
  constructor(pi: Pick<ExtensionAPI, "sendMessage">, runtime: Runtime, stateDirectory: string) {
    this.pi = pi; this.runtime = runtime; this.stateDirectory = stateDirectory;
  }
  async attach(ctx: ExtensionContext): Promise<void> {
    this.detach();
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
    this.path = undefined; this.socketStat = undefined; this.requests.clear();
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
  private async request(targetId: string, op: "read" | "send", params: PeerReadInput | PeerSendInput,
      id: string, external?: AbortSignal): Promise<PeerResult> {
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
      throw error;
    }
  }
  async read(target: string, input: PeerReadInput, signal?: AbortSignal): Promise<PeerReadResult> {
    const result = await this.request(target, "read", readInput(input), randomUUID(), signal) as PeerReadResult;
    if (!Array.isArray(result.entries) || result.target.conversationId !== target || result.view !== (input.view ?? "branch"))
      throw new Error("Mismatched conversation read response");
    return result;
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
}
