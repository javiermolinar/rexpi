import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, linkSync, readFileSync, renameSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { ReceiptLedger, FOLLOWUP_INTENT, FOLLOWUP_CONTEXT } from "../lib/messaging/receipts.ts";
import { endpointFromBinding, makeEnvelope } from "../lib/messaging/protocol.ts";
import { binding, identity, sandbox, uuid } from "./fixtures.mjs";

function fixture(t, options = {}) {
  const root = sandbox(t), sm = SessionManager.create(root, join(root, "sessions"));
  if (!options.unflushed) sm.appendMessage({ role: "user", content: "explicit delegated task", timestamp: Date.now() });
  const owner = endpointFromBinding(binding({ ...identity(), piSessionId: sm.getSessionId() }));
  const child = endpointFromBinding(binding({ ...identity("review"), taskId: owner.taskId }));
  const e = makeEnvelope(child, owner, "request", "result", "untrusted findings");
  let active = true;
  const append = (type, data) => sm.appendCustomEntry(type, data);
  const ledger = new ReceiptLedger(owner, sm, options.append ? (type, data) => options.append(sm, type, data) : append, () => active);
  return { root, sm, owner, e, ledger, append, deactivate: () => { active = false; } };
}

test("real Pi append intent is persisted and fsynced before returning; intent is not insertion/processing", async t => {
  const f = fixture(t);
  await f.ledger.confirm();
  assert.equal(f.ledger.inspect(f.e), "new");
  const details = await f.ledger.reserveFollowup([f.e]);
  assert.equal(f.ledger.inspect(f.e), "reserved");
  const lines = readFileSync(f.sm.getSessionFile(), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.at(-1).data, details);
  assert.equal(lines.at(-1).customType, FOLLOWUP_INTENT);
  assert.equal(lines.some(e => e.type === "custom_message"), false);
  f.sm.appendCustomMessageEntry(FOLLOWUP_CONTEXT, "untrusted data", true, details);
  assert.equal(f.ledger.inspect(f.e), "inserted");
  assert.equal("processed" in details, false);
  await assert.rejects(f.ledger.reserveFollowup([f.e]));
});

test("crash after intent suppresses replay in a new ledger, even off-branch and after owner token replacement", async t => {
  const f = fixture(t), parent = f.sm.getLeafId();
  await f.ledger.reserveFollowup([f.e]);
  f.sm.branch(parent);
  assert.equal(f.sm.getBranch().some(e => e.customType === FOLLOWUP_INTENT), false);
  const ledger = new ReceiptLedger({ ...f.owner, token: uuid() }, f.sm, f.append);
  assert.equal(ledger.inspect(f.e), "reserved");
  for (const e of [{ ...f.e, text: "changed" }, { ...f.e, requestId: "another" },
    { ...f.e, to: { ...f.owner, token: uuid() } }, { ...f.e, from: { ...f.e.from, piSessionId: "replacement" } }])
    assert.equal(ledger.inspect(e), "conflict");
  await ledger.confirm();
});

test("unflushed, missing and corrupt storage fail closed; no repair", async t => {
  const unflushed = fixture(t, { unflushed: true });
  await assert.rejects(unflushed.ledger.reserveFollowup([unflushed.e]));
  for (const variant of ["truncated", "garbage", "header", "extra", "duplicate", "partial", "version", "invalid-parent"]) {
    const f = fixture(t), path = f.sm.getSessionFile(), original = readFileSync(path, "utf8");
    let body = original;
    if (variant === "truncated") body = "";
    if (variant === "garbage") body += "not-json\n";
    if (variant === "header") body = body.replace(f.sm.getSessionId(), uuid());
    if (variant === "extra") body += JSON.stringify({ type: "custom", id: "extra", parentId: null, timestamp: "now", customType: "x" }) + "\n";
    if (variant === "duplicate") body += body.trim().split("\n").at(-1) + "\n";
    if (variant === "partial") body += "{";
    if (variant === "version") body = body.replace('"version":3', '"version":2');
    if (variant === "invalid-parent") body = body.replace('"parentId":null', '"parentId":"absent"');
    writeFileSync(path, body);
    await assert.rejects(f.ledger.reserveFollowup([f.e]), undefined, variant);
    assert.equal(f.ledger.inspect(f.e), "reserved", "memory fence on failed reservation");
    assert.equal(readFileSync(path, "utf8"), body);
    writeFileSync(path, original);
    await assert.rejects(f.ledger.reserveFollowup([f.e]), undefined, "no retry after repair");
  }
});

test("append throw/no-op/unflushed/mutated append remain fenced", async t => {
  for (const mode of ["throw", "noop", "memory-only", "mutated"]) {
    const f = fixture(t, { append(sm, type, data) {
      if (mode === "throw") throw new Error("disk failed");
      if (mode === "noop") return;
      if (mode === "mutated") data.receipts[0].requestId = "wrong";
      const path = sm.getSessionFile(), before = readFileSync(path, "utf8");
      sm.appendCustomEntry(type, data);
      if (mode === "memory-only") writeFileSync(path, before);
    } });
    await assert.rejects(f.ledger.reserveFollowup([f.e]), undefined, mode);
    assert.equal(f.ledger.inspect(f.e) === "reserved" || f.ledger.inspect(f.e) === "conflict", true);
    await assert.rejects(f.ledger.reserveFollowup([f.e]));
  }
});

