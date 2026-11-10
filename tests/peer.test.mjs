import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { SessionManager, AgentSession, SettingsManager, createEventBus, createExtensionRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { PeerRuntime, PEER_MESSAGE_TYPE, decodePeerRequest, historyPage, validatePeerReadResult } from "../lib/peer.ts";
import { registerPeerTools } from "../extensions/peer.ts";
import { Rex } from "../lib/rex.ts";
import { Runtime } from "../lib/runtime.ts";
import { BindingStore } from "../lib/store.ts";
import { childBootstrap } from "../lib/state.ts";
import { endpointFromBinding, makeEnvelope } from "../lib/messaging/protocol.ts";
import { sandbox, world, rid, uuid } from "./fixtures.mjs";

async function pair(t, related = true, hooks = {}) {
  const root = sandbox(t), w = world(), store = new BindingStore(join(root, "bindings"));
  async function start(blockId, seed) {
    const sessionId = seed?.piSessionId ?? uuid(), sm = SessionManager.create(root, join(root, "sessions"), { id: sessionId });
    sm.appendMessage({ role: "user", content: seed ? "child history" : "parent history", timestamp: Date.now() });
    const target = { sessionId: rid("session"), windowId: rid("window"), blockId };
    w.blocks.set(blockId, target); w.callerBlock = blockId;
    const runtime = new Runtime(new Rex("/bin/echo", w.exec), store, blockId);
    const sent = [];
    const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: sm,
      isIdle: () => true, hasPendingMessages: () => false, ui: { setStatus() {}, notify() {} } };
    await runtime.start(ctx, state => sm.appendCustomEntry("pi-rex.orientation", state), seed);
    const peer = new PeerRuntime({ sendMessage(message, options) {
      sent.push({ message, options }); sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      hooks.onSend?.(blockId);
    } }, runtime, store.directory);
    await peer.attach(ctx);
    t.after(() => { peer.detach(); runtime.stop(); });
    const own = runtime.snapshot(), endpoint = endpointFromBinding(store.find(own.state, own.server));
    return { runtime, peer, sm, ctx, sent, endpoint, state: own.state, blockId };
  }
  const parent = await start(rid("block"));
  const seed = childBootstrap(parent.state, related, "review", w.server);
  const child = await start(rid("block"), seed);
  return { root, w, store, parent, child, start };
}
const sendInput = (extra = {}) => ({ id: uuid(), requestId: "peer-task", runId: uuid(), runtimeId: uuid(),
  inReplyTo: null, kind: "question", text: "Review this finding", delivery: "followUp", triggerTurn: true, ...extra });

test("real endpoint pages active in-memory history without model work", async t => {
  const f = await pair(t), ids = [];
  for (let i = 0; i < 5; i++) ids.push(f.child.sm.appendMessage({ role: "user", content: "message " + i, timestamp: Date.now() }));
  const expected = f.child.sm.getBranch().map(entry => entry.id);
  const first = await f.parent.peer.read(f.child.endpoint.conversationId, { limit: 2 });
  assert.equal(first.entries.length, 2); assert.ok(first.next); assert.equal(first.view, "branch");
  assert.deepEqual(first.activity, { idle: true, pendingMessages: false });
  const second = await f.parent.peer.read(f.child.endpoint.conversationId, { limit: 2, cursor: first.next });
  const third = await f.parent.peer.read(f.child.endpoint.conversationId, { limit: 100, cursor: second.next });
  const actual = [...first.entries, ...second.entries, ...third.entries].map(entry => entry.id);
  assert.deepEqual(actual, expected); assert.equal(third.next, undefined);
  assert.ok(ids.every(id => actual.includes(id)));
  const tail = await f.parent.peer.read(f.child.endpoint.conversationId,
    { direction: "tail", limit: 2, textOnly: true });
  assert.deepEqual(tail.entries.map(entry => entry.id), expected.slice(-2));
  assert.ok(tail.entries.every(entry => typeof entry.text === "string" && entry.message === undefined));
  const messageIds = f.child.sm.getBranch().filter(entry => entry.type === "message").map(entry => entry.id);
  const filtered = await f.parent.peer.read(f.child.endpoint.conversationId,
    { types: ["message"], since: expected[0], limit: 100, textOnly: true });
  assert.deepEqual(filtered.entries.map(entry => entry.id), messageIds.slice(1));
  await assert.rejects(f.parent.peer.read(f.child.endpoint.conversationId,
    { direction: "tail", cursor: first.next }), /Stale|mismatched/);
  assert.equal(f.child.sent.length, 0);
});

test("real endpoint text projection clips oversized entries and preserves continuation", async t => {
  const f = await pair(t);
  f.child.sm.appendMessage({ role: "user", content: "🙂".repeat(20_000), timestamp: Date.now() });
  f.child.sm.appendMessage({ role: "user", content: "latest-small", timestamp: Date.now() });
  const first = await f.parent.peer.read(f.child.endpoint.conversationId,
    { direction: "tail", limit: 2, textOnly: true });
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].text, "latest-small"); assert.ok(first.next);
  const rest = await f.parent.peer.read(f.child.endpoint.conversationId,
    { direction: "tail", limit: 100, textOnly: true, cursor: first.next });
  const large = rest.entries.find(entry => entry.textTruncated);
  assert.ok(large); assert.ok(large.text.endsWith("…"));
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 48 * 1024);
  assert.ok(rest.next);
  const older = await f.parent.peer.read(f.child.endpoint.conversationId,
    { direction: "tail", limit: 100, textOnly: true, cursor: rest.next });
  assert.ok(older.entries.every(entry => entry.textTruncated === undefined));
  assert.ok(older.entries.some(entry => entry.text.includes("child history")));
  await assert.rejects(f.parent.peer.read(f.child.endpoint.conversationId, { direction: "tail", limit: 2 }), /exceeds 48 KiB/);
});

