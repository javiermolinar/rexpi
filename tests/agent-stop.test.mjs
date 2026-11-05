import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentRuntime, MAX_AGENT_STOP_BYTES } from "../lib/agent-runtime.ts";
import { PeerAgentStopUnknownError, PeerRuntime } from "../lib/peer.ts";
import { registerAgentTools } from "../extensions/agent.ts";
import { Rex } from "../lib/rex.ts";
import { Runtime } from "../lib/runtime.ts";
import { BindingStore } from "../lib/store.ts";
import { childBootstrap } from "../lib/state.ts";
import { sandbox, world, rid, uuid } from "./fixtures.mjs";

function makeHandle(overrides = {}) {
  return { version: 1, taskId: uuid(), conversationId: uuid(), runtimeId: uuid(), runId: uuid(),
    requestId: "request-1", messageId: uuid(), endpointGeneration: 1, ...overrides };
}
function makeCompletion(handle, overrides = {}) {
  return { requestId: handle.requestId, runId: handle.runId, runtimeId: handle.runtimeId,
    outcome: "completed", summary: "surviving result", artifacts: ["artifact"], ...overrides };
}
function unitFixture() {
  const handle = makeHandle();
  const target = { taskId: handle.taskId, conversationId: handle.conversationId,
    piSessionId: uuid(), role: "review" };
  const source = { taskId: handle.taskId, conversationId: uuid(), piSessionId: uuid(), role: "main" };
  const response = () => ({ target, endpointId: "a".repeat(64), handle,
    state: "accepted", reason: "shutdown-requested" });
  const reader = {
    calls: 0, failure: undefined, reply: undefined, onStop: undefined,
    async agentActivity() { throw new Error("Unexpected activity read"); },
    async agentStop(received) {
      this.calls++; assert.deepEqual(received, handle);
      if (this.onStop) return this.onStop();
      if (this.failure) throw this.failure;
      return this.reply ?? response();
    },
  };
  const agent = new AgentRuntime(); agent.attach(reader); agent.register(handle);
  return { agent, reader, handle, target, source, response };
}

async function peerPair(t) {
  const root = sandbox(t), w = world(), store = new BindingStore(join(root, "bindings"));
  async function start(blockId, seed) {
    const sessionId = seed?.piSessionId ?? uuid();
    const sm = SessionManager.create(root, join(root, "sessions"), { id: sessionId });
    sm.appendMessage({ role: "user", content: seed ? "child" : "parent", timestamp: Date.now() });
    const target = { sessionId: rid("session"), windowId: rid("window"), blockId };
    w.blocks.set(blockId, target); w.callerBlock = blockId;
    const runtime = new Runtime(new Rex("/bin/echo", w.exec), store, blockId);
    const control = { idle: true, aborts: 0, shutdowns: 0, shutdownError: undefined, onShutdown: undefined };
    const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: sm,
      isIdle: () => control.idle, hasPendingMessages: () => false,
      abort: () => { control.aborts++; },
      shutdown: () => { control.shutdowns++; if (control.shutdownError) throw control.shutdownError; control.onShutdown?.(); },
      ui: { setStatus() {}, notify() {} } };
    await runtime.start(ctx, state => sm.appendCustomEntry("pi-rex.orientation", state), seed);
    const peer = new PeerRuntime({ sendMessage(message) {
      sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    } }, runtime, store.directory);
    await peer.attach(ctx);
    const agent = new AgentRuntime(); agent.attach(peer, peer);
    t.after(() => { agent.detach(); peer.detach(); runtime.stop(); });
    return { runtime, peer, agent, sm, ctx, control, state: runtime.snapshot().state, blockId };
  }
  const parent = await start(rid("block"));
  const child = await start(rid("block"), childBootstrap(parent.state, true, "review", w.server));
  const tools = new Map(), childTools = new Map();
  registerAgentTools({ registerTool: tool => tools.set(tool.name, tool) },
    () => ({ runtime: parent.runtime, peer: parent.peer, agent: parent.agent }));
  registerAgentTools({ registerTool: tool => childTools.set(tool.name, tool) },
    () => ({ runtime: child.runtime, peer: child.peer, agent: child.agent }));
  function register(overrides = {}) {
    const handle = makeHandle({ taskId: child.state.taskId, conversationId: child.state.conversationId, ...overrides });
    parent.agent.register(handle); child.agent.register(handle);
    return handle;
  }
  const stop = (handle, ctx = parent.ctx, authorize = true) => tools.get("rex_agent_stop")
    .execute("stop", { handle, authorize }, undefined, undefined, ctx);
  return { w, parent, child, tools, childTools, register, stop };
}

