import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerMessagingControls } from "../extensions/messaging.ts";
import { MessagingRuntime } from "../lib/messaging/runtime.ts";
import { FileMailbox } from "../lib/messaging/file-transport.ts";
import { endpointFromBinding, makeEnvelope } from "../lib/messaging/protocol.ts";
import { active, binding, identity, rid, uuid } from "./fixtures.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, options = {}) {
  const a = await active(t), sm = SessionManager.create(a.root, join(a.root, "sessions"), { id: "test-session" });
  sm.appendMessage({ role: "user", content: "explicit delegated review", timestamp: Date.now() });
  for (const e of a.entries) sm.appendCustomEntry(e.customType, e.data);
  a.ctx.sessionManager = sm;
  a.ctx.isIdle = () => true; a.ctx.hasPendingMessages = () => false; a.ctx.ui.getEditorText = () => "";
  const notices = [], sent = [], timers = new Set(), commands = new Map(), tools = new Map();
  a.ctx.ui.notify = (text, kind) => notices.push({ text, kind });
  a.ctx.ui.setStatus = a.ctx.ui.setWidget = () => assert.fail("No duplicate Activity or persistent panel");
  const pi = { registerCommand: (name, value) => commands.set(name, value), registerTool: value => tools.set(value.name, value),
    appendEntry: (type, data) => sm.appendCustomEntry(type, data), sendMessage: (...args) => sent.push(args) };
  const m = new MessagingRuntime(pi, a.runtime, a.root, {
    setTimer(callback) { const timer = { callback, unref() {} }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); }, ...options,
  });
  m.attach(a.ctx); t.after(() => m.detach());
  let current = m;
  registerMessagingControls(pi, () => ({ runtime: a.runtime, messaging: current }));
  const own = a.runtime.snapshot(), owner = endpointFromBinding(a.store.find(own.state, own.server));
  const childBinding = binding({ ...identity("review"), taskId: owner.taskId }); a.store.write(childBinding);
  a.w.blocks.set(childBinding.blockId, { sessionId: a.w.source.sessionId, windowId: rid("window"), blockId: childBinding.blockId });
  const child = endpointFromBinding(childBinding), box = new FileMailbox(a.root, owner, a.store, own.server), tickets = new Map();
  return { ...a, m, sm, sent, timers, notices, tools, commands, owner, child, box,
    setCurrent(value) { current = value; },
    async command(action, ctx = a.ctx, signal) {
      const result = await tools.get("rexpi_message_control").execute("control", { action }, signal, undefined, ctx);
      return { text: result.content[0].text, details: result.details };
    },
    inbox(after, signal, verbose = false) { return tools.get("rexpi_message_inbox").execute("inspect", { after, verbose }, signal, undefined, a.ctx); },
    async register() { const ticket = await m.prepareReturn(); tickets.set(ticket.requestId, ticket);
      await m.registerReturn(ticket, child); await m.poll(); await flush(); return ticket; },
    message(requestId, text = "unprocessed finding") { const ticket = tickets.get(requestId);
      return makeEnvelope(child, owner, requestId, "result", text, undefined, ticket
        ? { runId: ticket.runId, runtimeId: ticket.runtimeId, inReplyTo: ticket.messageId } : {}); },
  };
}
function evidence(f) {
  return { session: readFileSync(f.sm.getSessionFile(), "utf8"),
    files: readdirSync(f.box.directory).sort().map(name => [name, readFileSync(join(f.box.directory, name), "utf8")]) };
}

test("observe is observation ONLY even with registered tickets and retained traffic; off revokes and clears timers", async t => {
  const f = await setup(t), ticket = await f.register();
  f.box.publish(f.message(ticket.requestId));
  const before = evidence(f);
  assert.match((await f.command("observe")).text, /observation only/);
  assert.equal(f.m.snapshot().returnRequests, 0);
  await f.m.poll(); await flush();
  assert.equal(f.sent.length, 0); assert.deepEqual(evidence(f), before);
  assert.equal(f.m.snapshot().enabled, true); assert.equal(f.timers.size, 0, "observation without tickets does not poll");
  await f.command("off"); await flush();
  assert.equal(f.m.snapshot().enabled, false); assert.equal(f.timers.size, 0);
  assert.throws(() => f.m.checkReturn(ticket), /Stale/);
  await f.command("observe"); await f.m.poll(); await flush();
  assert.equal(f.sent.length, 0); assert.deepEqual(evidence(f), before);
  // Only a new, separately authorized fresh delegation can restore return authority.
  const next = await f.register(); f.box.publish(f.message(next.requestId));
  await f.m.poll(); assert.equal(f.sent.length, 1);
});

