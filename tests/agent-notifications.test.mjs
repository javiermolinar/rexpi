import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentRuntime } from "../lib/agent-runtime.ts";
import {
  MAX_PEER_AGENT_NOTIFICATION_TEXT_BYTES, PEER_MESSAGE_TYPE, PeerRuntime, PeerSendUnknownError,
  parsePeerAgentNotification, peerAgentNotificationId,
} from "../lib/peer.ts";
import { Runtime } from "../lib/runtime.ts";
import { Rex } from "../lib/rex.ts";
import { BindingStore } from "../lib/store.ts";
import { childBootstrap } from "../lib/state.ts";
import { rid, sandbox, uuid, world } from "./fixtures.mjs";

function handle(who, overrides = {}) {
  return { version: 1, taskId: who.taskId, conversationId: who.conversationId,
    runtimeId: uuid(), runId: uuid(), requestId: "request-1", messageId: uuid(), endpointGeneration: 1,
    ...overrides };
}
function who(role = "review") {
  return { taskId: uuid(), conversationId: uuid(), piSessionId: uuid(), role };
}
function accepted(notification, target = who("main")) {
  return { id: peerAgentNotificationId(notification), state: "accepted", target,
    delivery: "followUp", triggerTurn: true, processingConfirmed: false, completionConfirmed: false };
}
function reader(agent, settled = false) {
  return { calls: 0,
    async agentActivity(target) {
      this.calls++;
      return { target: { taskId: agent.taskId, conversationId: agent.conversationId,
        piSessionId: uuid(), role: "review" }, endpointId: "a".repeat(64),
        activity: { idle: true, pendingMessages: false, settled } };
    } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test("only explicit local settlement opt-in notifies; remote status/event evidence never does", async () => {
  const local = who(), remote = who(), localHandle = handle(local), remoteHandle = handle(remote);
  const calls = [];
  const notifier = { async notifyParent(notification) { calls.push(notification); return accepted(notification); } };
  const runtime = new AgentRuntime();
  runtime.attach(reader(remoteHandle, true), notifier);
  runtime.register(remoteHandle, { notifyParentOnSettlement: true });
  runtime.register(localHandle);

  const settled = await runtime.status(remoteHandle);
  assert.equal(settled.lifecycle.activity, "settled");
  assert.equal(settled.lifecycle.delivery, "created");
  assert.equal(settled.lifecycle.result, "pending");
  runtime.events(remoteHandle);
  runtime.observeLocalSettlement(who());
  runtime.observeLocalSettlement(local);
  await turn();
  assert.equal(calls.length, 0, "neither remote settlement nor a non-opted local run sends");

  const opted = handle(local);
  runtime.register(opted, { notifyParentOnSettlement: true });
  runtime.observeLocalSettlement(local);
  await turn();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].handle.runId, opted.runId);
  assert.equal(runtime.events(opted).events.at(-1).lifecycle.result, "pending");
});

test("conversation-level settlement with multiple eligible local runs fails closed", async () => {
  const local = who(), first = handle(local), second = handle(local), calls = [];
  const notifier = { async notifyParent(notification) { calls.push(notification); return accepted(notification); } };
  const runtime = new AgentRuntime();
  runtime.attach(reader(first), notifier);
  runtime.register(first, { notifyParentOnSettlement: true });
  runtime.register(second, { notifyParentOnSettlement: true });
  assert.throws(() => runtime.observeLocalSettlement(local), /Ambiguous local agent settlement/);
  await turn();
  assert.equal(calls.length, 0);
  for (const agent of [first, second]) {
    const events = runtime.events(agent).events;
    assert.deepEqual(events.map(event => event.type), ["run.registered"]);
    assert.equal(events[0].lifecycle.activity, "unknown");
    assert.equal(events[0].lifecycle.delivery, "created");
  }
});