test("context view applies compaction while branch view retains raw history", async t => {
  const f = await pair(t);
  f.child.sm.appendMessage({ role: "user", content: "summarized old request", timestamp: Date.now() });
  const kept = f.child.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "kept response" }],
    api: "fixture", provider: "fixture", model: "fixture", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" });
  f.child.sm.appendCompaction("compacted summary", kept, 100);
  const branch = await f.parent.peer.read(f.child.endpoint.conversationId, { limit: 100 });
  const context = await f.parent.peer.read(f.child.endpoint.conversationId, { view: "context", limit: 100 });
  assert.ok(JSON.stringify(branch.entries).includes("summarized old request"));
  assert.equal(JSON.stringify(context.entries).includes("summarized old request"), false);
  assert.ok(JSON.stringify(context.entries).includes("compacted summary"));
  assert.ok(JSON.stringify(context.entries).includes("kept response"));
  assert.equal(f.child.sent.length, 0);
});

test("cursor binds session, leaf and view; oversized entries and pages fail closed", async t => {
  const f = await pair(t);
  f.child.sm.appendMessage({ role: "user", content: "one", timestamp: Date.now() });
  const page = await f.parent.peer.read(f.child.endpoint.conversationId, { limit: 1 });
  f.child.sm.appendMessage({ role: "user", content: "later work", timestamp: Date.now() });
  await assert.rejects(f.parent.peer.read(f.child.endpoint.conversationId, { cursor: page.next }), /Stale|cursor/);
  await assert.rejects(f.parent.peer.read(f.child.endpoint.conversationId, { view: "context", cursor: page.next }), /Stale|cursor/);
  const entry = (id, text) => ({ id, type: "message", message: { role: "user", content: text } });
  assert.throws(() => historyPage([entry("large", "x".repeat(49 * 1024))], "session", "large",
    { view: "branch", limit: 1 }), /exceeds 48 KiB/);
  const paged = historyPage([entry("a", "a".repeat(30 * 1024)), entry("b", "b".repeat(30 * 1024))],
    "session", "b", { view: "branch", limit: 100 });
  assert.equal(paged.entries.length, 1); assert.ok(paged.next);
});

test("tail and since pagination are bounded, ordered, and query-bound", () => {
  const entry = id => ({ id, type: "message", message: { role: "user", content: "text " + id } });
  const entries = ["a", "b", "c", "d", "e", "f"].map(entry);
  const first = historyPage(entries, "session", "f", { view: "branch", direction: "tail", limit: 2 });
  assert.deepEqual(first.entries.map(value => value.id), ["e", "f"]); assert.ok(first.next);
  const second = historyPage(entries, "session", "f", { view: "branch", direction: "tail", limit: 2, cursor: first.next });
  assert.deepEqual(second.entries.map(value => value.id), ["c", "d"]); assert.ok(second.next);
  const third = historyPage(entries, "session", "f", { view: "branch", direction: "tail", limit: 2, cursor: second.next });
  assert.deepEqual(third.entries.map(value => value.id), ["a", "b"]); assert.equal(third.next, undefined);

  const sinceTail = historyPage(entries, "session", "f", { view: "branch", direction: "tail", limit: 2, since: "c" });
  assert.deepEqual(sinceTail.entries.map(value => value.id), ["e", "f"]);
  const sinceTailRest = historyPage(entries, "session", "f",
    { view: "branch", direction: "tail", limit: 2, since: "c", cursor: sinceTail.next });
  assert.deepEqual(sinceTailRest.entries.map(value => value.id), ["d"]); assert.equal(sinceTailRest.next, undefined);
  const sinceHead = historyPage(entries, "session", "f", { view: "branch", limit: 2, since: "c" });
  assert.deepEqual(sinceHead.entries.map(value => value.id), ["d", "e"]);
  assert.deepEqual(historyPage(entries, "session", "f",
    { view: "branch", limit: 2, since: "c", cursor: sinceHead.next }).entries.map(value => value.id), ["f"]);

  for (const change of [{ direction: "head" }, { since: "a" }, { types: ["message", "custom"] }, { textOnly: true }, { view: "context" }])
    assert.throws(() => historyPage(entries, "session", "f",
      { view: "branch", direction: "tail", limit: 2, ...change, cursor: first.next }), /Stale|mismatched/);
  assert.throws(() => historyPage(entries, "session", "f", { view: "branch", limit: 2, since: "missing" }), /since/);
  assert.throws(() => historyPage(entries, "session", "f", { view: "branch", limit: 2, cursor: "not-base64-json" }), /cursor encoding|JSON|Unexpected|token/i);
  assert.throws(() => historyPage(entries, "session", "f",
    { view: "branch", direction: "tail", limit: 2, cursor: first.next + "$" }), /cursor encoding/);
});

