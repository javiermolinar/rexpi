import { randomUUID } from "node:crypto";
import { constants, lstatSync, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, parse, resolve, sep, join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { record, uuid } from "../state.ts";
import { decodeEnvelope, digest, endpoint, sameEndpoint, MAX_BATCH, MAX_BATCH_BYTES, type Endpoint, type Envelope } from "./protocol.ts";

export const FOLLOWUP_INTENT = "pi-rex.message.followup.intent";
export const FOLLOWUP_CONTEXT = "pi-rex.message.followup";
export interface Receipt { logicalId: string; digest: string; requestId: string }
export interface FollowupBatch { version: 1; owner: Endpoint; nonce: string; receipts: Receipt[] }
type IndexedReceipt = Receipt & { state: "reserved" | "inserted" };
export type ReceiptIndex = Map<string, IndexedReceipt[]>;
export interface History {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getEntries(): readonly unknown[];
}
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
function fileStat(s: Stats): void {
  // Pi creates ordinary session files using the user's umask (commonly 0644).
  if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o7022))
    throw new Error("Unsafe session storage");
}
function directoryStat(s: Stats): void {
  if (!s.isDirectory() || s.isSymbolicLink() || (s.uid !== 0 && s.uid !== process.getuid?.())
      || ((s.mode & 0o022) && !(s.uid === 0 && (s.mode & 0o1000)))) throw new Error("Unsafe session directory");
}
interface Confirmation { stat: Stats; pins: Map<string, Stats> }
async function ancestors(file: string): Promise<Map<string, Stats>> {
  if (resolve(file) !== file) throw new Error("Session path must be absolute and canonical");
  let path = parse(file).root;
  const pins = new Map<string, Stats>();
  for (const part of dirname(file).slice(path.length).split(sep).filter(Boolean)) {
    path = join(path, part);
    const s = await lstat(path);
    directoryStat(s);
    pins.set(path, s);
  }
  return pins;
}
function entryMap(entries: readonly unknown[]): Map<string, string> {
  if (entries.length > 100_000) throw new Error("Session entry bound exceeded");
  const result = new Map<string, string>();
  for (const raw of entries) {
    const e = record(raw), body = JSON.stringify(e);
    if (typeof e.id !== "string" || !e.id || result.has(e.id) || Buffer.byteLength(body) > MAX_ENTRY_BYTES)
      throw new Error("Invalid session entries");
    result.set(e.id, body);
  }
  return result;
}

/**
 * Confirm this session's full in-memory tree, not just the active branch or one matching nonce.
 * Missing/extra/conflicting entries, partial writes and replacement all fail closed. No repair.
 * fsync confirms the SDK append reached this file; it cannot make enqueue/model work atomic.
 */