function assertBounded(result) {
  const value = result.details ?? result;
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= MAX_AGENT_STOP_BYTES);
  assert.match(value.notice, /shutdown was requested, not that the endpoint exited/);
  assert.match(value.notice, /No outcome cancels work/);
}

for (const mode of ["busy", "idle"]) {
  test(`${mode} endpoint accepts shutdown without aborting, exiting, or changing result evidence`, async t => {
    const f = await peerPair(t), handle = f.register();
    f.child.control.idle = mode === "idle";
    if (mode === "busy") f.parent.agent.observe(handle, { type: "activity.sample", idle: false, pendingMessages: true });
    const branch = f.child.sm.getBranch().map(entry => entry.id);
    assert.equal(f.tools.get("rex_agent_stop").executionMode, "sequential");
    assert.equal(f.tools.get("rex_agent_stop").description, "Stop.");
    const first = await f.stop(handle);
    assert.equal(first.details.state, "accepted"); assert.equal(first.details.reason, "shutdown-requested");
    assert.equal(f.child.control.shutdowns, 1); assert.equal(f.child.control.aborts, 0); assertBounded(first);
    assert.deepEqual(await f.stop(handle), first); assert.equal(f.child.control.shutdowns, 1);
    const after = await f.parent.agent.status(handle);
    assert.equal(after.lifecycle.result, "pending");
    assert.equal(after.lifecycle.activity, mode === "busy" ? "running" : "idle");
    assert.equal(after.lifecycle.delivery, "created");
    assert.equal(f.parent.agent.events(handle).events.some(event => event.type === "stop.accepted"), true);
    assert.equal(f.parent.agent.events(handle).events.some(event => event.type.startsWith("cancellation.")), false);
    const conversation = await f.parent.peer.read(handle.conversationId, { limit: 100 });
    assert.deepEqual(conversation.entries.map(entry => entry.id), branch);
    assert.ok(f.child.runtime.snapshot(), "accepted is not local exit evidence");
  });
}

test("explicit completed work still accepts endpoint stop and retains its result", async t => {
  const f = await peerPair(t), handle = f.register();
  const completion = f.child.agent.complete(handle, f.child.state, makeCompletion(handle));
  const ready = await f.parent.agent.result(handle, f.parent.state);
  assert.equal(ready.state, "ready");
  const stopped = await f.stop(handle);
  assert.equal(stopped.details.state, "accepted"); assert.equal(f.child.control.shutdowns, 1);
  const retained = await f.parent.agent.result(handle, f.parent.state);
  assert.equal(retained.state, "ready"); assert.deepEqual(retained.completion, completion);
  assert.equal(f.parent.agent.events(handle).resultAvailable, true);
  assert.equal(f.parent.agent.events(handle).events.at(-1).lifecycle.result, "ready");
});

test("closed requires positive prior exit evidence and performs no shutdown or transport", async t => {
  const local = unitFixture();
  local.agent.observe(local.handle, { type: "binding.exited" });
  const closed = await local.agent.stop(local.handle, local.source, { authorize: true });
  assert.equal(closed.state, "closed"); assert.equal(closed.reason, "already-exited");
  assert.equal(local.reader.calls, 0); assertBounded(closed);
  assert.equal(local.agent.events(local.handle).events.at(-1).type, "stop.closed");

  const remote = await peerPair(t), handle = remote.register();
  remote.child.agent.observe(handle, { type: "binding.exited" });
  const outcome = await remote.stop(handle);
  assert.equal(outcome.details.state, "closed"); assert.equal(remote.child.control.shutdowns, 0);
  assert.equal(remote.parent.agent.events(handle).events.at(-1).lifecycle.binding, "created");
});

