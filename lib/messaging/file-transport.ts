import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  opendirSync, readSync, rmdirSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { BindingStore } from "../store.ts";
import { uuid, type Server } from "../state.ts";
import { assertLiveEndpoint, decodeEnvelope, digest, endpoint, sameEndpoint, MAX_BATCH, MAX_BATCH_BYTES,
  MAX_ENVELOPE_BYTES, type Endpoint, type Envelope } from "./protocol.ts";

export const DEFAULT_LIMITS = Object.freeze({ entries: 1000, bytes: 32 * 1024 * 1024, scan: 1002 });
type Limits = typeof DEFAULT_LIMITS;
export type Phase = "locked" | "written" | "beforePublish" | "published" | "synced";
export interface TransportOptions {
  limits?: Partial<Limits>;
  /** Synchronous deterministic fault-injection seam for tests; never grants authority. */
  checkpoint?: (phase: Phase) => void;
}
export interface SendResult {
  id: string; state: "queued" | "duplicate" | "unknown";
  durability: "file-and-inbox-fsync" | "observed-existing" | "unknown";
}
export class MailboxError extends Error {
  readonly code: "unsafe" | "busy" | "capacity" | "conflict";
  constructor(code: MailboxError["code"], message: string) { super(message); this.code = code; }
}
const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const unsafe = () => new MailboxError("unsafe", "Unsafe or changed mailbox storage");
function privateDirectory(s: Stats): void {
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o700) throw unsafe();
}
function privateFile(s: Stats): void {
  if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o600) throw unsafe();
}

/** Path checks detect substitution, not a sandbox against actively racing same-UID code (see design note). */
class PathGuard {
  private pins = new Map<string, Stats>();
  readonly directory: string;
  readonly boundary: string;
  constructor(directory: string, boundary: string) { this.directory = directory; this.boundary = boundary; this.check(true); }
  check(create = false): void {
    let current = parse(this.directory).root;
    for (const part of this.directory.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      let s: Stats;
      try { s = lstatSync(current); } catch (error) {
        if (!create || !missing(error)) throw error;
        try { mkdirSync(current, { mode: 0o700 }); } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        s = lstatSync(current);
      }
      if (!s.isDirectory() || s.isSymbolicLink()) throw unsafe();
      if (current === this.boundary || current.startsWith(this.boundary + sep)) privateDirectory(s);
      else if ((s.uid !== 0 && s.uid !== process.getuid?.())
          || ((s.mode & 0o022) !== 0 && !(s.uid === 0 && (s.mode & 0o1000)))) throw unsafe();
      const old = this.pins.get(current);
      if (old && !sameInode(old, s)) throw unsafe();
      this.pins.set(current, s);
    }
  }
}

