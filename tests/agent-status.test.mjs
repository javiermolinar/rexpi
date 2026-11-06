import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, MAX_AGENT_EVENT_PAGE_BYTES } from "../lib/agent-runtime.ts";
import { decodePeerRequest, PeerRuntime } from "../lib/peer.ts";
import { registerAgentTools } from "../extensions/agent.ts";
import { endpointFromBinding } from "../lib/messaging/protocol.ts";
import { binding, identity, rid, sandbox, uuid, world } from "./fixtures.mjs";
import { childBootstrap } from "../lib/state.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { BindingStore } from "../lib/store.ts";
import { Runtime } from "../lib/runtime.ts";
import { Rex } from "../lib/rex.ts";

function handle(overrides = {}) {
  return { version: 1, taskId: uuid(), conversationId: uuid(), runtimeId: uuid(), runId: uuid(),
    requestId: "request-1", messageId: uuid(), endpointGeneration: 1, ...overrides };
}
function readerFor(agent, initial = {}) {
  return {
    calls: 0, sends: 0, modelCalls: 0, turns: 0, endpointId: "a".repeat(64),
    activity: { idle: false, pendingMessages: false, settled: false, ...initial },
    async agentActivity(target) {
      this.calls++;
      assert.equal(target, agent.conversationId);
      return { target: { taskId: agent.taskId, conversationId: agent.conversationId,
        piSessionId: uuid(), role: "review" }, endpointId: this.endpointId, activity: { ...this.activity } };
    },
  };
}
const cursor = (agent, after) => Buffer.from(JSON.stringify({ version: 1, handle: agent, after })).toString("base64url");

test("busy, idle with queued input, and settlement stay independent from pending results", async () => {
  const agent = handle(), reader = readerFor(agent), runtime = new AgentRuntime(reader);
  runtime.register(agent);
  const busy = await runtime.status(agent);
  assert.equal(busy.lifecycle.binding, "bound"); assert.equal(busy.lifecycle.activity, "running");
  assert.equal(busy.pendingInput, false); assert.equal(busy.resultAvailable, false);
  assert.equal(busy.lifecycle.result, "pending"); assert.equal(busy.lifecycle.delivery, "created");
  assert.deepEqual([busy.runtimeId, busy.runId, busy.requestId], [agent.runtimeId, agent.runId, agent.requestId]);

  reader.activity = { idle: true, pendingMessages: true, settled: false };
  const queued = await runtime.status(agent);
  assert.equal(queued.lifecycle.activity, "idle"); assert.equal(queued.pendingInput, true);
  assert.equal(queued.resultAvailable, false); assert.equal(queued.lifecycle.result, "pending");

  reader.activity = { idle: true, pendingMessages: false, settled: true };
  const settled = await runtime.status(agent);
  assert.equal(settled.lifecycle.activity, "settled"); assert.equal(settled.resultAvailable, false);
  assert.equal(settled.lifecycle.result, "pending");
  const calls = reader.calls, page = runtime.events(agent, { limit: 100 });
  assert.equal(reader.calls, calls, "event reads never probe the target");
  assert.deepEqual(page.events.map(event => event.type), ["run.registered", "binding.verified", "activity.sample",
    "binding.verified", "activity.sample", "binding.verified", "activity.sample", "activity.settled"]);
  assert.equal(page.events.at(-1).lifecycle.result, "pending");
  assert.equal(reader.sends + reader.modelCalls + reader.turns, 0);
});