export async function persistedEntries(file: string, sessionId: string, expected: Map<string, string>, signal?: AbortSignal): Promise<Confirmation> {
  signal?.throwIfAborted();
  const pins = await ancestors(file), named = await lstat(file);
  fileStat(named);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); fileStat(before);
    if (!sameInode(before, named) || before.size > MAX_HISTORY_BYTES) throw new Error("Changed or oversized session history (32 MiB)");
    const buffer = Buffer.alloc(64 * 1024), decoder = new TextDecoder("utf-8", { fatal: true });
    let position = 0, pending = "", header = false, lines = 0;
    const found = new Set<string>(), deadline = Date.now() + 2500;
    while (position < before.size) {
      signal?.throwIfAborted();
      if (Date.now() > deadline) throw new Error("Session confirmation deadline exceeded");
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) throw new Error("Session changed during confirmation");
      position += bytesRead; pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line || Buffer.byteLength(line) > MAX_ENTRY_BYTES) throw new Error("Invalid/oversized session entry");
        const e = record(JSON.parse(line));
        if (!header) {
          if (e.type !== "session" || e.version !== 3 || e.id !== sessionId) throw new Error("Session owner/version changed");
          header = true;
        } else {
          if (e.type === "session" || typeof e.type !== "string" || typeof e.id !== "string" || found.has(e.id)
              || typeof e.timestamp !== "string" || (e.parentId !== null && (typeof e.parentId !== "string" || !found.has(e.parentId)))
              || JSON.stringify(e) !== expected.get(e.id)) throw new Error("Session tree differs from memory");
          found.add(e.id);
        }
        if (++lines % 64 === 0) await yieldTurn();
      }
      if (Buffer.byteLength(pending) > MAX_ENTRY_BYTES) throw new Error("Session entry exceeds confirmation bound");
    }
    pending += decoder.decode();
    if (pending || !header || found.size !== expected.size) throw new Error("Intent is not confirmed in persisted session history");
    await handle.sync();
    const after = await handle.stat(), current = await lstat(file); fileStat(after); fileStat(current);
    if (!sameInode(before, after) || !sameInode(after, current) || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs)
      throw new Error("Session changed during confirmation");
    const currentPins = await ancestors(file);
    for (const [path, pin] of pins) if (!sameInode(pin, currentPins.get(path)!)) throw new Error("Session directory changed");
    signal?.throwIfAborted();
    return { stat: after, pins: currentPins };
  } finally { await handle.close(); }
}
function batch(value: unknown): FollowupBatch {
  const v = record(value), owner = endpoint(v.owner);
  if (v.version !== 1 || !uuid(v.nonce) || !Array.isArray(v.receipts) || !v.receipts.length || v.receipts.length > MAX_BATCH)
    throw new Error("Invalid follow-up record");
  const receipts = v.receipts.map(raw => {
    const r = record(raw);
    if (!uuid(r.logicalId) || typeof r.digest !== "string" || !/^[a-f0-9]{64}$/.test(r.digest)
        || typeof r.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(r.requestId)) throw new Error("Invalid follow-up receipt");
    return { logicalId: r.logicalId, digest: r.digest, requestId: r.requestId };
  });
  if (new Set(receipts.map(r => r.logicalId)).size !== receipts.length) throw new Error("Duplicate follow-up receipts");
  return { version: 1, owner, nonce: v.nonce, receipts };
}

