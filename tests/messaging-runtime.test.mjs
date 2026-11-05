import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { MessagingRuntime, RETURN_TTL_MS } from "../lib/messaging/runtime.ts";
import { FileMailbox } from "../lib/messaging/file-transport.ts";
import { FOLLOWUP_INTENT, FOLLOWUP_CONTEXT, ReceiptLedger } from "../lib/messaging/receipts.ts";
import { digest, endpointFromBinding, makeEnvelope } from "../lib/messaging/protocol.ts";
import { active, binding, identity, rid, server, uuid } from "./fixtures.mjs";

async function setup(t, options = {}) {
  const a = await active(t), sm = SessionManager.create(a.root, join(a.root, "sessions"), { id: "test-session" });
  sm.appendMessage({ role: "user", content: "explicit delegation", timestamp: Date.now() });
  for (const e of a.entries) sm.appendCustomEntry(e.customType, e.data);
  a.ctx.sessionManager = sm;
  const holds = { busy: false, pending: false, editor: "" };
  a.ctx.isIdle = () => !holds.busy;
  a.ctx.hasPendingMessages = () => holds.pending;
  a.ctx.ui.getEditorText = () => holds.editor;
  const own = a.runtime.snapshot(), owner = endpointFromBinding(a.store.find(own.state, own.server));
  const childBinding = binding({ ...identity("review"), taskId: owner.taskId });
  a.store.write(childBinding);
  a.w.blocks.set(childBinding.blockId, { sessionId: a.w.source.sessionId, windowId: rid("window"), blockId: childBinding.blockId });
  const child = endpointFromBinding(childBinding), sent = [], timers = [];
  const pi = {
    appendEntry(type, data) { sm.appendCustomEntry(type, data); options.onAppend?.(a, sm, type, data); },
    sendMessage(message, opts) { options.onSend?.(message, opts); sent.push({ message, opts }); },
  };
  let now = Date.now();
  const m = new MessagingRuntime(pi, a.runtime, a.root, {
    now: () => now,
    setTimer(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    ...options.runtime,
  });
  m.attach(a.ctx);
  t.after(() => m.detach());
  const mailbox = new FileMailbox(a.root, owner, a.store, own.server);
  const f = { ...a, sm, holds, own, owner, childBinding, child, sent, timers, pi, m, mailbox,
    advance(ms) { now += ms; },
    envelope(ticket, overrides = {}) { return { ...makeEnvelope(child, owner, ticket.requestId, "result", "Review finding", undefined,
      { runId: ticket.runId, runtimeId: ticket.runtimeId, inReplyTo: ticket.messageId }), ...overrides }; },
  };
  f.register = async () => {
    const ticket = await m.prepareReturn();
    await m.registerReturn(ticket, child);
    await m.poll(); // Join the initial worker scan before each test publishes.
    return ticket;
  };
  return f;
}
const intents = f => f.sm.getEntries().filter(e => e.customType === FOLLOWUP_INTENT);

test("inert construction/attach/observation and unrelated/progress traffic never wake a model", async t => {
  const f = await setup(t);
  assert.equal(f.timers.length, 0);
  f.mailbox.publish(makeEnvelope(f.child, f.owner, "not-authorized", "result", "not a grant"));
  await f.m.inbox(); f.m.enable(); await f.m.poll();
  assert.equal(f.sent.length, 0); assert.equal(intents(f).length, 0);
  const ticket = await f.register();
  f.mailbox.publish(f.envelope(ticket, { kind: "progress" }));
  await f.m.poll();
  assert.equal(f.sent.length, 0); assert.equal(intents(f).length, 0);
});

test("unrelated and progress traffic skip native peer verification", async t => {
  const f = await setup(t), ticket = await f.register();
  f.mailbox.publish(makeEnvelope(f.child, f.owner, "unrelated", "result", "not authorized"));
  f.mailbox.publish(f.envelope(ticket, { kind: "progress" }));
  f.w.calls.length = 0;
  await f.m.poll();
  assert.equal(f.sent.length, 0);
  assert.equal(f.w.calls.length, 4, "only the owner source check remains");
  assert.equal(f.w.calls.some(args => args.includes("process") && args[args.indexOf("-b") + 1] === f.child.blockId), false);
});

test("questions/results batch once as visible untrusted followUp after actual persisted intent", async t => {
  const f = await setup(t, { onSend(message, opts) {
    const persisted = readFileSync(f.sm.getSessionFile(), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(persisted.at(-1).data, message.details);
    assert.equal(opts.deliverAs, "followUp"); assert.equal(opts.triggerTurn, true);
  } });
  const ticket = await f.register();
  f.mailbox.publish(f.envelope(ticket)); f.mailbox.publish(f.envelope(ticket, { kind: "question", text: "Question?" }));
  await f.m.poll(); await f.m.poll();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].message.display, true);
  assert.equal(f.sent[0].message.customType, FOLLOWUP_CONTEXT);
  assert.match(f.sent[0].message.content, /Untrusted data/);
  assert.match(f.sent[0].message.content, /not an operator instruction/);
  assert.equal(f.sent[0].message.details.receipts.length, 2);
  assert.equal(f.m.snapshot().enqueueRequested, 2); assert.equal(f.m.snapshot().processingConfirmed, false);
  assert.equal(f.mailbox.inbox().messages.length, 2, "no dequeue or deletion");
  for (const e of f.mailbox.inbox().messages) {
    const delivery = f.m.messageDelivery(e.messageId);
    assert.equal(delivery.state, "accepted"); assert.equal(delivery.acceptance, "accepted");
    assert.equal(delivery.delivery, "unknown"); assert.equal(delivery.processing, "unknown");
    assert.equal(delivery.settlement, "unknown");
  }
});