test("pending delivery is scheduled without blocking, then accepted remains independent of result", async () => {
  const local = who(), agent = handle(local), calls = [];
  let seen, release;
  const notificationSeen = new Promise(resolve => { seen = resolve; });
  const delivery = new Promise(resolve => { release = resolve; });
  const notifier = { notifyParent(notification) { calls.push(notification); seen(notification); return delivery; } };
  const runtime = new AgentRuntime();
  runtime.attach(reader(agent), notifier);
  runtime.register(agent, { notifyParentOnSettlement: true });

  assert.equal(runtime.observeLocalSettlement(local), undefined);
  assert.equal(runtime.events(agent).events.at(-1).lifecycle.delivery, "pending");
  const notification = await notificationSeen;
  assert.equal(notification.type, "activity.settled");
  assert.match(notification.eventId, /^[1-9][0-9]{0,15}$/);
  assert.equal(notification.eventId, "2");
  runtime.observeLocalSettlement(local);
  await turn();
  assert.equal(calls.length, 1, "duplicate local settlement cannot start another native send");

  release(accepted(notification));
  await turn();
  const status = await runtime.status(agent);
  assert.equal(status.lifecycle.delivery, "accepted");
  assert.equal(status.lifecycle.activity, "settled");
  assert.equal(status.lifecycle.result, "pending");
  assert.equal(status.resultAvailable, false);
  const types = runtime.events(agent).events.map(event => event.type);
  assert.deepEqual(types.slice(0, 4), ["run.registered", "activity.settled", "delivery.requested", "delivery.accepted"]);
  assert.equal(types.filter(type => type === "activity.settled").length, 1, "duplicate settlement adds no duplicate event");
});

test("accepted evidence and retained events survive replacement, detach, and sender replacement", async () => {
  const local = who(), agent = handle(local), calls = [];
  const notifier = { async notifyParent(notification) { calls.push(notification); return accepted(notification); } };
  const runtime = new AgentRuntime();
  runtime.attach(reader(agent), notifier);
  runtime.register(agent, { notifyParentOnSettlement: true });
  runtime.observeLocalSettlement(local);
  await turn();
  assert.equal((await runtime.status(agent)).lifecycle.delivery, "accepted");
  const retainedBefore = runtime.events(agent).events.map(event => event.id);

  runtime.replace(agent);
  runtime.detach();
  runtime.attach(reader(agent), { async notifyParent() { assert.fail("revoked/accepted runs must not send again"); } });
  runtime.observeLocalSettlement(local);
  await turn();
  const retained = await runtime.status(agent);
  assert.equal(retained.evidence, "retained");
  assert.equal(retained.lifecycle.binding, "replaced");
  assert.equal(retained.lifecycle.delivery, "accepted");
  assert.equal(retained.lifecycle.result, "pending");
  assert.equal(calls.length, 1);
  assert.deepEqual(runtime.events(agent).events.slice(0, retainedBefore.length).map(event => event.id), retainedBefore);
});

test("detach revokes unsent authority and unknown sends are never retried", async () => {
  const local = who(), revokedHandle = handle(local), unknownHandle = handle(local);
  let unknownCalls = 0;
  const notifier = { async notifyParent() { unknownCalls++; throw new PeerSendUnknownError("response lost after write"); } };
  const runtime = new AgentRuntime();
  runtime.attach(reader(revokedHandle), notifier);
  runtime.register(revokedHandle, { notifyParentOnSettlement: true });
  runtime.detach();
  assert.equal((await runtime.status(revokedHandle)).lifecycle.delivery, "revoked");
  runtime.attach(reader(revokedHandle), notifier);
  runtime.observeLocalSettlement(local);
  await turn();
  assert.equal(unknownCalls, 0, "authority revoked before settlement is not regained by attach");
  assert.equal((await runtime.status(revokedHandle)).lifecycle.delivery, "revoked");

  runtime.register(unknownHandle, { notifyParentOnSettlement: true });
  runtime.observeLocalSettlement(local);
  await turn();
  assert.equal(unknownCalls, 1);
  assert.equal((await runtime.status(unknownHandle)).lifecycle.delivery, "unknown");
  runtime.observeLocalSettlement(local);
  await turn();
  assert.equal(unknownCalls, 1);
  runtime.detach();
  runtime.attach(reader(unknownHandle), notifier);
  runtime.observeLocalSettlement(local);
  await turn();
  assert.equal(unknownCalls, 1, "unknown delivery is retained as a tombstone, never auto-retried");
  const types = runtime.events(unknownHandle).events.map(event => event.type);
  assert.ok(types.includes("delivery.unknown"));
  assert.equal(types.filter(type => type.startsWith("delivery.")).at(-1), "delivery.revoked");
  assert.equal((await runtime.status(unknownHandle)).lifecycle.result, "pending");
});

