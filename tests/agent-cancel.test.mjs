import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentRuntime, MAX_AGENT_CANCELLATION_BYTES } from "../lib/agent-runtime.ts";
import { PeerAgentCancelUnknownError, PeerRuntime } from "../lib/peer.ts";
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
    outcome: "completed", summary: "retained result payload", artifacts: ["artifact"], ...overrides };
}
function unitFixture() {
  const handle = makeHandle();
  const target = { taskId: handle.taskId, conversationId: handle.conversationId,
    piSessionId: uuid(), role: "review" };
  const source = { taskId: handle.taskId, conversationId: uuid(), piSessionId: uuid(), role: "main" };
  const response = () => ({ target, endpointId: "a".repeat(64), handle,
    state: "acknowledged", reason: "busy" });
  const reader = {
    calls: 0, resultCalls: 0, failure: undefined, reply: undefined, onCancel: undefined,
    completion: undefined, includeCompletion: false,
    async agentActivity() {
      return { target, endpointId: "a".repeat(64),
        activity: { idle: false, pendingMessages: false, settled: false } };
    },
    async agentResult(received) {
      this.resultCalls++; assert.deepEqual(received, handle);
      return { target, endpointId: "a".repeat(64), handle,
        ...(this.includeCompletion ? { completion: this.completion } : {}) };
    },
    async agentCancel(received) {
      this.calls++; assert.deepEqual(received, handle);
      if (this.onCancel) return this.onCancel();
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
    const control = { idle: true, aborts: 0, abortError: undefined, onAbort: undefined };
    const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: sm,
      isIdle: () => control.idle, hasPendingMessages: () => false,
      abort: () => { control.aborts++; if (control.abortError) throw control.abortError; control.onAbort?.(); },
      ui: { setStatus() {}, notify() {} } };
    await runtime.start(ctx, state => sm.appendCustomEntry("pi-rex.orientation", state), seed);
    const peer = new PeerRuntime({ sendMessage(message, options) {
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
  const cancel = (handle, ctx = parent.ctx) => tools.get("rexpi_agent_cancel")
    .execute("cancel", { handle }, undefined, undefined, ctx);
  return { w, parent, child, tools, childTools, register, cancel };
}

function assertBounded(result) {
  assert.ok(Buffer.byteLength(JSON.stringify(result.details ?? result)) <= MAX_AGENT_CANCELLATION_BYTES);
  assert.match((result.details ?? result).notice, /neither quiescence nor a cancelled result/);
}

test("busy acknowledgement is abort-only, deduplicates concurrently, and retains later cancelled evidence", async t => {
  const f = await peerPair(t), handle = f.register();
  f.child.control.idle = false;
  f.parent.agent.observe(handle, { type: "activity.sample", idle: false, pendingMessages: true });
  const branch = f.child.sm.getBranch().map(entry => entry.id);
  assert.equal(f.tools.get("rexpi_agent_cancel").executionMode, "sequential");
  const [first, concurrent] = await Promise.all([f.cancel(handle), f.cancel(handle)]);
  assert.deepEqual(concurrent, first);
  assert.equal(first.details.state, "acknowledged"); assert.equal(first.details.reason, "busy");
  assert.equal(f.child.control.aborts, 1); assertBounded(first);
  assert.equal(JSON.parse(first.content[0].text).state, "acknowledged");
  assert.deepEqual(await f.cancel(handle), first); assert.equal(f.child.control.aborts, 1);

  const acknowledged = f.parent.agent.events(handle).events.at(-1);
  assert.equal(acknowledged.type, "cancellation.acknowledged");
  assert.equal(acknowledged.lifecycle.result, "cancelling");
  assert.equal(acknowledged.lifecycle.activity, "running");
  assert.equal(acknowledged.lifecycle.delivery, "created");
  const pending = await f.parent.agent.result(handle, f.parent.state);
  assert.equal(pending.state, "cancelling"); assert.equal(pending.completion, undefined);
  assert.equal(f.parent.agent.events(handle).resultAvailable, false);

  const completion = f.child.agent.complete(handle, f.child.state, makeCompletion(handle, {
    outcome: "cancelled", summary: "explicit child cancellation", error: { code: "STOP", message: "cancelled" },
  }));
  const result = await f.parent.agent.result(handle, f.parent.state);
  assert.equal(result.state, "cancelled"); assert.deepEqual(result.completion, completion);
  assert.equal(f.child.control.aborts, 1);
  assert.equal(f.parent.agent.events(handle).events.at(-1).lifecycle.result, "cancelled");
  assert.equal(f.parent.agent.events(handle).events.at(-1).lifecycle.activity, "running");
  assert.equal(f.parent.agent.events(handle).events.at(-1).lifecycle.delivery, "created");

  assert.ok(f.child.runtime.snapshot());
  const conversation = await f.parent.peer.read(handle.conversationId, { limit: 100 });
  assert.deepEqual(conversation.entries.map(entry => entry.id), branch);
  assert.equal(f.child.control.idle, false, "the abort fixture does not fabricate idle/quiescence");
});

test("idle and exact settled activity perform no abort and synthesize no completion", async t => {
  await t.test("idle", async t => {
    const f = await peerPair(t), handle = f.register();
    const outcome = await f.cancel(handle);
    assert.equal(outcome.details.state, "settled"); assert.equal(outcome.details.reason, "idle");
    assert.equal(f.child.control.aborts, 0); assertBounded(outcome);
    assert.equal((await f.parent.agent.result(handle, f.parent.state)).state, "pending");
    assert.equal(f.parent.agent.events(handle).resultAvailable, false);
  });
  await t.test("already settled", async t => {
    const f = await peerPair(t), handle = f.register();
    f.child.control.idle = false;
    f.child.agent.observe(handle, { type: "activity.sample", idle: false, pendingMessages: false });
    f.child.agent.observe(handle, { type: "activity.settled" });
    const outcome = await f.cancel(handle);
    assert.equal(outcome.details.state, "settled"); assert.equal(outcome.details.reason, "no-active-work");
    assert.equal(f.child.control.aborts, 0);
    assert.equal((await f.parent.agent.result(handle, f.parent.state)).state, "pending");
  });
});

for (const [outcome, state] of [["completed", "ready"], ["failed", "failed"], ["cancelled", "cancelled"]]) {
  test(`explicit ${outcome} result is settled without abort and retains its payload`, async t => {
    const f = await peerPair(t), handle = f.register(); f.child.control.idle = false;
    const completion = f.child.agent.complete(handle, f.child.state, makeCompletion(handle, { outcome }));
    if (outcome === "completed") assert.equal((await f.parent.agent.result(handle, f.parent.state)).state, "ready");
    const cancelled = await f.cancel(handle);
    assert.equal(cancelled.details.state, "settled");
    assert.equal(cancelled.details.reason, "already-settled");
    assert.equal(f.child.control.aborts, 0);
    const retained = await f.parent.agent.result(handle, f.parent.state);
    assert.equal(retained.state, state); assert.deepEqual(retained.completion, completion);
    assert.equal(f.parent.agent.events(handle).resultAvailable, true);
  });
}

test("foreign, self, unrelated, stale, replaced, and source-session-mismatched handles have no abort effect", async t => {
  const f = await peerPair(t), handle = f.register(); f.child.control.idle = false;
  const nativeCalls = f.w.calls.length;
  await assert.rejects(f.parent.agent.cancel(makeHandle({ taskId: handle.taskId }), f.parent.state),
    /Unknown, foreign, or ambiguous/);
  await assert.rejects(f.parent.agent.cancel(handle, { ...f.parent.state, taskId: uuid() }), /related task/);
  await assert.rejects(f.childTools.get("rexpi_agent_cancel").execute("self", { handle }, undefined, undefined, f.child.ctx),
    /remote handle/);
  const changedSession = { ...f.parent.ctx, sessionManager: { getSessionId: () => uuid() } };
  await assert.rejects(f.cancel(handle, changedSession), /source conversation changed/);
  assert.equal(f.child.control.aborts, 0); assert.equal(f.w.calls.length, nativeCalls);

  f.parent.agent.replace(handle);
  await assert.rejects(f.cancel(handle), /Stale|replaced/);
  assert.equal(f.child.control.aborts, 0);

  const replaced = unitFixture();
  replaced.agent.register({ ...replaced.handle, endpointGeneration: 2 });
  await assert.rejects(replaced.agent.cancel(replaced.handle, replaced.source), /Stale|replaced/);
  assert.equal(replaced.reader.calls, 0);
});

test("a miscorrelated remote registration or response never becomes acknowledgement", async t => {
  const f = await peerPair(t), handle = makeHandle({ taskId: f.child.state.taskId,
    conversationId: f.child.state.conversationId });
  f.parent.agent.register(handle); f.child.agent.register({ ...handle, requestId: "different-request" });
  f.child.control.idle = false;
  const remote = await f.cancel(handle);
  assert.equal(remote.details.state, "unknown"); assert.equal(f.child.control.aborts, 0);
  assert.equal(f.parent.agent.events(handle).resultAvailable, false);

  const malformed = unitFixture();
  malformed.reader.reply = { ...malformed.response(), handle: { ...malformed.handle, runId: uuid() } };
  const mismatched = await malformed.agent.cancel(malformed.handle, malformed.source);
  assert.equal(mismatched.state, "unknown"); assert.notEqual(mismatched.state, "acknowledged");
  assert.equal(malformed.reader.calls, 1);
  assert.equal(await malformed.agent.cancel(malformed.handle, malformed.source), mismatched);
});

test("ambiguous active runs in one child conversation cannot lend busy authority to a handle", async t => {
  const f = await peerPair(t), first = f.register();
  const second = makeHandle({ taskId: first.taskId, conversationId: first.conversationId });
  f.parent.agent.register(second); f.child.agent.register(second); f.child.control.idle = false;
  const outcome = await f.cancel(first);
  assert.equal(outcome.details.state, "unknown"); assert.equal(f.child.control.aborts, 0);
  assert.equal(f.parent.agent.events(first).resultAvailable, false);
});

test("concurrent and repeated calls share one retained outcome and one cancellation event", async () => {
  const f = unitFixture(); let release;
  const entered = new Promise(resolve => {
    f.reader.onCancel = () => { resolve(); return new Promise(done => { release = () => done(f.response()); }); };
  });
  const calls = [f.agent.cancel(f.handle, f.source), f.agent.cancel(f.handle, f.source),
    f.agent.cancel(f.handle, f.source)];
  await entered; assert.equal(f.reader.calls, 1); release();
  const outcomes = await Promise.all(calls);
  assert.equal(outcomes[0].state, "acknowledged");
  assert.strictEqual(outcomes[1], outcomes[0]); assert.strictEqual(outcomes[2], outcomes[0]);
  assert.equal(await f.agent.cancel(f.handle, f.source), outcomes[0]); assert.equal(f.reader.calls, 1);
  assert.equal(f.agent.events(f.handle).events.filter(event => event.type === "cancellation.acknowledged").length, 1);
});

test("definite pre-write failure remains requested; explicit transport uncertainty remains unknown", async () => {
  const prewrite = unitFixture(); prewrite.reader.failure = new Error("definite pre-write rejection");
  const requested = await prewrite.agent.cancel(prewrite.handle, prewrite.source);
  assert.equal(requested.state, "requested"); assert.equal(requested.reason, "pre-write");
  assert.match(requested.readError, /pre-write/); assertBounded(requested);
  assert.equal(prewrite.agent.events(prewrite.handle).events.at(-1).lifecycle.result, "pending");
  assert.equal(await prewrite.agent.cancel(prewrite.handle, prewrite.source), requested);
  assert.equal(prewrite.reader.calls, 1);

  const ambiguous = unitFixture();
  ambiguous.reader.failure = new PeerAgentCancelUnknownError("post-write response lost");
  const unknown = await ambiguous.agent.cancel(ambiguous.handle, ambiguous.source);
  assert.equal(unknown.state, "unknown"); assert.equal(unknown.reason, "transport");
  assert.equal(ambiguous.agent.events(ambiguous.handle).events.at(-1).lifecycle.result, "unknown");
  assert.equal(await ambiguous.agent.cancel(ambiguous.handle, ambiguous.source), unknown);
  assert.equal(ambiguous.reader.calls, 1);
});

test("disconnected and post-write lost responses return unknown without automatic retry", async t => {
  await t.test("disconnected before the request", async t => {
    const f = await peerPair(t), handle = f.register(); f.child.control.idle = false;
    f.child.peer.detach();
    const outcome = await f.cancel(handle);
    assert.equal(outcome.details.state, "unknown"); assert.equal(f.child.control.aborts, 0);
    assert.deepEqual(await f.cancel(handle), outcome); assert.equal(f.child.control.aborts, 0);
  });
  await t.test("response loss after abort", async t => {
    const f = await peerPair(t), handle = f.register(); f.child.control.idle = false;
    f.child.control.onAbort = () => f.child.peer.detach();
    const outcome = await f.cancel(handle);
    assert.equal(outcome.details.state, "unknown"); assert.equal(f.child.control.aborts, 1);
    assert.match(outcome.details.readError, /unknown|closed|changed|session/i);
    assert.deepEqual(await f.cancel(handle), outcome); assert.equal(f.child.control.aborts, 1);
    assert.equal(f.parent.agent.events(handle).resultAvailable, false);
  });
});

test("abort throw is unknown, endpoint remains usable, and child-side dedup survives a new parent cache", async t => {
  const f = await peerPair(t), handle = f.register(); f.child.control.idle = false;
  f.child.control.abortError = new Error("simulated abort throw");
  const first = await f.cancel(handle);
  assert.equal(first.details.state, "unknown"); assert.equal(first.details.reason, "abort-throw");
  assert.match(first.details.readError, /simulated abort throw/); assert.equal(f.child.control.aborts, 1);
  assert.ok(f.child.runtime.snapshot());
  assert.equal((await f.parent.peer.agentActivity(handle.conversationId)).target.conversationId, handle.conversationId);

  const anotherParent = new AgentRuntime(); anotherParent.attach(f.parent.peer); anotherParent.register(handle);
  t.after(() => anotherParent.detach());
  const repeated = await anotherParent.cancel(handle, f.parent.state);
  assert.equal(repeated.state, "unknown"); assert.equal(repeated.reason, "abort-throw");
  assert.equal(f.child.control.aborts, 1);
  const completion = f.child.agent.complete(handle, f.child.state, makeCompletion(handle, { outcome: "cancelled" }));
  assert.deepEqual((await f.parent.agent.result(handle, f.parent.state)).completion, completion);
});

test("replacement and target-crash races never fabricate acknowledgement or cancelled completion", async t => {
  await t.test("replacement while the response is pending", async () => {
    const f = unitFixture(); let release;
    const entered = new Promise(resolve => {
      f.reader.onCancel = () => { resolve(); return new Promise(done => { release = () => done(f.response()); }); };
    });
    const pending = f.agent.cancel(f.handle, f.source); await entered;
    f.agent.replace(f.handle); release();
    const outcome = await pending;
    assert.equal(outcome.state, "unknown"); assert.equal(outcome.reason, "changed");
    assert.equal(f.reader.calls, 1); assert.equal(f.agent.events(f.handle).resultAvailable, false);
    assert.equal(f.agent.events(f.handle).events.at(-1).lifecycle.binding, "replaced");
    assert.notEqual(f.agent.events(f.handle).events.at(-1).lifecycle.result, "cancelled");
  });
  await t.test("target process changes after the abort acknowledgement", async t => {
    const f = await peerPair(t), handle = f.register(); f.child.control.idle = false;
    let checks = 0;
    f.w.onTerminalData = async (block, method) => {
      if (block === f.child.blockId && method === "process" && ++checks === 4)
        f.w.processPids.set(f.child.blockId, process.pid + 1);
    };
    const outcome = await f.cancel(handle);
    assert.equal(outcome.details.state, "unknown"); assert.equal(f.child.control.aborts, 1);
    assert.deepEqual(await f.cancel(handle), outcome); assert.equal(f.child.control.aborts, 1);
    assert.equal(f.parent.agent.events(handle).resultAvailable, false);
    assert.notEqual(f.parent.agent.events(handle).events.at(-1).lifecycle.result, "cancelled");
  });
});