test("busy, pending SDK input, editor text, explicit pending input and extension UI hold dispatch", async t => {
  for (const hold of ["busy", "pending", "editor", "ui", "input"]) {
    const f = await setup(t), ticket = await f.register();
    f.mailbox.publish(f.envelope(ticket));
    if (hold === "ui") f.m.uiPrompt(true);
    else if (hold === "input") f.m.inputPending(true);
    else f.holds[hold] = hold === "editor" ? "unsent user text" : true;
    await f.m.poll();
    assert.equal(f.sent.length, 0, hold); assert.equal(intents(f).length, 0, hold);
    f.m.uiPrompt(false); f.m.inputPending(false);
    Object.assign(f.holds, { busy: false, pending: false, editor: "" });
    await f.m.poll(); assert.equal(f.sent.length, 1, hold);
    const delivery = f.m.messageDelivery(f.mailbox.inbox().messages[0].messageId);
    assert.equal(delivery.state, "accepted", hold); assert.equal(delivery.delivery, "unknown", hold);
    assert.equal(delivery.processing, "unknown", hold); assert.equal(delivery.settlement, "unknown", hold);
  }
});

test("input/UI becoming observable during durable intent confirmation blocks enqueue with no replay", async t => {
  for (const hold of ["busy", "pending", "editor", "ui", "input"]) {
    const f = await setup(t, { onAppend(_a, _sm, type) {
      if (type !== FOLLOWUP_INTENT) return;
      if (hold === "ui") f.m.uiPrompt(true);
      else if (hold === "input") f.m.inputPending(true);
      else f.holds[hold] = hold === "editor" ? "typed" : true;
    } });
    const ticket = await f.register(), e = f.envelope(ticket); f.mailbox.publish(e);
    await assert.rejects(f.m.poll(), /no automatic replay/);
    f.m.uiPrompt(false); f.m.inputPending(false); Object.assign(f.holds, { busy: false, pending: false, editor: "" });
    await f.m.poll(); assert.equal(f.sent.length, 0);
    assert.equal(intents(f).length, 1);
    assert.equal(new ReceiptLedger(f.owner, f.sm, () => {}).inspect(e), "reserved");
  }
});

test("exact request/task/sender/recipient fields are required; stale evidence cannot grant permission", async t => {
  const f = await setup(t), ticket = await f.register();
  const variants = [f.envelope(ticket, { requestId: "wrong-request" })];
  for (const side of ["from", "to"]) for (const [key, value] of Object.entries({
    conversationId: uuid(), piSessionId: uuid(), role: "chat", token: uuid(), pid: process.pid + 1, blockId: rid("block"),
  })) variants.push(f.envelope(ticket, { [side]: { ...(side === "from" ? f.child : f.owner), [key]: value } }));
  const wrongTask = uuid();
  variants.push(f.envelope(ticket, { from: { ...f.child, taskId: wrongTask }, to: { ...f.owner, taskId: wrongTask } }));
  // Namespace must still match. Sender mismatches, stale recipient token/session/PID and task evidence
  // are placed directly in the private fixture, not through live-checked publish.
  f.mailbox.inbox();
  for (const e of variants.filter(e => e.to.conversationId === f.owner.conversationId))
    writeFileSync(join(f.mailbox.directory, e.id + ".json"), JSON.stringify(e), { mode: 0o600 });
  for (let i = 0; i < 3; i++) await f.m.poll();
  assert.equal(f.sent.length, 0); assert.equal(intents(f).length, 0);
});

