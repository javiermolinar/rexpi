import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync, fork } from "node:child_process";
import { join } from "node:path";
import { FileMailbox } from "../lib/messaging/file-transport.ts";
import { acceptedMessageDelivery } from "../lib/messaging/delivery.ts";
import { assertLiveEndpoint, decodeEnvelope, digest, endpointFromBinding, makeEnvelope, MAX_ENVELOPE_BYTES } from "../lib/messaging/protocol.ts";
import { BindingStore } from "../lib/store.ts";
import { binding, identity, sandbox, server, uuid, rid } from "./fixtures.mjs";

function setup(t, options = {}) {
  const root = sandbox(t), bindings = join(root, "bindings"), store = new BindingStore(bindings);
  const toBinding = binding(), fromBinding = binding({ ...identity("review"), taskId: toBinding.taskId });
  store.write(toBinding); store.write(fromBinding);
  const to = endpointFromBinding(toBinding), from = endpointFromBinding(fromBinding);
  const envelope = makeEnvelope(from, to, "request-1", "result", "Reviewed findings");
  const mailbox = new FileMailbox(root, to, store, server, options);
  return { root, bindings, store, toBinding, fromBinding, to, from, envelope, mailbox };
}
const file = w => join(w.mailbox.directory, w.envelope.id + ".json");
function child(w, overrides = {}, onPhase) {
  return new Promise((resolve, reject) => {
    const p = fork(new URL("./messaging-writer.mjs", import.meta.url), [JSON.stringify({
      root: w.root, bindings: w.bindings, envelope: w.envelope, server, ...overrides,
    })], { silent: true });
    let result, stderr = "";
    p.stderr.on("data", x => { stderr += x; });
    p.on("message", m => { if (m.phase) onPhase?.(m.phase); else result = m; });
    p.on("error", reject);
    p.on("exit", code => code && code !== 17 ? reject(new Error(stderr || `child exit ${code}`)) : resolve({ ...result, exit: code }));
  });
}

test("strict protocol, canonical digest and exact local related endpoints", t => {
  const w = setup(t), e = w.envelope;
  assert.deepEqual(decodeEnvelope(JSON.stringify(e)), e);
  assert.equal(digest({ ...e, at: e.at + 1 }), digest(e));
  const reordered = Object.fromEntries(Object.entries(e).reverse());
  reordered.from = Object.fromEntries(Object.entries(e.from).reverse());
  assert.equal(digest(reordered), digest(e));
});

test("malformed, oversized and control-shaped envelopes fail before storage", t => {
  const w = setup(t), e = w.envelope;
  const variants = [{ ...e, version: 1 }, { ...e, extra: true }, { ...e, id: "../escape" },
    { ...e, at: -1 }, { ...e, requestId: "../bad request" }, { ...e, kind: "control" }, { ...e, text: "\u001b[31m" },
    { ...e, text: " " }, { ...e, to: { ...e.to, hostId: uuid() } }, { ...e, from: { ...e.from, taskId: uuid() } },
    { ...e, from: { ...e.from, piSessionId: "../escape" } }, { ...e, to: { ...e.to, token: "../escape" } },
    { ...e, from: { ...e.from, blockId: e.to.blockId } }, { ...e, from: { ...e.from, extra: true } },
    { ...e, text: "界".repeat(MAX_ENVELOPE_BYTES) }];
  for (const v of variants) assert.throws(() => w.mailbox.publish(v));
  for (const raw of ["null", "[]", "{", "\"x\"", " ".repeat(MAX_ENVELOPE_BYTES + 1)]) assert.throws(() => decodeEnvelope(raw));
  assert.equal(existsSync(w.mailbox.directory), false);
});

test("messaging endpoints reject non-string roles without changing binding parsers", t => {
  const w = setup(t);
  for (const side of ["from", "to"]) {
    for (const role of [[w.envelope[side].role], [[w.envelope[side].role]], [], null, 1, true, {}]) {
      const bad = { ...w.envelope, [side]: { ...w.envelope[side], role } };
      assert.throws(() => decodeEnvelope(JSON.stringify(bad)), undefined, `${side}: ${JSON.stringify(role)}`);
      assert.throws(() => w.mailbox.publish(bad));
      assert.throws(() => endpointFromBinding({ ...(side === "from" ? w.fromBinding : w.toBinding), role }));
    }
  }
  assert.equal(existsSync(w.mailbox.directory), false);
});