/** No persisted permission. Intent suppresses replay; context presence never claims processing. */
export class ReceiptLedger {
  readonly owner: Endpoint;
  private readonly history: History;
  private readonly append: (type: string, data: FollowupBatch) => void;
  private readonly active: () => boolean;
  private readonly file: string | undefined;
  private readonly attempted = new Map<string, string>();
  private reserving = false;
  private confirmed?: Confirmation & { entries: Map<string, string> };
  constructor(owner: Endpoint, history: History, append: (type: string, data: FollowupBatch) => void, active = () => true) {
    this.owner = endpoint(owner); this.history = history; this.append = append; this.active = active;
    this.file = history.getSessionFile();
  }
  private guard(): void {
    if (!this.active() || this.history.getSessionId() !== this.owner.piSessionId || this.history.getSessionFile() !== this.file)
      throw new Error("Receipt belongs to an inactive session");
  }
  /** Index one current history snapshot; do not reuse it across asynchronous history changes. */
  receiptIndex(): ReceiptIndex {
    this.guard();
    const index: ReceiptIndex = new Map();
    // Deliberately all branches, and all owner generations within this Pi session.
    const entries = this.history.getEntries();
    if (entries.length > 100_000) throw new Error("Session entry bound exceeded");
    for (const raw of entries) {
      const e = record(raw);
      const intent = e.type === "custom" && e.customType === FOLLOWUP_INTENT;
      const context = e.type === "custom_message" && e.customType === FOLLOWUP_CONTEXT;
      if (!intent && !context) continue;
      const b = batch(intent ? e.data : e.details);
      if (b.owner.piSessionId !== this.owner.piSessionId) continue;
      for (const r of b.receipts) {
        const records = index.get(r.logicalId) ?? [];
        records.push({ ...r, state: context ? "inserted" : "reserved" });
        index.set(r.logicalId, records);
      }
    }
    return index;
  }
  inspect(envelope: Envelope, index = this.receiptIndex(), content = digest(envelope)): "new" | "reserved" | "inserted" | "conflict" {
    this.guard();
    let status: "new" | "reserved" | "inserted" = "new";
    if (this.attempted.has(envelope.id)) {
      if (this.attempted.get(envelope.id) !== content) return "conflict";
      status = "reserved";
    }
    for (const r of index.get(envelope.id) ?? []) {
      if (r.digest !== content || r.requestId !== envelope.requestId) return "conflict";
      if (r.state === "inserted") status = "inserted";
      else if (status !== "inserted") status = "reserved";
    }
    return status;
  }
  async confirm(signal?: AbortSignal): Promise<void> {
    this.guard();
    if (!this.file) throw new Error("Messaging requires a persisted Pi session");
    const expected = entryMap(this.history.getEntries());
    const evidence = await persistedEntries(this.file, this.owner.piSessionId, expected, signal);
    this.guard();
    // A later confirmation may accept new entries, but never repin replacement storage.
    if (this.confirmed && (!sameInode(this.confirmed.stat, evidence.stat)
        || [...this.confirmed.pins].some(([path, pin]) => {
          const current = evidence.pins.get(path);
          return !current || !sameInode(pin, current);
        }))) throw new Error("Session storage changed since confirmation");
    this.confirmed = { ...evidence, entries: expected };
    this.assertConfirmed();
  }
  /** Final synchronous fence: no async/native work may separate this check from enqueue. */
  assertConfirmed(): void {
    this.guard();
    if (!this.file || !this.confirmed) throw new Error("Session storage is not confirmed");
    const { entries, pins, stat } = this.confirmed, current = entryMap(this.history.getEntries());
    if (current.size !== entries.size || [...entries].some(([id, body]) => current.get(id) !== body))
      throw new Error("Session changed during durable confirmation");
    for (const [path, pin] of pins) {
      const directory = lstatSync(path); directoryStat(directory);
      if (!sameInode(pin, directory)) throw new Error("Session directory changed since confirmation");
    }
    const named = lstatSync(this.file); fileStat(named);
    if (!sameInode(stat, named) || stat.size !== named.size || stat.mtimeMs !== named.mtimeMs || stat.ctimeMs !== named.ctimeMs)
      throw new Error("Session storage changed since confirmation");
  }
  async reserveFollowup(values: Envelope[], signal?: AbortSignal): Promise<FollowupBatch> {
    this.guard(); signal?.throwIfAborted();
    const items = values.map(e => decodeEnvelope(JSON.stringify(e)));
    const contents = new Map(items.map(e => [e.id, digest(e)]));
    if (this.reserving || !items.length || items.length > MAX_BATCH || new Set(items.map(e => e.id)).size !== items.length
        || items.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0) > MAX_BATCH_BYTES
        || items.some(e => e.kind === "progress" || !sameEndpoint(e.to, this.owner)))
      throw new Error("Follow-up batch is not fresh or routing changed");
    const index = this.receiptIndex();
    if (items.some(e => this.inspect(e, index, contents.get(e.id)) !== "new"))
      throw new Error("Follow-up batch is not fresh or routing changed");
    this.reserving = true;
    // Memory fences precede ANY append/await. Failed or unflushed intent is never blindly retried.
    for (const e of items) this.attempted.set(e.id, contents.get(e.id)!);
    try {
      await this.confirm(signal); this.guard(); signal?.throwIfAborted();
      const details: FollowupBatch = { version: 1, owner: this.owner, nonce: randomUUID(),
        receipts: items.map(e => ({ logicalId: e.id, digest: contents.get(e.id)!, requestId: e.requestId })) };
      const encoded = JSON.stringify(details);
      this.append(FOLLOWUP_INTENT, details);
      const entries = this.history.getEntries().map(record).filter(e => e.type === "custom" && e.customType === FOLLOWUP_INTENT
        && record(e.data).nonce === details.nonce);
      if (entries.length !== 1 || JSON.stringify(entries[0].data) !== encoded) throw new Error("Pi did not append the exact follow-up intent");
      await this.confirm(signal);
      return details;
    } finally { this.reserving = false; }
  }
}