test("exact session path, owner, active generation and abort are mandatory", async t => {
  const f = fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.ledger.reserveFollowup([f.e], controller.signal));
  f.deactivate(); await assert.rejects(f.ledger.confirm());
  const g = fixture(t); g.sm.newSession();
  await assert.rejects(g.ledger.confirm());
  const h = fixture(t), path = h.sm.getSessionFile();
  h.sm.getSessionFile = () => join(h.root, "other.jsonl");
  await assert.rejects(h.ledger.confirm());
  assert.equal(readFileSync(path, "utf8").includes(FOLLOWUP_INTENT), false);
});

test("unsafe session files and oversize histories are rejected without modification", async t => {
  for (const mode of ["symlink", "hardlink", "writable", "oversize", "utf8"]) {
    const f = fixture(t), path = f.sm.getSessionFile();
    if (mode === "symlink") { renameSync(path, path + ".real"); symlinkSync(path + ".real", path); }
    if (mode === "hardlink") linkSync(path, path + ".link");
    if (mode === "writable") chmodSync(path, 0o666);
    if (mode === "oversize") truncateSync(path, 32 * 1024 * 1024 + 1);
    if (mode === "utf8") appendFileSync(path, Buffer.from([0xff, 10]));
    await assert.rejects(f.ledger.confirm(), undefined, mode);
  }
});

test("bounded batches reject progress, wrong recipient, duplicates and bytes beyond 128KiB", async t => {
  const f = fixture(t);
  for (const items of [[], [f.e, f.e], [{ ...f.e, kind: "progress" }],
    [{ ...f.e, to: { ...f.owner, token: uuid() } }],
    Array.from({ length: 17 }, () => { const id = uuid(); return { ...f.e, id, messageId: id }; }),
    Array.from({ length: 5 }, () => { const id = uuid(); return { ...f.e, id, messageId: id, text: "x".repeat(30000) }; })])
    await assert.rejects(f.ledger.reserveFollowup(items));
  assert.equal(f.ledger.inspect(f.e), "new");
});

test("concurrent reservation and abort cannot duplicate scheduling intent", async t => {
  const f = fixture(t);
  const results = await Promise.allSettled([f.ledger.reserveFollowup([f.e]), f.ledger.reserveFollowup([f.e])]);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected"]);
  assert.equal(f.sm.getEntries().filter(e => e.customType === FOLLOWUP_INTENT).length, 1);
  const g = fixture(t), controller = new AbortController();
  const reservation = g.ledger.reserveFollowup([g.e], controller.signal);
  controller.abort(); await assert.rejects(reservation);
  assert.equal(g.ledger.inspect(g.e), "reserved", "uncertain attempt remains memory-fenced");
});

test("ordinary image entries over 1 MiB remain confirmable within the total history bound", async t => {
  const f = fixture(t);
  f.sm.appendMessage({
    role: "toolResult", toolCallId: "image-read", toolName: "read",
    content: [{ type: "text", text: "Read image file [image/png]" },
      { type: "image", data: Buffer.alloc(1024 * 1024, 7).toString("base64"), mimeType: "image/png" }],
    isError: false, timestamp: Date.now(),
  });
  await f.ledger.confirm();
  await f.ledger.reserveFollowup([f.e]);
  assert.equal(f.ledger.inspect(f.e), "reserved");
});

test("in-memory histories over the total byte bound fail before storage confirmation", async t => {
  const f = fixture(t);
  f.sm.getEntries = () => [{ id: "oversized-history", type: "custom", data: "x".repeat(32 * 1024 * 1024) }];
  await assert.rejects(f.ledger.confirm(), /32 MiB/);
});

test("hidden disk-only intent and huge in-memory trees fail closed", async t => {
  const f = fixture(t), path = f.sm.getSessionFile();
  appendFileSync(path, JSON.stringify({ type: "custom", id: "hidden", parentId: f.sm.getLeafId(), timestamp: "now",
    customType: FOLLOWUP_INTENT, data: {} }) + "\n");
  await assert.rejects(f.ledger.confirm(), /differs/);
  const h = fixture(t); h.sm.getEntries = () => new Array(100001);
  assert.throws(() => h.ledger.inspect(h.e), /bound/); await assert.rejects(h.ledger.confirm(), /bound/);
});

test("corrupt receipt records fail closed; a foreign Pi session never grants or suppresses delivery", async t => {
  const f = fixture(t);
  f.sm.appendCustomEntry(FOLLOWUP_INTENT, { version: 1 });
  assert.throws(() => f.ledger.inspect(f.e));
  const g = fixture(t), foreign = { ...g.owner, piSessionId: uuid() };
  const data = { version: 1, owner: foreign, nonce: uuid(), receipts: [{ logicalId: g.e.id, requestId: g.e.requestId,
    runId: g.e.runId, runtimeId: g.e.runtimeId, inReplyTo: g.e.inReplyTo, digest: "0".repeat(64) }] };
  g.sm.appendCustomEntry(FOLLOWUP_INTENT, data);
  assert.equal(g.ledger.inspect(g.e), "new");
  const h = fixture(t);
  h.sm.appendCustomEntry(FOLLOWUP_INTENT, { version: 1, owner: h.owner, nonce: uuid(), receipts: [{
    logicalId: h.e.id, requestId: h.e.requestId, runId: h.e.runId, runtimeId: h.e.runtimeId,
    inReplyTo: h.e.inReplyTo, digest: "0".repeat(64), unexpected: "x".repeat(1024 * 1024),
  }] });
  assert.throws(() => h.ledger.inspect(h.e), /Unexpected or missing follow-up receipt fields/);
});