test("token/PID/session/block replacement, ambiguous binding and missing native Pi block fail closed", async t => {
  for (const mode of ["token", "pid", "session", "block", "competing", "duplicate", "closed", "process"]) {
    const f = await setup(t), ticket = await f.register(); f.mailbox.publish(f.envelope(ticket));
    if (["token", "pid", "session", "block"].includes(mode)) {
      f.store.remove(f.childBinding.conversationId, f.childBinding.token);
      f.store.write({ ...f.childBinding, ...(mode === "token" ? { token: uuid() } : mode === "pid" ? { pid: process.pid + 1 }
        : mode === "session" ? { piSessionId: uuid() } : { blockId: rid("block") }) });
    }
    if (mode === "competing") f.store.write(binding(identity(), { blockId: f.child.blockId }));
    if (mode === "duplicate") f.store.write({ ...f.childBinding, token: uuid(), blockId: rid("block") });
    if (mode === "closed") f.w.blocks.delete(f.child.blockId);
    if (mode === "process") f.w.processPids.set(f.child.blockId, process.pid + 1);
    await f.m.poll(); assert.equal(f.sent.length, 0, mode); assert.equal(intents(f).length, 0, mode);
  }
});

test("binding, server/host, owner runtime and persisted session changes block future scheduling", async t => {
  for (const mode of ["owner-token", "runtime", "pi-session", "server", "host", "file"]) {
    const f = await setup(t), ticket = await f.register(); f.mailbox.publish(f.envelope(ticket));
    if (mode === "owner-token") {
      f.store.remove(f.owner.conversationId, f.owner.token);
      const b = binding(f.own.state, { blockId: f.owner.blockId }); f.store.write(b);
    }
    if (mode === "runtime") f.runtime.stop();
    if (mode === "pi-session") f.sm.getSessionId = () => "different-session";
    if (mode === "file") f.sm.getSessionFile = () => join(f.root, "another.jsonl");
    if (mode === "server") f.w.server.instanceId = uuid();
    if (mode === "host") f.w.server.hostId = uuid();
    await f.m.poll().catch(() => {});
    assert.equal(f.sent.length, 0, mode);
  }
});

test("revalidation after intent rejects changed peer owner and server", async t => {
  for (const mode of ["peer", "owner", "server", "branch", "abort", "off", "expiry"]) {
    const f = await setup(t, { onAppend(_a, _sm, type) {
      if (type !== FOLLOWUP_INTENT) return;
      if (mode === "peer") f.store.remove(f.child.conversationId, f.child.token);
      if (mode === "owner") f.store.remove(f.owner.conversationId, f.owner.token);
      if (mode === "server") f.w.server.instanceId = uuid();
      if (mode === "branch") f.sm.branch(f.sm.getEntries()[0].id);
      if (mode === "abort") f.m.settled(true);
      if (mode === "off") f.m.disable();
      if (mode === "expiry") f.advance(RETURN_TTL_MS);
    } });
    const ticket = await f.register(); f.mailbox.publish(f.envelope(ticket));
    await assert.rejects(f.m.poll(), undefined, mode);
    assert.equal(f.sent.length, 0, mode);
  }
});

test("branch navigation revokes memory permissions; all-branch persisted intents suppress duplicate IDs", async t => {
  const f = await setup(t), ticket = await f.register(), before = f.sm.getLeafId(), e = f.envelope(ticket);
  f.mailbox.publish(e); await f.m.poll(); assert.equal(f.sent.length, 1);
  f.sm.branch(before); await f.m.poll(); assert.equal(f.m.snapshot().returnRequests, 0);
  const ledger = new ReceiptLedger(f.owner, f.sm, () => {});
  assert.equal(ledger.inspect(e), "reserved");
  assert.equal(ledger.inspect({ ...e, requestId: "new-request" }), "conflict");
  assert.equal(ledger.inspect({ ...e, text: "conflict" }), "conflict");
});