test("inbox rejects stored non-string sender roles and preserves the evidence", t => {
  const w = setup(t); w.mailbox.publish(w.envelope);
  const malformed = JSON.stringify({ ...w.envelope, from: { ...w.from, role: [w.from.role] } });
  writeFileSync(file(w), malformed);
  assert.throws(() => w.mailbox.inbox(), /role/i);
  assert.equal(readFileSync(file(w), "utf8"), malformed);
});

test("private exact layout, stable no-replace publication, duplicate and conflict", t => {
  const w = setup(t);
  assert.equal(w.mailbox.directory, join(w.root, "pi-rex/messages", server.instanceId, w.to.conversationId, "inbox"));
  assert.deepEqual(w.mailbox.publish(w.envelope), { id: w.envelope.id, state: "queued", durability: "file-and-inbox-fsync",
    delivery: acceptedMessageDelivery(w.envelope.messageId, "mailbox-queued") });
  const before = readFileSync(file(w), "utf8"), ino = lstatSync(file(w)).ino;
  assert.equal(lstatSync(file(w)).mode & 0o777, 0o600);
  assert.equal(lstatSync(file(w)).nlink, 1);
  for (const path of ["pi-rex", "pi-rex/messages", `pi-rex/messages/${server.instanceId}`,
    `pi-rex/messages/${server.instanceId}/${w.to.conversationId}`, `pi-rex/messages/${server.instanceId}/${w.to.conversationId}/inbox`])
    assert.equal(lstatSync(join(w.root, path)).mode & 0o777, 0o700);
  assert.equal(w.mailbox.publish({ ...w.envelope, at: 0 }).state, "duplicate");
  assert.throws(() => w.mailbox.publish({ ...w.envelope, text: "conflicting" }), /different content/);
  assert.equal(readFileSync(file(w), "utf8"), before); assert.equal(lstatSync(file(w)).ino, ino);
  assert.deepEqual(w.mailbox.inbox(), { messages: [w.envelope], truncated: false, entries: 1 });
  assert.equal(readFileSync(file(w), "utf8"), before);
});

test("live checks reject token/PID replacement, duplicate conversation and competing pane", t => {
  const w = setup(t);
  assertLiveEndpoint(w.from, w.store, server);
  assert.throws(() => assertLiveEndpoint({ ...w.from, token: uuid() }, w.store, server));
  assert.throws(() => assertLiveEndpoint({ ...w.from, pid: w.from.pid + 1 }, w.store, server));
  assert.throws(() => assertLiveEndpoint(w.from, w.store, { ...server, instanceId: uuid() }));
  w.store.write({ ...w.fromBinding, token: uuid(), blockId: rid("block") });
  assert.throws(() => w.mailbox.publish(w.envelope), /multiple/);
  const other = setup(t);
  other.store.write(binding(identity(), { blockId: other.from.blockId }));
  assert.throws(() => other.mailbox.publish(other.envelope), /competing/);
});

test("temporary and unknown files are retained and counted, but never decoded", t => {
  const w = setup(t); w.mailbox.publish(w.envelope);
  writeFileSync(join(w.mailbox.directory, ".tmp-" + uuid()), "{partial", { mode: 0o600 });
  writeFileSync(join(w.mailbox.directory, "unknown"), "not JSON", { mode: 0o600 });
  assert.equal(w.mailbox.inbox().entries, 3); assert.equal(w.mailbox.inbox().messages.length, 1);
  assert.equal(readdirSync(w.mailbox.directory).length, 3);
});