test("type filters and text projection preserve entry identity and raw-view behavior", () => {
  const entries = [
    { id: "a", type: "message", message: { role: "user", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] } },
    { id: "b", type: "custom", customType: "state", data: { secret: false } },
    { id: "c", type: "custom_message", content: [{ type: "text", text: "custom text" }] },
    { id: "d", type: "compaction", summary: "summary text" },
    { id: "e", type: "branch_summary", summary: "branch text" },
  ];
  const projected = historyPage(entries, "session", "e", { view: "branch", limit: 100, textOnly: true });
  assert.deepEqual(projected.entries, [
    { id: "a", type: "message", text: "hello world" }, { id: "b", type: "custom", text: "" },
    { id: "c", type: "custom_message", text: "custom text" }, { id: "d", type: "compaction", text: "summary text" },
    { id: "e", type: "branch_summary", text: "branch text" },
  ]);
  assert.equal(projected.bytes, projected.entries.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0));
  const filtered = historyPage(entries, "session", "e",
    { view: "branch", limit: 100, types: ["custom_message", "message"], textOnly: true });
  assert.deepEqual(filtered.entries.map(value => value.id), ["a", "c"]); assert.deepEqual(filtered.types, ["custom_message", "message"]);
  const raw = historyPage(entries, "session", "e", { view: "branch", limit: 100 });
  assert.deepEqual(raw.entries, entries); assert.equal(raw.textOnly, false);
});

test("oversized text projections are bounded, marked, and recoverable while raw reads stay strict", () => {
  const entry = (id, text) => ({ id, type: "message", message: { role: "user", content: text } });
  const entries = [entry("huge", "🙂".repeat(20_000)), entry("small", "small")];
  const first = historyPage(entries, "session", "small", { view: "branch", limit: 1, textOnly: true });
  assert.equal(first.entries[0].textTruncated, true);
  assert.ok(first.entries[0].text.endsWith("…"));
  assert.ok(Buffer.byteLength(JSON.stringify(first.entries[0])) <= 48 * 1024);
  assert.ok(first.next);
  const second = historyPage(entries, "session", "small",
    { view: "branch", limit: 1, textOnly: true, cursor: first.next });
  assert.deepEqual(second.entries, [{ id: "small", type: "message", text: "small" }]);
  assert.equal(second.next, undefined);
  assert.throws(() => historyPage(entries, "session", "small", { view: "branch", limit: 1 }), /exceeds 48 KiB/);
});

test("projection byte bounds include JSON escaping for quotes, slashes, and controls", () => {
  const entry = (id, text) => ({ id, type: "message", message: { role: "user", content: text } });
  const page = historyPage([entry("escapes", '"\\\n\0'.repeat(20_000))], "session", "escapes",
    { view: "branch", limit: 1, textOnly: true });
  assert.equal(page.entries[0].textTruncated, true);
  assert.ok(page.entries[0].text.endsWith("…"));
  assert.ok(Buffer.byteLength(JSON.stringify(page.entries[0])) <= 48 * 1024);
});

test("tail byte bounds continue backward without merging oversized pages", () => {
  const entry = (id, text) => ({ id, type: "message", message: { role: "user", content: text } });
  const entries = [entry("a", "a".repeat(30 * 1024)), entry("b", "b".repeat(30 * 1024))];
  const tail = historyPage(entries, "session", "b", { view: "branch", direction: "tail", limit: 100 });
  assert.deepEqual(tail.entries.map(value => value.id), ["b"]); assert.ok(tail.next);
  const rest = historyPage(entries, "session", "b", { view: "branch", direction: "tail", limit: 100, cursor: tail.next });
  assert.deepEqual(rest.entries.map(value => value.id), ["a"]); assert.equal(rest.next, undefined);
  const text = historyPage(entries, "session", "b", { view: "branch", direction: "tail", limit: 1, textOnly: true });
  assert.equal(text.entries[0].text, "b".repeat(30 * 1024)); assert.ok(text.next);
});

test("peer read wire validation accepts bounded queries and rejects malformed filters", () => {
  const from = endpointFromBinding({ version: 1, taskId: uuid(), conversationId: uuid(), piSessionId: uuid(), role: "main",
    serverInstance: uuid(), hostId: uuid(), blockId: rid("block"), token: uuid(), pid: process.pid, expiresAt: Date.now() + 1000 });
  const to = { ...from, conversationId: uuid(), blockId: rid("block") };
  const request = params => JSON.stringify({ type: "pi-rex.peer", version: 1, id: uuid(), op: "read", from, to, params });
  assert.equal(decodePeerRequest(request({ direction: "tail", since: "entry", types: ["message"], textOnly: true })).params.direction, "tail");
  for (const params of [{ direction: "newest" }, { since: "" }, { types: ["message", "message"] },
    { types: Array.from({ length: 17 }, (_, i) => "type" + i) }, { types: ["bad type"] },
    { textOnly: "yes" }, { limit: 0 }, { unknown: true }])
    assert.throws(() => decodePeerRequest(request(params)), /Invalid conversation|Unexpected/);
});