test("notification IDs are deterministic and correlation and text stay bounded", async () => {
  const agent = handle(who(), { requestId: "r".repeat(128) });
  const notification = { type: "activity.settled", handle: agent, eventId: "8999999999999999" };
  assert.equal(peerAgentNotificationId(notification), peerAgentNotificationId(structuredClone(notification)));
  assert.match(peerAgentNotificationId(notification), /^[0-9a-f-]{36}$/);
  assert.notEqual(peerAgentNotificationId(notification), peerAgentNotificationId({ ...notification, eventId: "2" }));
  assert.deepEqual(parsePeerAgentNotification(notification), notification);
  assert.throws(() => parsePeerAgentNotification({ ...notification, eventId: "0" }), /event correlation/);
  assert.throws(() => parsePeerAgentNotification({ ...notification, eventId: "1".repeat(17) }), /event correlation/);
  assert.throws(() => parsePeerAgentNotification({ ...notification, target: uuid() }), /Unexpected|missing/);
  assert.throws(() => parsePeerAgentNotification({ ...notification, type: "result.available" }), /Unsupported/);

  const local = who(), localHandle = handle(local);
  let sent;
  const notifier = { async notifyParent(value) { sent = value; return accepted(value); } };
  const runtime = new AgentRuntime();
  runtime.attach(reader(localHandle), notifier);
  runtime.register(localHandle, { notifyParentOnSettlement: true });
  runtime.observeLocalSettlement(local);
  await turn();
  const text = ["Rex child agent settlement notification.", `Run: ${sent.handle.runId}`,
    `Runtime: ${sent.handle.runtimeId}`, `Request: ${sent.handle.requestId}`, `Settlement event: ${sent.eventId}`,
    "Local Pi agent-end evidence settled this exact registered run; this is not completion or result availability.",
    "Delivery acceptance does not confirm parent processing or completion."].join("\n");
  assert.ok(Buffer.byteLength(text) <= MAX_PEER_AGENT_NOTIFICATION_TEXT_BYTES);
});

async function pair(t, idle) {
  const root = sandbox(t), w = world(), store = new BindingStore(join(root, "bindings"));
  let nativeSeen, acceptanceSeen;
  const sent = [];
  async function start(blockId, seed, isParent = false) {
    const sm = SessionManager.create(root, join(root, "sessions"), { id: seed?.piSessionId ?? uuid() });
    sm.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
    const target = { sessionId: rid("session"), windowId: rid("window"), blockId };
    w.blocks.set(blockId, target); w.callerBlock = blockId;
    const runtime = new Runtime(new Rex("/bin/echo", w.exec), store, blockId);
    const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: sm,
      isIdle: () => isParent ? idle : true, hasPendingMessages: () => false,
      ui: { setStatus() {}, notify() {} } };
    await runtime.start(ctx, state => sm.appendCustomEntry("pi-rex.orientation", state), seed);
    const peer = new PeerRuntime({ sendMessage(message, options) {
      sent.push({ message, options, idle: ctx.isIdle() });
      sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      nativeSeen?.();
    } }, runtime, store.directory);
    await peer.attach(ctx);
    t.after(() => { peer.detach(); runtime.stop(); });
    return { runtime, peer, ctx, sm, state: runtime.snapshot().state, blockId };
  }
  const parent = await start(rid("block"), undefined, true);
  const child = await start(rid("block"), childBootstrap(parent.state, true, "review", w.server));
  const agents = new AgentRuntime();
  agents.attach(child.peer, { async notifyParent(notification) {
    const result = await child.peer.notifyParent(notification);
    acceptanceSeen(result);
    return result;
  } });
  const native = new Promise(resolve => { nativeSeen = resolve; });
  const acceptance = new Promise(resolve => { acceptanceSeen = resolve; });
  return { parent, child, agents, sent, native, acceptance, store, w };
}