/** Local storage primitive. Binding evidence is not user permission or native process verification. */
export class FileMailbox {
  readonly directory: string;
  readonly recipient: Endpoint;
  private readonly boundary: string;
  private readonly limits: Limits;
  private readonly store: BindingStore;
  private readonly server: Server;
  private readonly options: TransportOptions;
  constructor(agentDirectory: string, recipient: Endpoint, store: BindingStore,
      server: Server, options: TransportOptions = {}) {
    this.store = store; this.server = server; this.options = options;
    this.recipient = endpoint(recipient);
    this.boundary = join(resolve(agentDirectory), "pi-rex");
    this.directory = join(this.boundary, "messages", this.recipient.serverInstance, this.recipient.conversationId, "inbox");
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const key of ["entries", "bytes", "scan"] as const) {
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > DEFAULT_LIMITS[key])
        throw new Error("Mailbox limits may only lower positive hard maxima");
    }
  }
  private live(e: Endpoint): void { assertLiveEndpoint(e, this.store, this.server); }
  private admission<T>(work: (guard: PathGuard) => T): T {
    const guard = new PathGuard(this.directory, this.boundary), lock = join(this.directory, ".admission");
    guard.check();
    try { mkdirSync(lock, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        privateDirectory(lstatSync(lock));
        throw new MailboxError("busy", "Mailbox admission busy; inspect stale locks, never steal or automatically retry a send");
      }
      throw error;
    }
    const owned = lstatSync(lock); privateDirectory(owned);
    try { guard.check(); this.options.checkpoint?.("locked"); return work(guard); }
    finally {
      guard.check(); const current = lstatSync(lock); privateDirectory(current);
      if (!sameInode(current, owned)) throw unsafe();
      rmdirSync(lock); // Only the exact empty directory created by this operation.
    }
  }
  private scan(guard: PathGuard): Array<{ name: string; stat: Stats }> {
    guard.check();
    const dir = opendirSync(this.directory), entries: Array<{ name: string; stat: Stats }> = [];
    let scanned = 0, bytes = 0;
    try {
      for (let item; (item = dir.readSync()) !== null;) {
        if (++scanned > this.limits.scan) throw new MailboxError("capacity", "Mailbox scan bound exceeded");
        if (item.name === ".admission") continue;
        guard.check(); const stat = lstatSync(join(this.directory, item.name)); privateFile(stat);
        entries.push({ name: item.name, stat }); bytes += stat.size;
        if (entries.length > this.limits.entries || bytes > this.limits.bytes)
          throw new MailboxError("capacity", "Mailbox capacity exceeded; no data evicted");
      }
    } finally { dir.closeSync(); }
    guard.check(); return entries.sort((a, b) => a.name.localeCompare(b.name));
  }
  private read(name: string, expected: Stats, guard: PathGuard, exactRecipient = true): Envelope {
    guard.check(); const path = join(this.directory, name);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd); privateFile(before);
      if (!sameInode(expected, before) || before.size > MAX_ENVELOPE_BYTES) throw unsafe();
      const buffer = Buffer.alloc(MAX_ENVELOPE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const n = readSync(fd, buffer, length, buffer.length - length, length);
        if (!n) break;
        length += n;
      }
      const after = fstatSync(fd), named = lstatSync(path); privateFile(after); privateFile(named);
      if (length > MAX_ENVELOPE_BYTES || length !== before.size || !sameInode(before, after) || !sameInode(after, named)
          || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw unsafe();
      guard.check();
      const e = decodeEnvelope(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
      if (name !== e.id + ".json" || e.to.serverInstance !== this.recipient.serverInstance
          || e.to.conversationId !== this.recipient.conversationId
          || (exactRecipient && !sameEndpoint(e.to, this.recipient))) throw unsafe();
      return e;
    } finally { closeSync(fd); }
  }
  publish(value: Envelope): SendResult {
    const envelope = decodeEnvelope(JSON.stringify(value)), body = Buffer.from(JSON.stringify(envelope));
    if (!sameEndpoint(envelope.to, this.recipient)) throw new Error("Wrong mailbox recipient");
    this.live(envelope.from); this.live(envelope.to);
    let publicationAttempted = false;
    try {
      return this.admission(guard => {
        const entries = this.scan(guard), name = envelope.id + ".json";
        const existing = entries.find(e => e.name === name);
        if (existing) {
          const prior = this.read(name, existing.stat, guard);
          if (digest(prior) !== digest(envelope)) throw new MailboxError("conflict", "Logical message ID has different content");
          this.live(envelope.from); this.live(envelope.to);
          return { id: envelope.id, state: "duplicate", durability: "observed-existing" };
        }
        if (entries.length >= this.limits.entries || entries.reduce((n, e) => n + e.stat.size, 0) + body.length > this.limits.bytes)
          throw new MailboxError("capacity", "Mailbox full; no data evicted");
        guard.check();
        const temporary = join(this.directory, ".tmp-" + randomUUID()), destination = join(this.directory, name);
        const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const owned = fstatSync(fd);
        let closed = false;
        try {
          privateFile(owned);
          let written = 0;
          while (written < body.length) {
            const n = writeSync(fd, body, written, body.length - written);
            if (!n) throw new Error("Mailbox write made no progress");
            written += n;
          }
          this.options.checkpoint?.("written"); fsyncSync(fd); closeSync(fd); closed = true;
          guard.check(); this.live(envelope.from); this.live(envelope.to);
          this.options.checkpoint?.("beforePublish"); guard.check();
          const prepared = lstatSync(temporary); privateFile(prepared);
          if (!sameInode(prepared, owned) || prepared.size !== body.length) throw unsafe();
          publicationAttempted = true;
          linkSync(temporary, destination); // Atomic, same filesystem, refuses any existing destination.
          this.options.checkpoint?.("published"); guard.check();
          const stable = lstatSync(destination), temp = lstatSync(temporary);
          if (!sameInode(stable, owned) || !sameInode(temp, owned) || stable.nlink !== 2) throw unsafe();
          unlinkSync(temporary);
          privateFile(lstatSync(destination));
          const directoryFd = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
          try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
          this.options.checkpoint?.("synced"); guard.check();
          this.live(envelope.from); this.live(envelope.to);
          return { id: envelope.id, state: "queued", durability: "file-and-inbox-fsync" };
        } finally {
          if (!closed) closeSync(fd);
          // After publication uncertainty, retain evidence. Never remove unknown or stable files.
          if (!publicationAttempted) {
            guard.check();
            const current = lstatSync(temporary); privateFile(current);
            if (!sameInode(current, owned)) throw unsafe();
            unlinkSync(temporary);
          }
        }
      });
    } catch (error) {
      if (publicationAttempted) return { id: envelope.id, state: "unknown", durability: "unknown" };
      throw error;
    }
  }
  /**
   * Read-only namespace inspection, including stale recipient-binding evidence. Never permission.
   * Runtime import must still validate the ENTIRE recipient and sender against current ownership.
   * Cursor is an exclusive logical UUID, not a filename/path. At end callers wrap to undefined.
   * The bounded directory scan remains unchanged; only one bounded page of bodies is decoded.
   */
  page(after?: string): { messages: Envelope[]; next?: string } {
    if (after !== undefined && !uuid(after)) throw new Error("Invalid mailbox cursor");
    return this.admission(guard => {
      const entries = this.scan(guard), messages: Envelope[] = [];
      let bytes = 0;
      for (const entry of entries) {
        if (!entry.name.endsWith(".json") || !uuid(entry.name.slice(0, -5))
            || (after !== undefined && entry.name.localeCompare(after + ".json") <= 0)) continue;
        if (entry.stat.size > MAX_ENVELOPE_BYTES) throw unsafe();
        if (messages.length >= MAX_BATCH || bytes + entry.stat.size > MAX_BATCH_BYTES)
          return { messages, next: messages.at(-1)!.id };
        messages.push(this.read(entry.name, entry.stat, guard, false)); bytes += entry.stat.size;
      }
      return { messages };
    });
  }
  /** Non-destructive bounded inspection; sender liveness is intentionally not required for old evidence. */
  inbox(): { messages: Envelope[]; truncated: boolean; entries: number } {
    return this.admission(guard => {
      const entries = this.scan(guard), messages: Envelope[] = [];
      let bytes = 0, truncated = false;
      for (const entry of entries) {
        if (!entry.name.endsWith(".json") || !uuid(entry.name.slice(0, -5))) continue;
        if (messages.length >= MAX_BATCH || bytes + entry.stat.size > MAX_BATCH_BYTES) { truncated = true; break; }
        const envelope = this.read(entry.name, entry.stat, guard);
        messages.push(envelope); bytes += entry.stat.size;
      }
      return { messages, truncated, entries: entries.length };
    });
  }
}