test("TTL, issued-ticket identity, generation/epoch and 32 active requests are bounded", async t => {
  const f = await setup(t), tickets = [];
  for (let i = 0; i < 32; i++) tickets.push(await f.m.prepareReturn());
  await assert.rejects(f.m.prepareReturn(), /32/);
  assert.throws(() => f.m.checkReturn({ ...tickets[0] }), /Stale/);
  f.advance(RETURN_TTL_MS); assert.throws(() => f.m.checkReturn(tickets[0]));
  assert.equal(f.m.snapshot().returnRequests, 0);
  const ticket = await f.m.prepareReturn(); f.m.revokeReturns();
  await assert.rejects(f.m.registerReturn(ticket, f.child));
  const ticket2 = await f.m.prepareReturn(); f.m.detach(); f.m.attach(f.ctx);
  await assert.rejects(f.m.registerReturn(ticket2, f.child));
});

test("last-ticket revocation and expiry stop the worker without disabling observation", async t => {
  const f = await setup(t), ticket = await f.register();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.timers.length, 1);
  f.m.revokeReturn(ticket);
  assert.equal(f.timers[0].cleared, true);
  assert.equal(f.m.snapshot().enabled, true);
  const next = await f.m.prepareReturn(); await f.m.registerReturn(next, f.child); await f.m.poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.timers.length, 2);
  f.advance(RETURN_TTL_MS);
  assert.equal(f.m.snapshot().returnRequests, 0);
  assert.equal(f.timers[1].cleared, true);
  assert.equal(f.m.snapshot().enabled, true);
});

test("one-ticket revocation, duplicate registration and wrong child routes cannot broaden permission", async t => {
  const f = await setup(t), first = await f.m.prepareReturn(), second = await f.m.prepareReturn();
  for (const child of [{ ...f.child, taskId: uuid() }, { ...f.child, hostId: uuid() },
    { ...f.child, serverInstance: uuid() }, { ...f.child, blockId: f.owner.blockId },
    { ...f.child, conversationId: f.owner.conversationId }, { ...f.child, token: uuid() }])
    await assert.rejects(f.m.registerReturn(first, child));
  assert.equal(f.m.snapshot().enabled, false);
  f.m.revokeReturn({ ...first }); f.m.checkReturn(first);
  f.m.revokeReturn(first); assert.throws(() => f.m.checkReturn(first));
  await f.m.registerReturn(second, f.child); await f.m.poll();
  await assert.rejects(f.m.registerReturn(second, f.child), /already registered/);
  f.mailbox.publish(f.envelope(second)); await f.m.poll(); assert.equal(f.sent.length, 1);
});

test("prepare fails closed before launch for unflushed/corrupt/missing storage and changed server", async t => {
  for (const mode of ["missing", "corrupt", "unflushed", "server"]) {
    const f = await setup(t);
    if (mode === "missing") f.sm.getSessionFile = () => undefined;
    if (mode === "corrupt") writeFileSync(f.sm.getSessionFile(), "bad\n");
    if (mode === "unflushed") f.ctx.sessionManager = SessionManager.create(f.root, join(f.root, "empty"), { id: "test-session" });
    if (mode === "missing" || mode === "unflushed") f.m.attach(f.ctx);
    if (mode === "server") f.w.server.instanceId = uuid();
    await assert.rejects(f.m.prepareReturn(), undefined, mode);
    assert.equal(f.m.snapshot().returnRequests, 0, mode); assert.equal(f.sent.length, 0);
  }
});

test("each request spends at most sixteen actionable attempts; page cursor reaches beyond quiet head", async t => {
  const f = await setup(t), ticket = await f.register();
  // Deterministic lexical UUIDs: the first sixteen entries are unrelated/quiet.
  for (let i = 1; i <= 36; i++) f.mailbox.publish(f.envelope(ticket, {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    messageId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    requestId: i <= 16 ? "unrelated" : ticket.requestId,
    kind: i <= 16 ? "progress" : "result",
  }));
  await f.m.poll(); assert.equal(f.sent.length, 0);
  await f.m.poll(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].message.details.receipts.length, 16);
  for (let i = 0; i < 6; i++) await f.m.poll();
  assert.equal(f.sent.length, 1); assert.equal(f.m.snapshot().attempted, 16);
});

test("128KiB batch bound makes progress across subsequent pages", async t => {
  const f = await setup(t), ticket = await f.register();
  for (let i = 0; i < 6; i++) f.mailbox.publish(f.envelope(ticket, { text: "x".repeat(30000) }));
  await f.m.poll(); await f.m.poll();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent.reduce((n, s) => n + s.message.details.receipts.length, 0), 6);
});