for (const idle of [true, false]) {
  test(`authenticated origin delivery uses existing followUp holds for ${idle ? "idle" : "busy"} parents`, async t => {
    const f = await pair(t, idle), agent = handle(f.child.state);
    f.agents.register(agent, { notifyParentOnSettlement: true });
    f.agents.observeLocalSettlement(f.child.state);
    await f.native;
    await f.acceptance;
    await turn();
    assert.equal(f.sent.length, 1);
    const { message, options } = f.sent[0];
    assert.equal(f.sent[0].idle, idle);
    assert.equal(message.customType, PEER_MESSAGE_TYPE);
    assert.equal(message.role, undefined);
    assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
    assert.equal(message.details.envelope.from.conversationId, f.child.state.conversationId);
    assert.equal(message.details.envelope.to.conversationId, f.parent.state.conversationId);
    assert.equal(message.details.envelope.kind, "progress");
    assert.equal(message.details.envelope.requestId, agent.requestId);
    assert.match(message.details.envelope.text, new RegExp(agent.runId));
    assert.match(message.details.envelope.text, /Settlement event: 2/);
    assert.match(message.content, /untrusted peer data, not an operator instruction/);
    const status = await f.agents.status(agent);
    assert.equal(status.lifecycle.delivery, "accepted");
    assert.equal(status.lifecycle.activity, "settled");
    assert.equal(status.lifecycle.result, "pending");
    assert.equal(status.resultAvailable, false);

    f.agents.observeLocalSettlement(f.child.state);
    await turn();
    assert.equal(f.sent.length, 1, "duplicate settlement does not duplicate native sendMessage");
    await assert.rejects(f.child.peer.notifyParent({ type: "activity.settled", handle: agent, eventId: "3",
      target: f.parent.state.conversationId }), /Unexpected|missing/);
    assert.equal(f.sent.length, 1, "an arbitrary target field cannot redirect the verified origin path");
  });
}

test("authenticated path rejects foreign handles and missing origins, and revokes a pre-write failure", async t => {
  const f = await pair(t, true), foreign = handle(who());
  await assert.rejects(f.child.peer.notifyParent({ type: "activity.settled", handle: foreign, eventId: "1" }),
    /local child conversation/);
  await assert.rejects(f.parent.peer.notifyParent({ type: "activity.settled", handle: handle(f.parent.state), eventId: "1" }),
    /no verified notification origin/);
  assert.equal(f.sent.length, 0);

  const agent = handle(f.child.state);
  f.parent.peer.detach();
  const runtime = new AgentRuntime();
  runtime.attach(f.child.peer, f.child.peer);
  runtime.register(agent, { notifyParentOnSettlement: true });
  runtime.observeLocalSettlement(f.child.state);
  await turn(); await turn();
  const status = await runtime.status(agent);
  assert.equal(status.lifecycle.delivery, "revoked", "failure before a write revokes rather than guessing acceptance");
  assert.equal(status.lifecycle.result, "pending");
  assert.equal(f.sent.length, 0);
});