test("conversation responses enforce exact metadata, requested limits, bytes, entries, cursors and activity", () => {
  const target = uuid(), identity = { taskId: uuid(), conversationId: target, piSessionId: uuid(), role: "main" };
  const raw = { id: "a", type: "message", message: { role: "user", content: "a" } };
  const paged = historyPage([raw, { ...raw, id: "b" }], "session", "b", { view: "branch", limit: 1 });
  const valid = { target: identity, ...paged, activity: { idle: true, pendingMessages: false } };
  assert.deepEqual(validatePeerReadResult(valid, { limit: 1 }, target), valid);
  const invalid = [
    result => { result.entries = []; },
    result => { result.bytes = 0; },
    result => { result.sessionId = "not a session"; },
    result => { result.activity.idle = "yes"; },
    result => { result.notice = "forged"; },
    result => { result.next = result.next.replace(/.$/, "x"); },
  ];
  for (const mutate of invalid) {
    const result = structuredClone(valid); mutate(result);
    assert.throws(() => validatePeerReadResult(result, { limit: 1 }, target), /conversation|Invalid|Stale|mismatched|Unexpected|JSON|Expected/i);
  }
  const filtered = historyPage([raw, { ...raw, id: "b" }], "session", "b", { view: "branch", limit: 1, types: ["message"] });
  const wrongType = { target: identity, ...filtered, activity: { idle: true, pendingMessages: false } };
  wrongType.entries = [{ id: "a", type: "custom", data: "not requested" }];
  wrongType.bytes = Buffer.byteLength(JSON.stringify(wrongType.entries[0]));
  assert.throws(() => validatePeerReadResult(wrongType, { limit: 1, types: ["message"] }, target), /type filter/);
  const filteredText = historyPage([raw, { ...raw, id: "b" }], "session", "b",
    { view: "branch", limit: 1, types: ["message"], textOnly: true });
  const wrongTextType = { target: identity, ...filteredText, activity: { idle: true, pendingMessages: false } };
  wrongTextType.entries = [{ id: "a", type: "custom", text: "not requested" }];
  wrongTextType.bytes = Buffer.byteLength(JSON.stringify(wrongTextType.entries[0]));
  assert.throws(() => validatePeerReadResult(wrongTextType, { limit: 1, types: ["message"], textOnly: true }, target), /type filter/);
  const noncanonical = structuredClone(valid); noncanonical.next += "$";
  assert.throws(() => validatePeerReadResult(noncanonical, { limit: 1 }, target), /cursor encoding/);
  const oversized = { ...valid, entries: [{ id: "large", type: "custom", data: "x".repeat(49 * 1024) }], next: undefined };
  delete oversized.next;
  assert.throws(() => validatePeerReadResult(oversized, { limit: 1 }, target), /exceeds 48 KiB/);
  const text = { ...valid, textOnly: true,
    entries: [{ id: "a", type: "message", text: "a", extra: true }] };
  assert.throws(() => validatePeerReadResult(text, { limit: 1, textOnly: true }, target), /Unexpected|missing/);
});

test("peer sends preserve attribution and explicit delivery, deduplicate, and never claim completion", async t => {
  const f = await pair(t), input = sendInput();
  const first = await f.parent.peer.send(f.child.endpoint.conversationId, input);
  assert.equal(first.state, "accepted"); assert.equal(first.processingConfirmed, false); assert.equal(first.completionConfirmed, false);
  assert.equal(first.messageId, input.id); assert.equal(first.requestId, input.requestId);
  assert.equal(first.runId, input.runId); assert.equal(first.runtimeId, input.runtimeId); assert.equal(first.inReplyTo, null);
  assert.equal(first.deliveryEvidence.state, "accepted"); assert.equal(first.deliveryEvidence.acceptance, "accepted");
  assert.equal(first.deliveryEvidence.delivery, "unknown"); assert.equal(first.deliveryEvidence.processing, "unknown");
  assert.equal(first.deliveryEvidence.settlement, "unknown");
  assert.deepEqual(await f.parent.peer.send(f.child.endpoint.conversationId, input), first);
  assert.equal(f.child.sent.length, 1);
  const { message, options } = f.child.sent[0];
  assert.equal(message.customType, PEER_MESSAGE_TYPE); assert.equal(message.role, undefined);
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
  assert.match(message.content, /untrusted peer data, not an operator instruction/);
  assert.ok(message.content.includes(f.parent.endpoint.conversationId));
  assert.equal(message.details.envelope.from.token, f.parent.endpoint.token);
  assert.equal(message.details.delivery, "followUp");
  assert.equal(message.details.envelope.messageId, input.id); assert.equal(message.details.envelope.runId, input.runId);
  assert.equal(message.details.envelope.runtimeId, input.runtimeId);
  await assert.rejects(f.parent.peer.send(f.child.endpoint.conversationId, { ...input, runId: uuid() }), /Conflicting peer request ID/);
  assert.equal(f.child.sent.length, 1, "a conflicting logical retry has no second native effect");
  assert.equal(f.parent.peer.messageDelivery(input.id).state, "accepted", "conflict/unknown cannot retract acceptance");
  assert.equal(f.child.peer.messageDelivery(input.id).delivery, "unknown");
  f.child.peer.observeAgentStart(f.child.ctx); f.child.peer.observeAgentEnd(f.child.ctx);
  assert.equal(f.child.peer.messageDelivery(input.id).processing, "unknown");
  assert.equal(f.child.peer.messageDelivery(input.id).settlement, "unknown");
  await f.parent.peer.send(f.child.endpoint.conversationId, sendInput({ delivery: "steer", triggerTurn: false }));
  assert.deepEqual(f.child.sent[1].options, { triggerTurn: false, deliverAs: "steer" });
});