test("entry, byte, scan and batch limits fail closed without eviction", t => {
  const w = setup(t, { limits: { entries: 1 } }); w.mailbox.publish(w.envelope);
  const id = uuid();
  assert.throws(() => w.mailbox.publish({ ...w.envelope, id, messageId: id }), /full/);
  assert.equal(w.mailbox.publish(w.envelope).state, "duplicate");
  const b = setup(t, { limits: { bytes: 1 } }); assert.throws(() => b.mailbox.publish(b.envelope), /full/);
  const s = setup(t, { limits: { scan: 1 } }); s.mailbox.inbox();
  writeFileSync(join(s.mailbox.directory, "a"), "", { mode: 0o600 });
  assert.throws(() => s.mailbox.inbox(), /scan bound/);
  const many = setup(t);
  for (let i = 0; i < 17; i++) { const id = uuid(); many.mailbox.publish({ ...many.envelope, id, messageId: id }); }
  assert.equal(many.mailbox.inbox().messages.length, 16); assert.equal(many.mailbox.inbox().truncated, true);
  const large = setup(t);
  for (let i = 0; i < 5; i++) { const id = uuid(); large.mailbox.publish({ ...large.envelope, id, messageId: id, text: "x".repeat(30000) }); }
  assert.equal(large.mailbox.inbox().messages.length, 4); assert.equal(large.mailbox.inbox().truncated, true);
  for (const limits of [{ entries: 1001 }, { scan: Infinity }, { bytes: 0 }])
    assert.throws(() => new FileMailbox(w.root, w.to, w.store, server, { limits }));
});

test("bounded cursor pages advance beyond processed/quiet head entries without consuming evidence", t => {
  const w = setup(t);
  const ids = Array.from({ length: 37 }, (_, i) => `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`);
  for (const id of ids) w.mailbox.publish({ ...w.envelope, id, messageId: id });
  const first = w.mailbox.page(), second = w.mailbox.page(first.next), third = w.mailbox.page(second.next);
  assert.deepEqual([first.messages.length, second.messages.length, third.messages.length], [16, 16, 5]);
  assert.deepEqual([...first.messages, ...second.messages, ...third.messages].map(e => e.id), ids);
  assert.equal(third.next, undefined); assert.equal(readdirSync(w.mailbox.directory).length, 37);
  assert.throws(() => w.mailbox.page("../path"), /cursor/);
  assert.equal(w.mailbox.page().messages[0].id, ids[0], "wrap is caller-controlled, never deletion");
});

test("read-only cursor preserves stale recipient bindings but enforces server/conversation namespace", t => {
  const w = setup(t); w.mailbox.publish(w.envelope);
  for (const replacement of [{ token: uuid() }, { piSessionId: uuid() }, { pid: process.pid + 1 }, { taskId: uuid() }]) {
    const to = { ...w.to, ...replacement };
    const reader = new FileMailbox(w.root, to, w.store, server);
    assert.deepEqual(reader.page().messages, [w.envelope], "old endpoint evidence remains visible");
    assert.throws(() => reader.inbox(), /Unsafe/, "legacy exact-recipient inbox remains strict");
    assert.throws(() => reader.publish({ ...w.envelope, to }), undefined, "read relaxation never authorizes send");
  }
  for (const to of [{ ...w.to, conversationId: uuid() }, { ...w.to, serverInstance: uuid() }]) {
    writeFileSync(file(w), JSON.stringify({ ...w.envelope, to, from: { ...w.from, serverInstance: to.serverInstance } }));
    assert.throws(() => w.mailbox.page(), /Unsafe/);
  }
  assert.equal(readdirSync(w.mailbox.directory).length, 1, "no purge or migration");
});

test("unsafe files, symlinks, hardlinks, nonregular files and malformed JSON are refused", t => {
  for (const attack of ["symlink", "hardlink", "mode", "directory", "fifo", "malformed", "oversized", "utf8"]) {
    const w = setup(t); w.mailbox.publish(w.envelope);
    if (attack === "mode") chmodSync(file(w), 0o644);
    else if (attack === "hardlink") linkSync(file(w), join(w.root, "outside-link"));
    else {
      rmSync(file(w));
      if (attack === "symlink") symlinkSync(join(w.root, "target"), file(w));
      if (attack === "directory") mkdirSync(file(w), { mode: 0o700 });
      if (attack === "fifo") execFileSync("mkfifo", [file(w)]);
      if (attack === "malformed") writeFileSync(file(w), "{", { mode: 0o600 });
      if (attack === "oversized") writeFileSync(file(w), "x".repeat(MAX_ENVELOPE_BYTES + 1), { mode: 0o600 });
      if (attack === "utf8") writeFileSync(file(w), Buffer.from([0xff]), { mode: 0o600 });
    }
    assert.throws(() => w.mailbox.inbox(), undefined, attack);
    assert.throws(() => w.mailbox.publish(w.envelope), undefined, attack);
    assert.equal(existsSync(join(w.mailbox.directory, ".admission")), false);
  }
});