test("append failure, persisted corruption and throwing void enqueue retain intent/attempt fences", async t => {
  for (const mode of ["append", "corrupt", "enqueue"]) {
    const f = await setup(t, {
      onAppend(_a, sm, type) {
        if (type !== FOLLOWUP_INTENT) return;
        if (mode === "append") throw Error("append result unknown");
        if (mode === "corrupt") writeFileSync(sm.getSessionFile(), "corrupt\n");
      },
      onSend() { if (mode === "enqueue") throw Error("SDK outcome unknown"); },
    });
    const ticket = await f.register(); f.mailbox.publish(f.envelope(ticket));
    await assert.rejects(f.m.poll(), /no automatic replay/); await f.m.poll();
    assert.equal(f.sent.length, 0, mode); assert.equal(f.m.snapshot().attempted, 1);
    assert.equal(f.m.snapshot().processingConfirmed, false);
  }
});

test("off, observed abort, settled abort and detach revoke without retracting accepted SDK requests", async t => {
  for (const mode of ["off", "signal", "settled", "detach"]) {
    const f = await setup(t), ticket = await f.register(); f.mailbox.publish(f.envelope(ticket));
    await f.m.poll(); assert.equal(f.sent.length, 1);
    if (mode === "off") f.m.disable();
    if (mode === "signal") {
      const c = new AbortController(); f.ctx.signal = c.signal; f.m.observeRun(f.ctx); c.abort();
    }
    if (mode === "settled") f.m.settled(true);
    if (mode === "detach") { f.m.detach(); f.m.attach(f.ctx); }
    f.mailbox.publish(f.envelope(ticket)); f.m.enable(); await f.m.poll();
    assert.equal(f.sent.length, 1, mode); assert.equal(f.m.snapshot().returnRequests, 0, mode);
  }
});

test("restart has no saved permission, and a crash-after-intent cannot replay on a new fresh request", async t => {
  const f = await setup(t), ticket = await f.register(), e = f.envelope(ticket);
  f.mailbox.publish(e); await f.m.poll();
  f.m.detach();
  const restarted = new MessagingRuntime(f.pi, f.runtime, f.root, { setTimer: () => ({ unref() {} }), clearTimer() {} });
  t.after(() => restarted.detach()); restarted.attach(f.ctx); restarted.enable(); await restarted.poll();
  assert.equal(f.sent.length, 1); assert.equal(restarted.snapshot().returnRequests, 0);
  const next = await restarted.prepareReturn(); await restarted.registerReturn(next, f.child); await restarted.poll();
  // A logical ID reused with the next request is a conflict, not a new delivery.
  const modified = { ...e, requestId: next.requestId };
  writeFileSync(join(f.mailbox.directory, e.id + ".json"), JSON.stringify(modified));
  await restarted.poll(); assert.equal(f.sent.length, 1);
});

test("poll calls serialize and conflicting duplicate IDs cannot enter a batch", async t => {
  let f, reads = 0;
  const setupResult = await setup(t, { runtime: { mailbox: () => ({
    page() { reads++; return { messages: f?.e ? [f.e, { ...f.e, text: "conflict" }] : [] }; }, publish() { throw Error("unused"); },
  }) } }); f = setupResult;
  const ticket = await f.register(); f.e = f.envelope(ticket);
  const a = f.m.poll(), b = f.m.poll(); assert.equal(a, b); await a;
  assert.equal(f.sent.length, 0); assert.equal(intents(f).length, 0); assert.ok(reads >= 1);
});

test("server replacement during an import's native peer check cannot schedule", async t => {
  const f = await setup(t), ticket = await f.register(); f.mailbox.publish(f.envelope(ticket));
  f.w.onTerminalData = block => { if (block === f.child.blockId) f.w.server.instanceId = uuid(); };
  await f.m.poll(); assert.equal(f.sent.length, 0); assert.equal(intents(f).length, 0);
});