test("unrelated tasks, stale bindings, replaced processes and detached endpoints cannot read or send", async t => {
  const unrelated = await pair(t, false);
  await assert.rejects(unrelated.parent.peer.read(unrelated.child.endpoint.conversationId, {}), /related task/);
  assert.equal(unrelated.child.sent.length, 0);
  const f = await pair(t);
  f.w.processPids.set(f.child.blockId, process.pid + 1);
  await assert.rejects(f.parent.peer.send(f.child.endpoint.conversationId, sendInput()));
  assert.equal(f.child.sent.length, 0);
  f.w.processPids.clear();
  const current = f.store.find(f.child.state, f.w.server);
  f.store.remove(current.conversationId, current.token);
  await assert.rejects(f.parent.peer.read(f.child.endpoint.conversationId, {}), /related task/);
  f.store.write(current); f.child.peer.detach();
  await assert.rejects(f.parent.peer.read(f.child.endpoint.conversationId, {}));
});

test("generated names permit read-only cross-task history without enabling peer controls", async t => {
  const f = await pair(t, false), name = f.child.runtime.snapshot().name;
  await assert.rejects(f.parent.peer.read(f.child.endpoint.conversationId, {}), /related task/);
  const page = await f.parent.peer.read(name, { direction: "tail", limit: 10, textOnly: true });
  assert.equal(page.target.conversationId, f.child.endpoint.conversationId);
  assert.ok(page.entries.some(entry => entry.text.includes("child history")));
  assert.equal(f.child.sent.length, 0);
  await assert.rejects(f.parent.peer.send(name, sendInput()), /conversation ID or generated agent name/);
  const tools = new Map();
  registerPeerTools({ registerTool: tool => tools.set(tool.name, tool) },
    () => ({ runtime: f.parent.runtime, peer: f.parent.peer }));
  const toolRead = await tools.get("rexpi_read_conversation").execute("named-read",
    { target: name.toUpperCase(), direction: "tail", limit: 1, textOnly: true }, undefined, undefined, f.parent.ctx);
  assert.equal(toolRead.details.target.conversationId, f.child.endpoint.conversationId);
  f.child.peer.detach(); f.child.runtime.stop();
  await assert.rejects(f.parent.peer.read(name, {}), /not uniquely live|Unknown|stale/i);
});

test("target branch navigation fences the old endpoint instead of reading a replaced view", async t => {
  const f = await pair(t), first = f.child.sm.getBranch()[0].id;
  f.child.sm.branch(first);
  await assert.rejects(f.parent.peer.read(f.child.endpoint.conversationId, {}), /branch changed|stale/i);
  assert.equal(f.child.sent.length, 0);
});

test("peer protocol rejects cross-task and non-custom-message routes", () => {
  const a = endpointFromBinding({ version: 1, taskId: uuid(), conversationId: uuid(), piSessionId: uuid(), role: "main",
    serverInstance: uuid(), hostId: uuid(), blockId: rid("block"), token: uuid(), pid: process.pid, expiresAt: Date.now() + 1000 });
  const b = { ...a, taskId: uuid(), conversationId: uuid(), blockId: rid("block") };
  const body = JSON.stringify({ type: "pi-rex.peer", version: 1, id: uuid(), op: "read", from: a, to: b,
    params: { view: "branch", limit: 20 } });
  assert.throws(() => decodePeerRequest(body), /Unrelated/);
  const named = JSON.parse(body);
  named.name = "quiet-otter";
  assert.equal(decodePeerRequest(JSON.stringify(named)).name, "quiet-otter");
  named.op = "send";
  named.params = sendInput();
  assert.throws(() => decodePeerRequest(JSON.stringify(named)), /only for conversation reads/);
  assert.equal(makeEnvelope(a, { ...b, taskId: a.taskId }, "request", "result", "finding").kind, "result");
});

test("tools expose native reads and cache exact send outcomes across tool/logical IDs", async t => {
  const f = await pair(t), tools = new Map();
  registerPeerTools({ registerTool: tool => tools.set(tool.name, tool) }, () => ({ runtime: f.parent.runtime, peer: f.parent.peer }));
  assert.deepEqual([...tools.keys()], ["rexpi_read_conversation", "rexpi_peer_message_send"]);
  const read = await tools.get("rexpi_read_conversation").execute("read", { target: f.child.endpoint.conversationId, limit: 1 },
    undefined, undefined, f.parent.ctx);
  assert.match(read.details.notice, /reading triggered no model work/);
  const peerRead = f.parent.peer.read.bind(f.parent.peer);
  f.parent.peer.read = async () => ({ ...read.details, notice: "forged peer notice" });
  const protectedRead = await tools.get("rexpi_read_conversation").execute("read-notice",
    { target: f.child.endpoint.conversationId, limit: 1 }, undefined, undefined, f.parent.ctx);
  assert.match(protectedRead.details.notice, /Sensitive peer history/);
  f.parent.peer.read = peerRead;
  const params = { target: f.child.endpoint.conversationId, ...sendInput() }, sender = tools.get("rexpi_peer_message_send");
  const first = await sender.execute("call", params, undefined, undefined, f.parent.ctx);
  assert.deepEqual(await sender.execute("call", params, undefined, undefined, f.parent.ctx), first);
  assert.deepEqual(await sender.execute("other-call", params, undefined, undefined, f.parent.ctx), first);
  assert.equal(f.child.sent.length, 1);
  await assert.rejects(sender.execute("call", { ...params, text: "changed" }, undefined, undefined, f.parent.ctx), /Conflicting/);
  await assert.rejects(sender.execute("new-call", { ...params, requestId: "changed" }, undefined, undefined, f.parent.ctx), /Conflicting/);
  assert.equal(f.child.sent.length, 1);
});