test("ancestor aliases, unsafe private modes and inaccessible storage fail without repair", t => {
  const w = setup(t), alias = join(w.root, "alias"); symlinkSync(w.root, alias);
  assert.throws(() => new FileMailbox(alias, w.to, w.store, server).publish(w.envelope), /Unsafe/);
  mkdirSync(join(w.root, "pi-rex"), { mode: 0o755 });
  assert.throws(() => w.mailbox.publish(w.envelope), /Unsafe/);
  assert.equal(lstatSync(join(w.root, "pi-rex")).mode & 0o777, 0o755);
  const denied = setup(t); mkdirSync(join(denied.root, "pi-rex"), { mode: 0o000 });
  try { assert.throws(() => denied.mailbox.publish(denied.envelope)); }
  finally { chmodSync(join(denied.root, "pi-rex"), 0o700); }
});

test("ancestor ownership rejects foreign UIDs while preserving trusted root/sticky cases", t => {
  const uid = process.getuid(), foreign = uid === 502 ? 503 : 502;
  const original = fs.lstatSync;
  const cases = [
    { owner: foreign, mode: 0o755, allowed: false },
    { owner: foreign, mode: 0o700, allowed: false },
    { owner: foreign, mode: 0o1777, allowed: false },
    { owner: uid, mode: 0o755, allowed: true },
    { owner: uid, mode: 0o777, allowed: false },
    { owner: 0, mode: 0o755, allowed: true },
    { owner: 0, mode: 0o777, allowed: false },
    { owner: 0, mode: 0o1777, allowed: true },
  ];
  for (const { owner, mode, allowed } of cases) {
    const w = setup(t), ancestor = join(w.root, "ancestor"), agent = join(ancestor, "agent");
    mkdirSync(ancestor, { mode: 0o755 }); mkdirSync(agent, { mode: 0o700 });
    const box = new FileMailbox(agent, w.to, w.store, server);
    // Deterministic ownership metadata without host chown/root privileges. Other paths use real stats.
    const mocked = t.mock.method(fs, "lstatSync", (path, ...args) => {
      const stat = original(path, ...args);
      if (path !== ancestor) return stat;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: owner, mode: (stat.mode & ~0o7777) | mode });
    });
    syncBuiltinESMExports();
    try {
      if (allowed) {
        assert.deepEqual(box.inbox(), { messages: [], truncated: false, entries: 0 });
        assert.equal(box.publish(w.envelope).state, "queued");
      } else {
        assert.throws(() => box.inbox(), /Unsafe/, `uid=${owner} mode=${mode.toString(8)}`);
        assert.throws(() => box.publish(w.envelope), /Unsafe/);
        assert.equal(existsSync(join(agent, "pi-rex")), false);
      }
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  }
});

test("failure before publication cleans only the known temporary and lock", t => {
  const w = setup(t, { checkpoint: phase => { if (phase === "written") throw new Error("interrupted"); } });
  assert.throws(() => w.mailbox.publish(w.envelope), /interrupted/);
  assert.deepEqual(readdirSync(w.mailbox.directory), []);
});

test("ancestor replacement before publication is detected; unknown trees are not cleaned", t => {
  let moved;
  const w = setup(t, { checkpoint: phase => {
    if (phase !== "beforePublish") return;
    moved = w.mailbox.directory + "-moved";
    renameSync(w.mailbox.directory, moved); mkdirSync(w.mailbox.directory, { mode: 0o700 });
  } });
  assert.throws(() => w.mailbox.publish(w.envelope), /Unsafe/);
  assert.deepEqual(readdirSync(w.mailbox.directory), []);
  assert.ok(readdirSync(moved).includes(".admission"));
  assert.ok(readdirSync(moved).some(n => n.startsWith(".tmp-")));
});

test("all errors after publication attempt return unknown and do not replay", t => {
  for (const phase of ["published", "synced"]) {
    const w = setup(t, { checkpoint: p => { if (p === phase) throw new Error("lost outcome"); } });
    assert.equal(w.mailbox.publish(w.envelope).state, "unknown");
    assert.ok(existsSync(file(w)));
    assert.equal(decodeEnvelope(readFileSync(file(w), "utf8")).id, w.envelope.id);
    if (phase === "published") { assert.equal(lstatSync(file(w)).nlink, 2); assert.throws(() => w.mailbox.inbox()); }
    else assert.equal(w.mailbox.inbox().messages.length, 1);
  }
});