test("status and inbox remain read-only with active tickets; previews sanitize and truncate without raw details", async t => {
  const f = await setup(t), ticket = await f.register();
  const e = f.message(ticket.requestId, "peer\n\t\u202e\u2066" + "x".repeat(2000)); f.box.publish(e);
  const before = evidence(f), snapshot = f.m.snapshot();
  const status = await f.command("status");
  assert.deepEqual(JSON.parse(status.text), snapshot); assert.equal(status.text.includes("peer"), false);
  const result = await f.inbox(), row = result.details.messages[0];
  assert.equal(row.id, e.id); assert.equal(row.preview.length, 512); assert.equal(row.previewTruncated, true);
  assert.doesNotMatch(row.preview, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  assert.equal(row.text, undefined); assert.equal(row.processingConfirmed, false);
  assert.match(result.details.notice, /untrusted peer data/); assert.match(result.details.notice, /original files remain unchanged/i);
  const compact = JSON.parse(result.content[0].text), visible = compact.messages[0];
  assert.equal(visible.id, e.id); assert.equal(visible.preview, row.preview);
  assert.equal(visible.from, undefined); assert.equal(visible.to, undefined); assert.equal(visible.digest, undefined);
  assert.equal(visible.delivery, row.delivery.state); assert.equal(compact.notice, undefined);
  const verbose = await f.inbox(undefined, undefined, true);
  assert.equal(verbose.content[0].text, JSON.stringify(verbose.details, null, 2));
  await f.inbox();
  assert.equal(f.sent.length, 0); assert.deepEqual(f.m.snapshot(), snapshot); assert.deepEqual(evidence(f), before);
  assert.equal(f.timers.size, 1, "inspection does not start or reschedule workers");
});

test("bounded pagination keeps stale, unmatched and unprocessed evidence inspectable without delivery", async t => {
  const f = await setup(t); f.box.page();
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const e = f.message("unmatched-" + i);
    if (i % 2 === 0) e.to = { ...e.to, token: uuid(), pid: process.pid + 1 };
    if (i % 3 === 0) e.from = { ...e.from, token: uuid() };
    writeFileSync(join(f.box.directory, e.id + ".json"), JSON.stringify(e), { mode: 0o600 }); ids.push(e.id);
  }
  const before = evidence(f), first = await f.inbox();
  assert.equal(first.details.messages.length, 16); assert.equal(first.details.truncated, true);
  const second = await f.inbox(first.details.next);
  assert.equal(second.details.messages.length, 4); assert.equal(second.details.truncated, false);
  assert.deepEqual([...first.details.messages, ...second.details.messages].map(e => e.id).sort(), ids.sort());
  assert.ok(first.details.messages.some(e => e.to.token !== f.owner.token));
  assert.equal(f.m.snapshot().enabled, false); assert.equal(f.timers.size, 0); assert.equal(f.sent.length, 0);
  assert.deepEqual(evidence(f), before);
  await assert.rejects(f.inbox("../escape"), /cursor/);
  const c = new AbortController(); c.abort(); await assert.rejects(f.inbox(undefined, c.signal));
});

test("inspection respects byte bounds and preserves unknown/malformed evidence on failure", async t => {
  const f = await setup(t);
  for (let i = 0; i < 6; i++) f.box.publish(f.message("large-" + i, "x".repeat(31000)));
  writeFileSync(join(f.box.directory, "unknown-evidence"), "retain me", { mode: 0o600 });
  const before = evidence(f), first = await f.inbox(), second = await f.inbox(first.details.next);
  assert.equal(first.details.messages.length, 4); assert.equal(second.details.messages.length, 2);
  assert.ok(Buffer.byteLength(first.content[0].text) < 50000);
  assert.deepEqual(evidence(f), before); assert.equal(f.sent.length, 0);
  // Sort first so the malformed file is in this page, not beyond the byte bound.
  const malformed = join(f.box.directory, "00000000-0000-0000-0000-000000000000.json");
  writeFileSync(malformed, '{"bad":"\\u202e' + "x".repeat(2000), { mode: 0o600 });
  const corrupt = evidence(f);
  await assert.rejects(f.inbox(), error => {
    assert.ok(error.message.length <= 512); assert.doesNotMatch(error.message, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u); return true;
  });
  await assert.rejects(f.inbox(), /./);
  assert.deepEqual(evidence(f), corrupt); assert.equal(f.sent.length, 0); assert.equal(f.timers.size, 0);
});