test("per-run retention, page bounds, and foreign/stale/evicted cursors fail closed", async () => {
  const agent = handle(), other = handle(), reader = readerFor(agent);
  const runtime = new AgentRuntime(reader, { maxEventsPerRun: 4, maxPageSize: 2 });
  runtime.track(agent); runtime.track(other);
  await runtime.status(agent);
  const first = runtime.events(agent, { limit: 2 });
  assert.equal(first.events.length, 2); assert.ok(first.next);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= MAX_AGENT_EVENT_PAGE_BYTES);
  assert.throws(() => runtime.events(other, { cursor: first.next }), /Foreign|mismatched|stale/i);
  assert.throws(() => runtime.events(agent, { cursor: "not+a+cursor" }), /Malformed|Foreign|stale/i);
  assert.throws(() => runtime.events(agent, { cursor: cursor(agent, "999") }), /Stale|ambiguous/i);
  await runtime.status(agent);
  await runtime.status(agent);
  const retained = runtime.events(agent);
  assert.equal(retained.events.length, 2); assert.equal(retained.dropped, 3);
  assert.equal(retained.oldestEventId, "4"); assert.equal(retained.latestEventId, "7");
  assert.deepEqual([...retained.events, ...runtime.events(agent, { cursor: retained.next }).events]
    .map(event => event.id), ["4", "5", "6", "7"]);
  assert.throws(() => runtime.events(agent, { cursor: first.next }), /evicted/i);
  assert.throws(() => runtime.events(agent, { limit: 3 }), /page size/i);
  assert.throws(() => runtime.events(agent, { limit: 0 }), /page size/i);
  assert.throws(() => runtime.events(agent, { cursor: cursor(agent, "0") }), /Malformed|evicted/i);
  const tiny = new AgentRuntime(undefined, { maxPageBytes: 1 }), tinyHandle = handle();
  tiny.register(tinyHandle);
  assert.throws(() => tiny.events(tinyHandle), /byte bound/i);
});

test("replacement retains old evidence but fences cursors and new target observations", async () => {
  const agent = handle(), reader = readerFor(agent), runtime = new AgentRuntime(reader);
  runtime.register(agent); await runtime.status(agent);
  const before = runtime.events(agent, { limit: 1 });
  reader.endpointId = "b".repeat(64);
  const replaced = await runtime.status(agent);
  assert.equal(replaced.lifecycle.binding, "replaced"); assert.equal(replaced.evidence, "retained");
  assert.equal(replaced.lifecycle.result, "pending"); assert.equal(replaced.resultAvailable, false);
  const calls = reader.calls;
  assert.equal((await runtime.status(agent)).lifecycle.binding, "replaced");
  assert.equal(reader.calls, calls, "a replaced incarnation is never probed as though it were live");
  assert.ok(runtime.events(agent).events.length > 0, "local evidence survives replacement");
  assert.throws(() => runtime.events(agent, { cursor: before.next }), /Replaced|stale/i);

  const next = { ...agent, endpointGeneration: 2 };
  runtime.register(next);
  const current = await runtime.status(next);
  assert.equal(current.lifecycle.binding, "bound"); assert.equal(current.lifecycle.activity, "running");
  assert.notEqual(current.handle.endpointGeneration, replaced.handle.endpointGeneration);
  assert.throws(() => runtime.register({ ...next, requestId: "different" }), /Ambiguous|conflicting/i);
  await assert.rejects(runtime.status(handle()), /Unknown|foreign|ambiguous/i);
});

test("detach/re-attachment retains observations without fabricating liveness or completion", async () => {
  const agent = handle(), reader = readerFor(agent, { idle: true, pendingMessages: true });
  const runtime = new AgentRuntime(reader); runtime.register(agent); await runtime.status(agent);
  runtime.detach();
  const retained = await runtime.status(agent);
  assert.equal(retained.evidence, "retained"); assert.equal(retained.lifecycle.binding, "unknown");
  assert.equal(retained.pendingInput, true); assert.equal(retained.resultAvailable, false);
  const calls = reader.calls;
  assert.ok(runtime.events(agent).events.length >= 4); assert.equal(reader.calls, calls);
  runtime.attach(reader);
  const current = await runtime.status(agent);
  assert.equal(current.evidence, "current"); assert.equal(current.lifecycle.binding, "bound");
  assert.equal(current.lifecycle.result, "pending");
});