test("explicit authority, source, stale, foreign, miscorrelated, and ambiguous runtime fences have no shutdown effect", async t => {
  const f = await peerPair(t), handle = f.register(), nativeCalls = f.w.calls.length;
  await assert.rejects(f.tools.get("rex_agent_stop").execute("stop", { handle }, undefined, undefined, f.parent.ctx),
    /authorize:true/);
  for (const authorize of [false, "true"])
    await assert.rejects(f.stop(handle, f.parent.ctx, authorize), /authorize:true/);
  await assert.rejects(f.parent.agent.stop(makeHandle({ taskId: handle.taskId }), f.parent.state, { authorize: true }),
    /Unknown, foreign, or ambiguous/);
  await assert.rejects(f.parent.agent.stop(handle, { ...f.parent.state, taskId: uuid() }, { authorize: true }), /related task/);
  await assert.rejects(f.childTools.get("rex_agent_stop").execute("self", { handle, authorize: true }, undefined, undefined, f.child.ctx),
    /remote handle/);
  const changedSession = { ...f.parent.ctx, sessionManager: { getSessionId: () => uuid() } };
  await assert.rejects(f.stop(handle, changedSession), /source conversation changed/);
  assert.equal(f.child.control.shutdowns, 0); assert.equal(f.w.calls.length, nativeCalls);

  f.parent.agent.replace(handle);
  await assert.rejects(f.stop(handle), /Stale|replaced/);
  assert.equal(f.child.control.shutdowns, 0);

  const miscorrelated = await peerPair(t);
  const wrong = makeHandle({ taskId: miscorrelated.child.state.taskId,
    conversationId: miscorrelated.child.state.conversationId });
  miscorrelated.parent.agent.register(wrong);
  miscorrelated.child.agent.register({ ...wrong, requestId: "different-request" });
  const mismatched = await miscorrelated.stop(wrong);
  assert.equal(mismatched.details.state, "unknown"); assert.equal(miscorrelated.child.control.shutdowns, 0);

  const ambiguous = await peerPair(t), first = ambiguous.register();
  const second = makeHandle({ taskId: first.taskId, conversationId: first.conversationId });
  ambiguous.parent.agent.register(second); ambiguous.child.agent.register(second);
  const calls = ambiguous.w.calls.length;
  await assert.rejects(ambiguous.stop(first), /Ambiguous.*runtime association/);
  assert.equal(ambiguous.child.control.shutdowns, 0); assert.equal(ambiguous.w.calls.length, calls);
});

test("definite pre-write and unavailable stop paths are disconnected and retained without retry", async t => {
  const prewrite = unitFixture(); prewrite.reader.failure = new Error("definite pre-write rejection");
  const disconnected = await prewrite.agent.stop(prewrite.handle, prewrite.source, { authorize: true });
  assert.equal(disconnected.state, "disconnected"); assert.equal(disconnected.reason, "pre-write");
  assert.match(disconnected.readError, /pre-write/); assertBounded(disconnected);
  assert.equal(await prewrite.agent.stop(prewrite.handle, prewrite.source, { authorize: true }), disconnected);
  assert.equal(prewrite.reader.calls, 1);
  assert.equal(prewrite.agent.events(prewrite.handle).events.at(-1).lifecycle.result, "pending");

  const unavailable = unitFixture(); unavailable.agent.detach();
  const absent = await unavailable.agent.stop(unavailable.handle, unavailable.source, { authorize: true });
  assert.equal(absent.state, "disconnected"); assert.equal(absent.reason, "unavailable");
  assert.equal(unavailable.reader.calls, 0);

  const remote = await peerPair(t), handle = remote.register(); remote.child.peer.detach();
  const outcome = await remote.stop(handle);
  assert.equal(outcome.details.state, "disconnected"); assert.equal(remote.child.control.shutdowns, 0);
  assert.deepEqual(await remote.stop(handle), outcome); assert.equal(remote.child.control.shutdowns, 0);
});

test("post-write response loss is unknown and never retracts surviving evidence", async t => {
  const unit = unitFixture(); unit.reader.failure = new PeerAgentStopUnknownError("post-write response lost");
  const unknown = await unit.agent.stop(unit.handle, unit.source, { authorize: true });
  assert.equal(unknown.state, "unknown"); assert.equal(unknown.reason, "transport");
  assert.equal(await unit.agent.stop(unit.handle, unit.source, { authorize: true }), unknown);
  assert.equal(unit.reader.calls, 1); assert.equal(unit.agent.events(unit.handle).resultAvailable, false);

  const f = await peerPair(t), handle = f.register(), branch = f.child.sm.getBranch().map(entry => entry.id);
  f.child.control.onShutdown = () => f.child.peer.detach();
  const outcome = await f.stop(handle);
  assert.equal(outcome.details.state, "unknown"); assert.equal(f.child.control.shutdowns, 1);
  assert.match(outcome.details.readError, /unknown|closed|changed|session/i);
  assert.deepEqual(await f.stop(handle), outcome); assert.equal(f.child.control.shutdowns, 1);
  assert.equal(f.parent.agent.events(handle).events.at(-1).lifecycle.result, "pending");
  assert.deepEqual(f.child.sm.getBranch().map(entry => entry.id), branch);
});