test("async inspection holds concurrent reconciliation but does not consume its cursor or schedule on release", async t => {
  const f = await setup(t), ticket = await f.register(); f.box.publish(f.message(ticket.requestId));
  const before = evidence(f), source = f.runtime.source.bind(f.runtime);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.runtime.source = async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return source(...args); };
  const inspection = f.inbox(); await waiting;
  await f.m.poll(); assert.equal(f.sent.length, 0); assert.deepEqual(evidence(f), before);
  f.runtime.source = source; release(); await inspection; await flush();
  assert.equal(f.sent.length, 0); assert.deepEqual(evidence(f), before);
  // An independent authorized reconciliation may still deliver, exactly once.
  await f.m.poll(); await f.m.poll(); assert.equal(f.sent.length, 1);
});

test("inspection that finishes during an existing native await fences that scan without revoking its ticket", async t => {
  const f = await setup(t), ticket = await f.register(); f.box.publish(f.message(ticket.requestId));
  const before = evidence(f), source = f.runtime.source.bind(f.runtime);
  let release, entered, checks = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.runtime.source = async (...args) => {
    if (++checks === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
    return source(...args);
  };
  const scan = f.m.poll(); await waiting;
  await f.inbox(); release(); await scan; await flush();
  assert.equal(f.sent.length, 0); assert.equal(f.m.snapshot().returnRequests, 1); assert.deepEqual(evidence(f), before);
  f.runtime.source = source;
  await f.m.poll(); assert.equal(f.sent.length, 1, "independent authorized poll can deliver later");
});

test("off and observe fence an already-running scan without deleting retained evidence", async t => {
  for (const command of ["off", "observe"]) {
    const f = await setup(t), ticket = await f.register(); f.box.publish(f.message(ticket.requestId));
    const before = evidence(f), source = f.runtime.source.bind(f.runtime);
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    f.runtime.source = async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return source(...args); };
    const scan = f.m.poll(); await waiting;
    await f.command(command); f.runtime.source = source; release();
    await scan; await flush();
    assert.equal(f.sent.length, 0); assert.equal(f.m.snapshot().returnRequests, 0); assert.deepEqual(evidence(f), before);
    if (command === "off") assert.equal(f.timers.size, 0);
  }
});

test("detach used by reload/shutdown stops timers and never restores tickets on attach", async t => {
  for (const reason of ["reload", "shutdown"]) {
    const f = await setup(t), ticket = await f.register(); f.box.publish(f.message(ticket.requestId));
    const before = evidence(f), callbacks = [...f.timers].map(timer => timer.callback);
    f.m.detach(); assert.equal(f.timers.size, 0, reason);
    for (const callback of callbacks) callback(); await flush();
    f.m.attach(f.ctx); await f.command("observe"); await f.m.poll(); await flush();
    assert.equal(f.sent.length, 0); assert.equal(f.m.snapshot().returnRequests, 0); assert.deepEqual(evidence(f), before);
  }
});

test("controls reject bad input/unavailable runtime, register no panels and do not enable on errors", async t => {
  const f = await setup(t);
  assert.deepEqual([...f.commands.keys()], []);
  assert.deepEqual([...f.tools.keys()], ["rexpi_message_control", "rexpi_message_inbox"]);
  assert.equal(f.tools.get("rexpi_message_inbox").annotations.readOnlyHint, true);
  assert.equal(f.tools.get("rexpi_message_control").executionMode, "sequential");
  assert.deepEqual(f.tools.get("rexpi_message_control").parameters.properties.action.anyOf.map(value => value.const), ["status", "observe", "off"]);
  for (const action of ["replay", "on", "inbox", ""]) {
    await assert.rejects(f.command(action), /Invalid messaging control/);
    assert.equal(f.m.snapshot().enabled, false);
  }
  const changed = { ...f.ctx, sessionManager: { getSessionId: () => "changed" } };
  await assert.rejects(f.command("observe", changed), /conversation changed/);
  await assert.rejects(f.tools.get("rexpi_message_inbox").execute("stale", {}, undefined, undefined, changed), /conversation changed/);
  const c = new AbortController(); c.abort();
  await assert.rejects(f.command("observe", f.ctx, c.signal));
  assert.equal(f.m.snapshot().enabled, false);
  assert.equal(JSON.parse((await f.command("status")).text).enabled, false);
  f.setCurrent(undefined);
  await assert.rejects(f.command("status"), /No verified/); await assert.rejects(f.inbox(), /No verified/);
  assert.equal(f.timers.size, 0); assert.equal(f.sent.length, 0);
  assert.deepEqual(f.notices, [], "model controls return tool evidence, not duplicate notifications");
});