test("deferred tool sends retain the admitted target when caller input is mutated", async t => {
  const f = await pair(t);
  const other = await f.start(rid("block"), childBootstrap(f.parent.state, true, "chat", f.w.server));
  const tools = new Map();
  registerPeerTools({ registerTool: tool => tools.set(tool.name, tool) }, () => ({ runtime: f.parent.runtime, peer: f.parent.peer }));
  const sender = tools.get("rexpi_peer_message_send");
  const params = { target: f.child.endpoint.conversationId, ...sendInput() };
  const pending = sender.execute("admitted-target", params, undefined, undefined, f.parent.ctx);
  params.target = other.endpoint.conversationId;
  const result = await pending;
  assert.equal(result.details.target.conversationId, f.child.endpoint.conversationId);
  assert.equal(f.child.sent.length, 1); assert.equal(other.sent.length, 0);
  await assert.rejects(sender.execute("mutated-target", params, undefined, undefined, f.parent.ctx), /Conflicting peer send ID/);
  assert.equal(other.sent.length, 0);
});

test("aggregate send byte bounds fail before native preflight", async t => {
  const f = await pair(t), nativeCalls = f.w.calls.length;
  await assert.rejects(f.parent.peer.send(f.child.endpoint.conversationId, sendInput({ text: "x".repeat(32768) })),
    /Envelope exceeds 32 KiB/);
  await assert.rejects(f.parent.peer.send(f.child.endpoint.conversationId, sendInput({ text: "💩".repeat(16000) })),
    /Peer request exceeds 40 KiB/);
  assert.equal(f.w.calls.length, nativeCalls); assert.equal(f.child.sent.length, 0);
});

test("largest fitting ASCII and multibyte sends succeed and one more unit fails", async t => {
  const f = await pair(t);
  const fits = (text, id) => {
    try { makeEnvelope(f.parent.endpoint, f.child.endpoint, "peer-task", "question", text, id); return true; }
    catch { return false; }
  };
  for (const [unit, maximum] of [["x", 32768], ["💩", 16000]]) {
    const id = uuid(); let low = 0, high = maximum;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(unit.repeat(middle), id)) low = middle; else high = middle - 1;
    }
    assert.ok(low > 0 && low < maximum);
    await f.parent.peer.send(f.child.endpoint.conversationId, sendInput({ id, text: unit.repeat(low) }));
    await assert.rejects(f.parent.peer.send(f.child.endpoint.conversationId, sendInput({ text: unit.repeat(low + 1) })),
      /Envelope exceeds 32 KiB/);
  }
  assert.equal(f.child.sent.length, 2);
});

test("logical accepted outcomes survive source peer replacement without new native work", async t => {
  const f = await pair(t), tools = new Map(); let current = { runtime: f.parent.runtime, peer: f.parent.peer };
  registerPeerTools({ registerTool: tool => tools.set(tool.name, tool) }, () => current);
  const sender = tools.get("rexpi_peer_message_send"), params = { target: f.child.endpoint.conversationId, ...sendInput() };
  const first = await sender.execute("before-replacement", params, undefined, undefined, f.parent.ctx);
  f.parent.peer.detach();
  const replacement = new PeerRuntime({ sendMessage() { assert.fail("Unexpected parent delivery"); } }, f.parent.runtime, f.store.directory);
  await replacement.attach(f.parent.ctx); current = { runtime: f.parent.runtime, peer: replacement };
  t.after(() => replacement.detach());
  f.child.peer.detach();
  const nativeCalls = f.w.calls.length;
  assert.deepEqual(await sender.execute("after-replacement", params, undefined, undefined, f.parent.ctx), first);
  assert.equal(f.w.calls.length, nativeCalls); assert.equal(f.child.sent.length, 1);
  await assert.rejects(sender.execute("fresh-after-replacement", { ...params, id: uuid() }, undefined, undefined, f.parent.ctx),
    /related task|stale|binding|socket/i);
});

test("read snapshots do not consume the bounded send deduplication history", { timeout: 15000 }, async t => {
  const f = await pair(t);
  for (let i = 0; i < 1025; i++)
    assert.equal((await f.parent.peer.read(f.child.endpoint.conversationId, { limit: 1 })).entries.length, 1);
  await f.parent.peer.send(f.child.endpoint.conversationId, sendInput());
  assert.equal(f.child.sent.length, 1);
});