test("run bounds and target/run association are explicit and fail closed", async () => {
  const first = handle(), runtime = new AgentRuntime(readerFor(first), { maxRuns: 1 });
  runtime.register(first); assert.deepEqual(runtime.register(first), first);
  assert.throws(() => runtime.register(handle()), /run history bound/i);
  const ambiguous = handle(), unbounded = new AgentRuntime(readerFor(ambiguous));
  unbounded.register(ambiguous);
  assert.throws(() => unbounded.register({ ...ambiguous, conversationId: uuid() }), /Ambiguous|conflicting/i);
  assert.throws(() => unbounded.register({ ...ambiguous, endpointGeneration: 0 }), /Invalid agent endpoint generation/i);
});

test("native tools expose only read-only status/events and event reads cause no model work", async () => {
  const agent = handle(), reader = readerFor(agent), agentRuntime = new AgentRuntime(reader);
  agentRuntime.register(agent);
  const runtime = { snapshot: () => ({ state: { piSessionId: "source-session" } }) }, peer = {};
  const tools = new Map();
  registerAgentTools({ registerTool: tool => tools.set(tool.name, tool) }, () => ({ runtime, peer, agent: agentRuntime }));
  assert.deepEqual([...tools.keys()], ["rexpi_agent_complete", "rexpi_agent_result", "rexpi_agent_cancel", "rexpi_agent_stop",
    "rexpi_agent_status", "rexpi_agent_events"]);
  const ctx = { sessionManager: { getSessionId: () => "source-session" } };
  for (const name of ["rexpi_agent_result", "rexpi_agent_status", "rexpi_agent_events"]) {
    assert.equal(tools.get(name).annotations.readOnlyHint, true);
    assert.equal(tools.get(name).annotations.destructiveHint, false);
  }
  assert.equal(tools.get("rexpi_agent_complete").annotations.readOnlyHint, false);
  assert.equal(tools.get("rexpi_agent_cancel").annotations.readOnlyHint, false);
  assert.equal(tools.get("rexpi_agent_cancel").annotations.destructiveHint, true);
  assert.equal(tools.get("rexpi_agent_stop").annotations.readOnlyHint, false);
  assert.equal(tools.get("rexpi_agent_stop").annotations.destructiveHint, true);
  const status = await tools.get("rexpi_agent_status").execute("status", { handle: agent }, undefined, undefined, ctx);
  assert.equal(status.details.resultAvailable, false); assert.equal(status.details.lifecycle.result, "pending");
  const compactStatus = JSON.parse(status.content[0].text);
  assert.equal(compactStatus.runtimeId, undefined); assert.equal(compactStatus.notice, undefined);
  assert.deepEqual(compactStatus.lifecycle, status.details.lifecycle);
  const verboseStatus = await tools.get("rexpi_agent_status").execute("status-verbose", { handle: agent, verbose: true }, undefined, undefined, ctx);
  assert.deepEqual(JSON.parse(verboseStatus.content[0].text), verboseStatus.details);
  const calls = reader.calls;
  const events = await tools.get("rexpi_agent_events").execute("events", { handle: agent, limit: 2 }, undefined, undefined, ctx);
  assert.equal(events.details.events.length, 2); assert.equal(reader.calls, calls);
  const compactEvents = JSON.parse(events.content[0].text);
  assert.equal(compactEvents.runtimeId, undefined); assert.equal(compactEvents.notice, undefined);
  assert.deepEqual(compactEvents.events, events.details.events);
  const verboseEvents = await tools.get("rexpi_agent_events").execute("events-verbose", { handle: agent, verbose: true }, undefined, undefined, ctx);
  assert.deepEqual(JSON.parse(verboseEvents.content[0].text), verboseEvents.details);
  assert.equal(reader.sends + reader.modelCalls + reader.turns, 0);
  assert.ok(Buffer.byteLength(events.content[0].text) <= MAX_AGENT_EVENT_PAGE_BYTES);
  await assert.rejects(tools.get("rexpi_agent_status").execute("wrong-source", { handle: agent }, undefined, undefined,
    { sessionManager: { getSessionId: () => "other" } }), /conversation changed/);
});