test("shutdown throw is unknown, remains usable, and child dedup survives a new parent cache", async t => {
  const f = await peerPair(t), handle = f.register();
  f.child.control.shutdownError = new Error("simulated shutdown throw");
  const first = await f.stop(handle);
  assert.equal(first.details.state, "unknown"); assert.equal(first.details.reason, "shutdown-throw");
  assert.match(first.details.readError, /simulated shutdown throw/); assert.equal(f.child.control.shutdowns, 1);
  assert.ok(f.child.runtime.snapshot());
  assert.equal((await f.parent.peer.agentActivity(handle.conversationId)).target.conversationId, handle.conversationId);

  const anotherParent = new AgentRuntime(); anotherParent.attach(f.parent.peer); anotherParent.register(handle);
  t.after(() => anotherParent.detach());
  const repeated = await anotherParent.stop(handle, f.parent.state, { authorize: true });
  assert.equal(repeated.state, "unknown"); assert.equal(repeated.reason, "shutdown-throw");
  assert.equal(f.child.control.shutdowns, 1);
  const completion = f.child.agent.complete(handle, f.child.state, makeCompletion(handle));
  assert.deepEqual((await f.parent.agent.result(handle, f.parent.state)).completion, completion);
});

test("concurrent and repeated stops share one outcome, event, and native request", async () => {
  const f = unitFixture(); let release;
  const entered = new Promise(resolve => {
    f.reader.onStop = () => { resolve(); return new Promise(done => { release = () => done(f.response()); }); };
  });
  const calls = [f.agent.stop(f.handle, f.source, { authorize: true }),
    f.agent.stop(f.handle, f.source, { authorize: true }), f.agent.stop(f.handle, f.source, { authorize: true })];
  await entered; assert.equal(f.reader.calls, 1); release();
  const outcomes = await Promise.all(calls);
  assert.equal(outcomes[0].state, "accepted");
  assert.strictEqual(outcomes[1], outcomes[0]); assert.strictEqual(outcomes[2], outcomes[0]);
  assert.equal(await f.agent.stop(f.handle, f.source, { authorize: true }), outcomes[0]); assert.equal(f.reader.calls, 1);
  assert.equal(f.agent.events(f.handle).events.filter(event => event.type === "stop.accepted").length, 1);
});

test("distinct handles for one exact runtime share the child shutdown effect", async t => {
  const f = await peerPair(t), first = f.register();
  const second = makeHandle({ taskId: first.taskId, conversationId: first.conversationId,
    runtimeId: first.runtimeId, endpointGeneration: first.endpointGeneration });
  f.parent.agent.register(second); f.child.agent.register(second);
  assert.equal((await f.stop(first)).details.state, "accepted");
  assert.equal((await f.stop(second)).details.state, "accepted");
  assert.equal(f.child.control.shutdowns, 1);
  assert.equal(f.child.agent.events(first).events.at(-1).type, "stop.accepted");
  assert.equal(f.child.agent.events(second).events.at(-1).type, "stop.accepted");
});

test("replacement and target-crash races return unknown without fabricating exit or cancellation", async t => {
  await t.test("replacement while the response is pending", async () => {
    const f = unitFixture(); let release;
    const entered = new Promise(resolve => {
      f.reader.onStop = () => { resolve(); return new Promise(done => { release = () => done(f.response()); }); };
    });
    const pending = f.agent.stop(f.handle, f.source, { authorize: true }); await entered;
    f.agent.replace(f.handle); release();
    const outcome = await pending;
    assert.equal(outcome.state, "unknown"); assert.equal(outcome.reason, "changed");
    assert.equal(f.reader.calls, 1); assert.equal(f.agent.events(f.handle).resultAvailable, false);
    assert.equal(f.agent.events(f.handle).events.at(-1).lifecycle.binding, "replaced");
    assert.notEqual(f.agent.events(f.handle).events.at(-1).lifecycle.result, "cancelled");
  });
  await t.test("target process changes after shutdown acceptance", async t => {
    const f = await peerPair(t), handle = f.register(); let checks = 0;
    f.w.onTerminalData = async (block, method) => {
      if (block === f.child.blockId && method === "process" && ++checks === 2)
        f.w.processPids.set(f.child.blockId, process.pid + 1);
    };
    const outcome = await f.stop(handle);
    assert.equal(outcome.details.state, "unknown"); assert.equal(f.child.control.shutdowns, 1);
    assert.deepEqual(await f.stop(handle), outcome); assert.equal(f.child.control.shutdowns, 1);
    assert.notEqual(f.parent.agent.events(handle).events.at(-1).lifecycle.result, "cancelled");
  });
});

test("miscorrelated stop responses fail closed after at most one request", async () => {
  const malformed = unitFixture();
  malformed.reader.reply = { ...malformed.response(), handle: { ...malformed.handle, runId: uuid() } };
  const outcome = await malformed.agent.stop(malformed.handle, malformed.source, { authorize: true });
  assert.equal(outcome.state, "unknown"); assert.equal(malformed.reader.calls, 1);
  assert.equal(await malformed.agent.stop(malformed.handle, malformed.source, { authorize: true }), outcome);
});