test("a lost response after custom-message insertion reports and deduplicates an unknown send", async t => {
  let f;
  f = await pair(t, true, { onSend: block => { if (block === f.child.blockId) f.child.peer.detach(); } });
  const tools = new Map();
  registerPeerTools({ registerTool: tool => tools.set(tool.name, tool) }, () => ({ runtime: f.parent.runtime, peer: f.parent.peer }));
  const sender = tools.get("rexpi_peer_message_send"), params = { target: f.child.endpoint.conversationId, ...sendInput() };
  const first = await sender.execute("unknown", params, undefined, undefined, f.parent.ctx)
    .then(() => assert.fail("Lost response must not report acceptance"), error => error);
  assert.match(first.message, /outcome may be unknown/i);
  assert.equal(f.parent.peer.messageDelivery(params.id).state, "unknown");
  assert.equal(f.parent.peer.messageDelivery(params.id).acceptance, "unknown");
  assert.equal(f.parent.peer.messageDelivery(params.id).delivery, "unknown");
  await assert.rejects(sender.execute("unknown-inspection", params, undefined, undefined, f.parent.ctx), error => error === first);
  assert.equal(f.child.sent.length, 1);
});

test("target replacement after acceptance reports unknown without retracting the message", async t => {
  const f = await pair(t); let checks = 0;
  f.w.onTerminalData = async (block, method) => {
    if (block === f.child.blockId && method === "process" && ++checks === 2)
      f.w.processPids.set(f.child.blockId, process.pid + 1);
  };
  const input = sendInput();
  await assert.rejects(f.parent.peer.send(f.child.endpoint.conversationId, input), /outcome may be unknown/i);
  assert.equal(f.child.sent.length, 1);
  assert.equal(f.parent.peer.messageDelivery(input.id).state, "unknown");
  assert.equal(f.parent.peer.messageDelivery(input.id).delivery, "unknown");
});

test("source detachment during native verification fences an unsent request", async t => {
  const f = await pair(t); let release;
  const entered = new Promise(resolve => { f.w.onTerminalData = async block => {
    if (block === f.child.blockId) { resolve(); await new Promise(done => { release = done; }); }
  }; });
  const input = sendInput(), pending = f.parent.peer.send(f.child.endpoint.conversationId, input);
  await entered; f.parent.peer.detach(); release();
  await assert.rejects(pending, /session|conversation|aborted|changed/i);
  assert.equal(f.child.sent.length, 0);
  assert.equal(f.parent.peer.messageDelivery(input.id).state, "unknown");
  assert.equal(f.parent.peer.messageDelivery(input.id).observations.length, 0, "pre-write failure is not post-write uncertainty");
});

function peerSocketPath(f, endpoint) {
  const digest = createHash("sha256").update([endpoint.serverInstance, endpoint.conversationId, endpoint.token].join(":")).digest("hex");
  return join(f.store.directory, "peers", digest.slice(0, 40) + ".sock");
}

test("server transport preserves UTF-8 split inside a request character", async t => {
  const f = await pair(t), input = sendInput({ text: "Review 💩 without corruption" });
  const body = JSON.stringify({ type: "pi-rex.peer", version: 1, id: input.id, op: "send",
    from: f.parent.endpoint, to: f.child.endpoint, params: input }) + "\n";
  const bytes = Buffer.from(body), cut = bytes.indexOf(Buffer.from("💩")) + 1;
  const socket = createConnection(peerSocketPath(f, f.child.endpoint)), chunks = [];
  socket.on("data", chunk => chunks.push(chunk));
  await once(socket, "connect");
  socket.write(bytes.subarray(0, cut));
  await new Promise(resolve => setTimeout(resolve, 5));
  socket.end(bytes.subarray(cut));
  await once(socket, "end");
  const reply = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(reply.ok, true); assert.equal(f.child.sent.length, 1);
  assert.equal(f.child.sent[0].message.details.envelope.text, input.text);
});

test("client transport preserves UTF-8 split inside a response character", async t => {
  const f = await pair(t), path = peerSocketPath(f, f.child.endpoint);
  f.child.peer.detach();
  const entry = { id: "utf8-entry", type: "message", message: { role: "user", content: "History 💩 intact" } };
  const server = createServer(socket => {
    socket.once("data", body => {
      const request = JSON.parse(body.toString("utf8").trim());
      const result = { target: f.child.state, sessionId: f.child.sm.getSessionId(), leafId: f.child.sm.getLeafId(),
        view: "branch", direction: "head", textOnly: false, entries: [entry], bytes: Buffer.byteLength(JSON.stringify(entry)),
        activity: { idle: true, pendingMessages: false } };
      const bytes = Buffer.from(JSON.stringify({ type: "pi-rex.peer", version: 1, id: request.id, ok: true, result }) + "\n");
      const cut = bytes.indexOf(Buffer.from("💩")) + 1;
      socket.write(bytes.subarray(0, cut));
      setTimeout(() => socket.end(bytes.subarray(cut)), 5);
    });
  });
  await new Promise(resolve => server.listen(path, resolve)); chmodSync(path, 0o600);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const page = await f.parent.peer.read(f.child.endpoint.conversationId, {});
  assert.equal(page.entries[0].message.content, "History 💩 intact");
});