test("send uses local file transport once and validates exact live recipient", async t => {
  const f = await setup(t), params = { to: f.child, requestId: "explicit-send", runId: uuid(), runtimeId: uuid(),
    inReplyTo: uuid(), kind: "result", text: "findings", id: uuid() };
  const result = await f.m.send(params); assert.equal(result.state, "queued");
  assert.equal(result.delivery.state, "accepted"); assert.equal(result.delivery.delivery, "unknown");
  assert.equal(result.delivery.processing, "unknown"); assert.equal(result.delivery.settlement, "unknown");
  const inbox = new FileMailbox(f.root, f.child, f.store, f.own.server).inbox();
  assert.equal(inbox.messages.length, 1); assert.equal(inbox.messages[0].id, params.id);
  assert.equal(digest(inbox.messages[0]), digest(makeEnvelope(f.owner, f.child, params.requestId, params.kind, params.text, params.id,
    { runId: params.runId, runtimeId: params.runtimeId, inReplyTo: params.inReplyTo })));
  assert.equal((await f.m.send(params)).state, "queued", "same runtime returns cached outcome, not a second publication");
  assert.equal(f.sent.length, 0, "transport send never wakes the sender's model");
});

test("pending sends are fenced by abort/off/branch revocation even without a tool signal", async t => {
  for (const mode of ["abort", "off", "branch"]) {
    let publications = 0;
    const f = await setup(t, { runtime: { mailbox: () => ({ page: () => ({ messages: [] }), publish(e) {
      publications++; return { id: e.id, state: "queued", durability: "file-and-inbox-fsync" };
    } }) } });
    const params = { to: f.child, requestId: "explicit-send", runId: uuid(), runtimeId: uuid(),
      inReplyTo: uuid(), kind: "result", text: "finding", id: uuid() };
    f.w.onTerminalData = block => {
      if (block !== f.child.blockId) return;
      if (mode === "abort") f.m.settled(true);
      if (mode === "off") f.m.disable();
      if (mode === "branch") f.m.revokeReturns();
    };
    await assert.rejects(f.m.send(params), /lifecycle authority changed/);
    f.w.onTerminalData = undefined;
    await assert.rejects(f.m.send(params), /lifecycle authority changed/, "cached rejection never republishes");
    assert.equal(publications, 0, mode);
  }
});

test("send verifies owned source/peer, bounds envelopes and never retries unknown logical IDs", async t => {
  let publications = 0;
  const f = await setup(t, { runtime: { mailbox: () => ({ page: () => ({ messages: [] }), publish(e) {
    publications++; return { id: e.id, state: "unknown", durability: "unknown" };
  } }) } });
  const params = { to: f.child, requestId: "explicit-send", runId: uuid(), runtimeId: uuid(),
    inReplyTo: uuid(), kind: "result", text: "finding", id: uuid() };
  const a = await f.m.send(params), b = await f.m.send(params);
  assert.deepEqual(a, b); assert.equal(publications, 1);
  assert.equal(a.delivery.state, "unknown"); assert.equal(a.delivery.delivery, "unknown");
  assert.equal(f.m.messageDelivery(params.id).state, "unknown");
  await assert.rejects(f.m.send({ ...params, text: "conflict" }), /Conflicting/);
  assert.throws(() => f.m.send({ ...params, id: uuid(), text: "x".repeat(33000) }));
  f.store.remove(f.child.conversationId, f.child.token);
  await assert.rejects(f.m.send({ ...params, id: uuid() })); assert.equal(publications, 1);
});

test("replies cannot expand request, run, runtime, parent message, route or generation scope", async t => {
  const f = await setup(t), ticket = await f.register(), accepted = f.envelope(ticket);
  f.mailbox.publish(accepted); await f.m.poll(); assert.equal(f.sent.length, 1);
  assert.equal(f.mailbox.publish({ ...accepted, at: accepted.at + 1 }).state, "duplicate");
  await f.m.poll(); assert.equal(f.sent.length, 1, "an exact retry adds no SDK work");
  const fresh = changes => {
    const id = uuid(); return f.envelope(ticket, { id, messageId: id, ...changes });
  };
  for (const changes of [{ requestId: "other-authorized-scope" }, { runId: uuid() }, { runtimeId: uuid() },
    { inReplyTo: uuid() }, { inReplyTo: null }]) f.mailbox.publish(fresh(changes));
  assert.throws(() => f.mailbox.publish({ ...accepted, requestId: "expanded-scope" }), /different content/);
  await f.m.poll(); await f.m.poll();
  assert.equal(f.sent.length, 1); assert.equal(intents(f).length, 1);
  assert.equal(f.m.snapshot().attempted, 1, "unauthorized correlation is not an attempted reply");
  f.m.detach(); f.m.attach(f.ctx); f.m.enable();
  f.mailbox.publish(f.envelope(ticket)); await f.m.poll();
  assert.equal(f.sent.length, 1, "a stale runtime/generation cannot rearm the original reply");
});