test("related-peer activity transport observes Pi hooks without custom messages or turns", async t => {
  const root = sandbox(t), w = world(), store = new BindingStore(join(root, "bindings"));
  async function start(blockId, seed) {
    const sessionId = seed?.piSessionId ?? uuid();
    const sm = SessionManager.create(root, join(root, "sessions"), { id: sessionId });
    sm.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
    const target = { sessionId: rid("session"), windowId: rid("window"), blockId };
    w.blocks.set(blockId, target); w.callerBlock = blockId;
    const runtime = new Runtime(new Rex("/bin/echo", w.exec), store, blockId), sent = [];
    const activity = { idle: true, pendingMessages: false };
    const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: sm,
      isIdle: () => activity.idle, hasPendingMessages: () => activity.pendingMessages,
      ui: { setStatus() {}, notify() {} } };
    await runtime.start(ctx, state => sm.appendCustomEntry("pi-rex.orientation", state), seed);
    const peer = new PeerRuntime({ sendMessage() { sent.push(true); } }, runtime, store.directory);
    await peer.attach(ctx);
    t.after(() => { peer.detach(); runtime.stop(); });
    return { runtime, peer, ctx, sent, activity, state: runtime.snapshot().state };
  }
  const parent = await start(rid("block"));
  const child = await start(rid("block"), childBootstrap(parent.state, true, "review", w.server));
  const agent = handle({ taskId: child.state.taskId, conversationId: child.state.conversationId });
  const agents = new AgentRuntime(parent.peer); agents.register(agent);
  child.peer.observeAgentStart(child.ctx); child.activity.idle = false;
  assert.equal((await agents.status(agent)).lifecycle.activity, "running");
  child.activity.idle = true; child.activity.pendingMessages = true;
  const queued = await agents.status(agent);
  assert.equal(queued.lifecycle.activity, "idle"); assert.equal(queued.pendingInput, true);
  child.peer.observeAgentEnd(child.ctx);
  const settled = await agents.status(agent);
  assert.equal(settled.lifecycle.activity, "settled"); assert.equal(settled.lifecycle.result, "pending");
  assert.equal(settled.resultAvailable, false); assert.equal(child.sent.length, 0);
  const nativeCalls = w.calls.length;
  assert.ok(agents.events(agent).events.length > 0); assert.equal(w.calls.length, nativeCalls);
  child.peer.detach();
  const retained = await agents.status(agent);
  assert.equal(retained.evidence, "retained"); assert.equal(retained.lifecycle.binding, "unknown");
  assert.equal(retained.lifecycle.result, "pending"); assert.equal(child.sent.length, 0);
});

test("peer wire operation is parameter-free and does not alter conversation read/send routes", () => {
  const owner = identity(), from = endpointFromBinding(binding(owner));
  const targetIdentity = { ...owner, conversationId: uuid(), piSessionId: uuid() };
  const to = endpointFromBinding(binding(targetIdentity));
  const base = { type: "pi-rex.peer", version: 1, id: uuid(), from, to };
  const activity = decodePeerRequest(JSON.stringify({ ...base, op: "agentActivity", params: {} }));
  assert.equal(activity.op, "agentActivity"); assert.deepEqual(activity.params, {});
  assert.throws(() => decodePeerRequest(JSON.stringify({ ...base, op: "agentActivity", params: { idle: true } })),
    /Unexpected|missing/);
  const read = decodePeerRequest(JSON.stringify({ ...base, op: "read", params: { view: "branch", limit: 1 } }));
  assert.equal(read.op, "read"); assert.equal(read.params.limit, 1);
  const stopHandle = handle({ taskId: owner.taskId, conversationId: targetIdentity.conversationId });
  const stopped = decodePeerRequest(JSON.stringify({ ...base, op: "agentStop",
    params: { handle: stopHandle, endpointId: "a".repeat(64) } }));
  assert.equal(stopped.op, "agentStop"); assert.deepEqual(stopped.params.handle, stopHandle);
  assert.equal(stopped.params.endpointId, "a".repeat(64));
});