const sdkModel = { id: "fixture", name: "No provider", provider: "fixture", api: "fixture", baseUrl: "https://invalid.invalid",
  reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

async function sdkPair(t, hooks = {}) {
  const f = await pair(t); f.child.peer.detach();
  let api, peer; const requests = [], errors = [], lifecycle = [];
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
  const modelRuntime = new Proxy({
    getModel: () => sdkModel, getPhysicalModel: () => sdkModel, hasConfiguredAuth: () => true,
    getModels: () => [sdkModel], getAvailableSnapshot: () => [sdkModel], getError: () => undefined,
    isUsingOAuth: () => false,
  }, { get(target, key) {
    if (key in target) return target[key];
    return () => { throw Error(`Forbidden model runtime operation: ${String(key)}`); };
  } });
  let resources;
  const loader = {
    getExtensions: () => resources,
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Isolated peer SDK test; no tools or external services.", getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {},
    reload: async () => { throw Error("Resource reload forbidden in this fixture"); },
  };
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(pi => {
    api = pi;
    pi.on("input", event => lifecycle.push(event));
    pi.on("session_start", async (_event, ctx) => {
      peer = new PeerRuntime(api, f.child.runtime, f.store.directory);
      await peer.attach(ctx);
    });
    pi.on("session_shutdown", () => peer?.detach());
  }, f.root, createEventBus(), runtime, "<peer-sdk-fixture>");
  resources = { extensions: [extension], errors: [], runtime };
  const agent = new Agent({ initialState: { model: sdkModel, thinkingLevel: "off", tools: [] }, convertToLlm,
    streamFn: (_model, context, options) => {
      const stream = createAssistantMessageEventStream(), n = requests.length;
      requests.push(structuredClone(context));
      Promise.resolve().then(async () => {
        await hooks.stream?.(n, context);
        const message = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture",
          content: [{ type: "text", text: `fixture response ${n}` }], stopReason: options.signal?.aborted ? "aborted" : "stop",
          timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  const session = new AgentSession({ agent, sessionManager: f.child.sm, settingsManager: settings, cwd: f.root,
    modelRuntime, resourceLoader: loader, initialActiveToolNames: [], baseToolsOverride: {} });
  await session.bindExtensions({ mode: "tui", onError: error => errors.push(error),
    uiContext: { getEditorText: () => "", notify() {}, setStatus() {} } });
  t.after(() => { peer?.detach(); session.dispose(); });
  return { ...f, session, requests, errors, lifecycle, get sdkPeer() { return peer; } };
}

const customPeerMessages = f => f.session.messages.filter(message => message.customType === PEER_MESSAGE_TYPE);

test("SDK: idle followUp injects a custom message and starts one turn without input hooks", async t => {
  const f = await sdkPair(t), text = "SDK peer followUp 💩";
  const sent = await f.parent.peer.send(f.child.endpoint.conversationId, sendInput({ text, delivery: "followUp", triggerTurn: true }));
  await f.session.waitForIdle();
  assert.equal(f.sdkPeer.messageDelivery(sent.id).state, "accepted");
  assert.equal(f.sdkPeer.messageDelivery(sent.id).delivery, "unknown");
  assert.equal(f.sdkPeer.messageDelivery(sent.id).processing, "unknown");
  assert.equal(f.sdkPeer.messageDelivery(sent.id).settlement, "unknown");
  assert.equal(f.requests.length, 1); assert.equal(customPeerMessages(f).length, 1);
  assert.equal(customPeerMessages(f)[0].role, "custom");
  assert.match(JSON.stringify(f.requests[0]), /SDK peer followUp/);
  assert.match(JSON.stringify(f.requests[0]), /untrusted peer data/);
  assert.equal(f.lifecycle.filter(event => event.type === "input").length, 0); assert.deepEqual(f.errors, []);
});

test("SDK: idle steer without triggerTurn stores custom context without model work", async t => {
  const f = await sdkPair(t);
  await f.parent.peer.send(f.child.endpoint.conversationId, sendInput({ text: "Store only", delivery: "steer", triggerTurn: false }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.session.isIdle, true); assert.equal(f.requests.length, 0);
  assert.equal(customPeerMessages(f).length, 1); assert.deepEqual(f.errors, []);
});

test("SDK: busy steer without triggerTurn appends after the current turn without another run", async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await sdkPair(t, { stream: async n => { if (n === 0) { entered(); await new Promise(resolve => { release = resolve; }); } } });
  const running = f.session.prompt("human request"); await started;
  await f.parent.peer.send(f.child.endpoint.conversationId, sendInput({ text: "Busy steer", delivery: "steer", triggerTurn: false }));
  release(); await running; await f.session.waitForIdle();
  assert.equal(f.requests.length, 1); assert.equal(customPeerMessages(f).length, 1);
  assert.equal(customPeerMessages(f)[0].content.includes("Busy steer"), true); assert.deepEqual(f.errors, []);
});

test("SDK: busy followUp waits for the active run and then starts its own turn", async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await sdkPair(t, { stream: async n => { if (n === 0) { entered(); await new Promise(resolve => { release = resolve; }); } } });
  const running = f.session.prompt("human request"); await started;
  const sent = await f.parent.peer.send(f.child.endpoint.conversationId,
    sendInput({ text: "Queued peer followUp", delivery: "followUp", triggerTurn: true }));
  assert.equal(f.sdkPeer.messageDelivery(sent.id).delivery, "unknown", "queued busy followUp is not target-delivered");
  release(); await running; await f.session.waitForIdle();
  assert.equal(f.sdkPeer.messageDelivery(sent.id).processing, "unknown", "a later turn is not correlated processing evidence");
  assert.equal(f.sdkPeer.messageDelivery(sent.id).settlement, "unknown");
  assert.equal(f.requests.length, 2); assert.equal(customPeerMessages(f).length, 1);
  assert.match(JSON.stringify(f.requests[1]), /Queued peer followUp/); assert.deepEqual(f.errors, []);
});