test("a destination appearing at publication is unknown, never overwritten", t => {
  const w = setup(t, { checkpoint: phase => {
    if (phase === "beforePublish") writeFileSync(file(w), "external evidence", { mode: 0o600, flag: "wx" });
  } });
  assert.equal(w.mailbox.publish(w.envelope).state, "unknown");
  assert.equal(readFileSync(file(w), "utf8"), "external evidence");
  assert.ok(readdirSync(w.mailbox.directory).some(n => n.startsWith(".tmp-")));
});

test("unrecognized data saturates admission and is not deleted", t => {
  const w = setup(t, { limits: { entries: 1 } }); w.mailbox.inbox();
  writeFileSync(join(w.mailbox.directory, "unknown"), "opaque evidence", { mode: 0o600 });
  assert.throws(() => w.mailbox.publish(w.envelope), /full/);
  assert.equal(readFileSync(join(w.mailbox.directory, "unknown"), "utf8"), "opaque evidence");
});

test("concurrent different-ID writers retain all admitted messages", async t => {
  const w = setup(t);
  const outcomes = await Promise.all(Array.from({ length: 4 }, (_, i) => {
    const id = `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`;
    return child(w, { envelope: { ...w.envelope, id, messageId: id } });
  }));
  assert.ok(outcomes.every(r => r.result?.state === "queued" || r.error === "busy"));
  assert.equal(w.mailbox.inbox().messages.length, outcomes.filter(r => r.result?.state === "queued").length);
  assert.ok(w.mailbox.inbox().messages.length > 0);
});

test("concurrent same-ID writers never replace; different IDs obey shared capacity", async t => {
  const w = setup(t);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => child(w, {
    envelope: { ...w.envelope, text: i % 2 ? "other content" : w.envelope.text }, pause: "written",
  })));
  assert.equal(results.filter(r => r.result?.state === "queued").length, 1);
  assert.ok(results.every(r => r.result?.state === "queued" || r.result?.state === "duplicate" || ["busy", "conflict"].includes(r.error)));
  assert.equal(w.mailbox.inbox().messages.length, 1); assert.equal(lstatSync(file(w)).nlink, 1);
  const limited = setup(t, { limits: { entries: 1 } });
  const outcomes = await Promise.all(Array.from({ length: 6 }, (_, i) => {
    const id = `00000000-0000-0000-0000-${String(i + 101).padStart(12, "0")}`;
    return child(limited, { envelope: { ...limited.envelope, id, messageId: id }, limits: { entries: 1 }, pause: "written" });
  }));
  assert.equal(outcomes.filter(r => r.result?.state === "queued").length, 1);
  assert.equal(limited.mailbox.inbox().entries, 1);
});

test("cross-process read/write race cannot expose partial JSON", async t => {
  const w = setup(t); let observed = false;
  const result = await child(w, { pause: "written" }, () => {
    observed = true;
    assert.throws(() => w.mailbox.inbox(), /busy/);
    assert.equal(existsSync(file(w)), false);
  });
  assert.ok(observed); assert.equal(result.result.state, "queued");
  assert.deepEqual(w.mailbox.inbox().messages, [w.envelope]);
});

test("process death before/after publication retains evidence and stale admission", async t => {
  for (const phase of ["written", "published"]) {
    const w = setup(t);
    assert.equal((await child(w, { crash: phase })).exit, 17);
    assert.throws(() => w.mailbox.inbox(), /busy/);
    assert.throws(() => w.mailbox.publish(w.envelope), /busy/);
    const names = readdirSync(w.mailbox.directory);
    assert.ok(names.includes(".admission")); assert.ok(names.some(n => n.startsWith(".tmp-")));
    if (phase === "published") {
      assert.deepEqual(decodeEnvelope(readFileSync(file(w), "utf8")), w.envelope);
      assert.equal(lstatSync(file(w)).nlink, 2);
    } else assert.equal(existsSync(file(w)), false);
  }
});
