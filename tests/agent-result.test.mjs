import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentRuntime, MAX_AGENT_COMPLETION_SUMMARY_BYTES, MAX_AGENT_RESULT_BYTES } from "../lib/agent-runtime.ts";
import { PeerRuntime } from "../lib/peer.ts";
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
    outcome: "completed", summary: "retained summary", artifacts: ["artifact"], ...overrides };
}
function fixture() {
  let handle = makeHandle();
  const target = { taskId: handle.taskId, conversationId: handle.conversationId,
    piSessionId: uuid(), role: "review" };
  const source = { taskId: handle.taskId, conversationId: uuid(), piSessionId: uuid(), role: "main" };
  const reader = {
    calls: 0, notifications: 0, endpointId: "a".repeat(64), failure: undefined,
    completion: undefined, includeCompletion: false, reply: undefined,
    async agentActivity() { throw new Error("Activity must not be read by result retrieval"); },
    async agentResult(received) {
      this.calls++;
      assert.deepEqual(received, handle);
      if (this.failure) throw this.failure;
      if (this.reply) return this.reply;
      return { target, endpointId: this.endpointId, handle,
        ...(this.includeCompletion ? { completion: this.completion } : {}) };
    },
  };
  const agent = new AgentRuntime();
  agent.attach(reader, { async notifyParent() { reader.notifications++; throw new Error("Unexpected notification"); } });
  handle = agent.register(handle);
  return { agent, reader, handle, target, source };
}

test("completed, failed, and cancelled completions map to distinct retained states", async t => {
  for (const [outcome, state] of [["completed", "ready"], ["failed", "failed"], ["cancelled", "cancelled"]]) {
    await t.test(outcome, async () => {
      const f = fixture(), completion = makeCompletion(f.handle, { outcome,
        ...(outcome === "completed" ? {} : { error: { code: "STOP", message: outcome } }) });
      f.reader.completion = completion; f.reader.includeCompletion = true;
      const result = await f.agent.result(f.handle, f.source);
      assert.equal(result.state, state); assert.equal(result.outcome, outcome);
      assert.deepEqual(result.completion, completion); assert.equal(result.evidence, "retained");
      assert.equal(result.handle, f.handle);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_AGENT_RESULT_BYTES);
      assert.equal((await f.agent.result(f.handle, f.source)), result);
      assert.equal(f.reader.calls, 1); assert.equal(f.reader.notifications, 0);
      const page = f.agent.events(f.handle);
      assert.equal(page.resultAvailable, true);
      assert.equal(page.events.at(-1).lifecycle.result, state);
      assert.equal(page.events.at(-1).lifecycle.activity, "unknown");
      assert.equal(page.events.at(-1).lifecycle.delivery, "created");
    });
  }
});

test("a successful response without completion is pending, not a terminal outcome", async () => {
  const f = fixture();
  const result = await f.agent.result(f.handle, f.source);
  assert.equal(result.state, "pending"); assert.equal(result.evidence, "current");
  assert.equal(result.completion, undefined); assert.equal(result.outcome, undefined);
  assert.equal(f.agent.events(f.handle).resultAvailable, false);
  assert.equal(f.agent.events(f.handle).events.at(-1).lifecycle.result, "pending");
});

test("bounded waiting observes explicit completion and then reuses the terminal result", async () => {
  const f = fixture(), original = f.reader.agentResult.bind(f.reader);
  f.reader.agentResult = async received => {
    const response = await original(received);
    if (f.reader.calls >= 2) response.completion = makeCompletion(f.handle);
    return response;
  };
  const result = await f.agent.waitForResult(f.handle, f.source, 1000);
  assert.equal(result.state, "ready"); assert.equal(result.outcome, "completed");
  assert.equal(f.reader.calls, 2);
  assert.equal(await f.agent.waitForResult(f.handle, f.source, 1000), result);
  assert.equal(f.reader.calls, 2, "terminal evidence triggers no further reads");
});

test("wait deadlines preserve pending evidence and settlement alone is not completion", async () => {
  const f = fixture();
  f.agent.observe(f.handle, { type: "activity.settled" });
  const result = await f.agent.waitForResult(f.handle, f.source, 20);
  assert.equal(result.state, "pending"); assert.equal(result.evidence, "current");
  assert.equal(result.completion, undefined); assert.equal(f.reader.calls, 1);
  assert.equal(f.agent.events(f.handle).events.at(-1).lifecycle.activity, "settled");
  assert.equal(f.agent.events(f.handle).events.at(-1).lifecycle.result, "pending");
});

test("unknown results and caller aborts do not wait or schedule more reads", async () => {
  const unknown = fixture(); unknown.reader.failure = new Error("transport disconnected");
  const result = await unknown.agent.waitForResult(unknown.handle, unknown.source, 1000);
  assert.equal(result.state, "unknown"); assert.equal(unknown.reader.calls, 1);

  const aborted = fixture(), controller = new AbortController(), original = aborted.reader.agentResult.bind(aborted.reader);
  aborted.reader.agentResult = async received => { const response = await original(received); controller.abort(); return response; };
  await assert.rejects(aborted.agent.waitForResult(aborted.handle, aborted.source, 1000, controller.signal));
  assert.equal(aborted.reader.calls, 1);
});

test("a stuck initial provider read is bounded and returns unknown without retained evidence", async () => {
  const f = fixture();
  f.reader.agentResult = async function () {
    this.calls++;
    await new Promise((resolve, reject) => {
      const signal = arguments[1];
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const result = await f.agent.waitForResult(f.handle, f.source, 20);
  assert.equal(result.state, "unknown"); assert.match(result.readError, /wait deadline exceeded/);
  assert.equal(result.evidence, "retained"); assert.equal(f.reader.calls, 1);
});

test("wait bounds and handle authority are validated before remote work", async () => {
  const f = fixture();
  for (const waitMs of [-1, 0.5, 30_001])
    await assert.rejects(f.agent.waitForResult(f.handle, f.source, waitMs), /Invalid agent result wait bound/);
  await assert.rejects(f.agent.waitForResult(makeHandle(), f.source, 10), /Unknown, foreign, or ambiguous/);
  await assert.rejects(f.agent.waitForResult(f.handle, { ...f.source, taskId: uuid() }, 10), /related task/);
  assert.equal(f.reader.calls, 0);
});

test("transport loss, detach, exit, and replacement are unknown without retained completion", async () => {
  const f = fixture();
  assert.equal((await f.agent.result(f.handle, f.source)).state, "pending");
  f.reader.failure = new Error("transport disconnected");
  const failed = await f.agent.result(f.handle, f.source);
  assert.equal(failed.state, "unknown"); assert.match(failed.readError, /transport disconnected/);
  f.agent.detach();
  assert.equal((await f.agent.result(f.handle, f.source)).state, "unknown");

  const replaced = fixture(); replaced.agent.replace(replaced.handle);
  assert.equal((await replaced.agent.result(replaced.handle, replaced.source)).state, "unknown");
  assert.equal(replaced.reader.calls, 0);
  const exited = fixture(); exited.agent.observe(exited.handle, { type: "binding.exited" });
  assert.equal((await exited.agent.result(exited.handle, exited.source)).state, "unknown");
  assert.equal(exited.reader.calls, 0);

  const incarnation = fixture();
  await incarnation.agent.result(incarnation.handle, incarnation.source);
  incarnation.reader.endpointId = "b".repeat(64);
  incarnation.reader.completion = makeCompletion(incarnation.handle); incarnation.reader.includeCompletion = true;
  assert.equal((await incarnation.agent.result(incarnation.handle, incarnation.source)).state, "unknown");
  assert.equal(incarnation.agent.events(incarnation.handle).resultAvailable, false);
  assert.equal(incarnation.agent.events(incarnation.handle).events.at(-1).lifecycle.delivery, "created");
});

test("a terminal record survives later failure, detach, and reader replacement identically", async () => {
  const f = fixture();
  f.reader.failure = new Error("temporary failure");
  assert.equal((await f.agent.result(f.handle, f.source)).state, "unknown");
  f.reader.failure = undefined; f.reader.completion = makeCompletion(f.handle); f.reader.includeCompletion = true;
  const retained = await f.agent.result(f.handle, f.source);
  assert.equal(retained.state, "ready");
  f.reader.failure = new Error("must not be observed");
  assert.equal(await f.agent.result(f.handle, f.source), retained);
  f.agent.detach();
  assert.equal(await f.agent.result(f.handle, f.source), retained);
  const replacement = { calls: 0, async agentActivity() { throw new Error("unused"); },
    async agentResult() { this.calls++; throw new Error("must not be called"); } };
  f.agent.attach(replacement);
  assert.equal(await f.agent.result(f.handle, f.source), retained);
  assert.equal(replacement.calls, 0); assert.equal(f.reader.calls, 2); assert.equal(f.reader.notifications, 0);
  assert.equal((await f.agent.status(f.handle)).resultAvailable, true);
});

test("foreign targets, stale generations, and every full-handle mismatch are rejected", async t => {
  const mismatches = [
    ["version", { version: 2 }], ["taskId", { taskId: uuid() }], ["conversationId", { conversationId: uuid() }],
    ["runtimeId", { runtimeId: uuid() }], ["runId", { runId: uuid() }],
    ["requestId", { requestId: "foreign-request" }], ["messageId", { messageId: uuid() }],
    ["endpointGeneration", { endpointGeneration: 2 }],
  ];
  for (const [field, override] of mismatches) {
    await t.test(field, async () => {
      const f = fixture();
      f.reader.reply = { target: f.target, endpointId: f.reader.endpointId,
        handle: { ...f.handle, ...override }, completion: makeCompletion(f.handle) };
      await assert.rejects(f.agent.result(f.handle, f.source));
      assert.equal(f.agent.events(f.handle).resultAvailable, false);
      assert.equal(f.agent.events(f.handle).events.at(-1).lifecycle.result, "pending");
    });
  }
  const foreign = fixture();
  foreign.reader.reply = { target: { ...foreign.target, taskId: uuid() }, endpointId: foreign.reader.endpointId,
    handle: foreign.handle };
  await assert.rejects(foreign.agent.result(foreign.handle, foreign.source), /Mismatched/);
  assert.equal(foreign.agent.events(foreign.handle).resultAvailable, false);
});

test("conflicting completion correlation, outcomes, and payload shapes never become retained", async t => {
  for (const field of ["requestId", "runId", "runtimeId"]) {
    await t.test(field, async () => {
      const f = fixture(), wanted = field === "requestId" ? "conflicting-request" : uuid();
      f.reader.completion = makeCompletion(f.handle, { [field]: wanted }); f.reader.includeCompletion = true;
      await assert.rejects(f.agent.result(f.handle, f.source), /Conflicting agent completion correlation/);
      assert.equal(f.agent.events(f.handle).resultAvailable, false);
      assert.equal(f.agent.events(f.handle).events.at(-1).lifecycle.result, "pending");
    });
  }
  for (const completion of [makeCompletion(makeHandle(), { outcome: "unknown" }), null, { outcome: "completed" }]) {
    const f = fixture(); f.reader.completion = completion; f.reader.includeCompletion = true;
    await assert.rejects(f.agent.result(f.handle, f.source));
    assert.equal(f.agent.events(f.handle).resultAvailable, false);
  }
  const extra = fixture(); extra.reader.completion = { ...makeCompletion(extra.handle), outcomeId: uuid() };
  extra.reader.includeCompletion = true;
  await assert.rejects(extra.agent.result(extra.handle, extra.source));
  assert.equal(extra.agent.events(extra.handle).resultAvailable, false);
});

test("local self, unrelated-task, and unknown-handle authority are rejected before remote work", async () => {
  const f = fixture(); f.reader.completion = makeCompletion(f.handle); f.reader.includeCompletion = true;
  await assert.rejects(f.agent.result(f.handle, { ...f.target, origin: f.source }), /remote handle/);
  await assert.rejects(f.agent.result(f.handle, { ...f.source, taskId: uuid() }), /related task/);
  await assert.rejects(f.agent.result(makeHandle(), f.source), /Unknown, foreign, or ambiguous/);
  assert.equal(f.reader.calls, 0); assert.equal(f.agent.events(f.handle).resultAvailable, false);
});

test("result output and completion input remain byte bounded", async () => {
  const f = fixture();
  f.reader.completion = makeCompletion(f.handle, { summary: "x".repeat(MAX_AGENT_COMPLETION_SUMMARY_BYTES) });
  f.reader.includeCompletion = true;
  const result = await f.agent.result(f.handle, f.source);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_AGENT_RESULT_BYTES);
  const oversized = fixture();
  oversized.reader.completion = makeCompletion(oversized.handle,
    { summary: "x".repeat(MAX_AGENT_COMPLETION_SUMMARY_BYTES + 1) });
  oversized.reader.includeCompletion = true;
  await assert.rejects(oversized.agent.result(oversized.handle, oversized.source), /byte bound/);
  assert.equal(oversized.agent.events(oversized.handle).resultAvailable, false);
});

async function peerPair(t) {
  const root = sandbox(t), w = world(), store = new BindingStore(join(root, "bindings"));
  async function start(blockId, seed) {
    const sessionId = seed?.piSessionId ?? uuid();
    const sm = SessionManager.create(root, join(root, "sessions"), { id: sessionId });
    sm.appendMessage({ role: "user", content: seed ? "child" : "parent", timestamp: Date.now() });
    const target = { sessionId: rid("session"), windowId: rid("window"), blockId };
    w.blocks.set(blockId, target); w.callerBlock = blockId;
    const runtime = new Runtime(new Rex("/bin/echo", w.exec), store, blockId), sent = [];
    const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: sm,
      isIdle: () => true, hasPendingMessages: () => false, ui: { setStatus() {}, notify() {} } };
    await runtime.start(ctx, state => sm.appendCustomEntry("pi-rex.orientation", state), seed);
    const peer = new PeerRuntime({ sendMessage(message, options) {
      sent.push({ message, options }); sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    } }, runtime, store.directory);
    await peer.attach(ctx);
    const agent = new AgentRuntime(); agent.attach(peer, peer);
    t.after(() => { agent.detach(); peer.detach(); runtime.stop(); });
    return { runtime, peer, agent, sm, ctx, sent, state: runtime.snapshot().state };
  }
  const parent = await start(rid("block"));
  const child = await start(rid("block"), childBootstrap(parent.state, true, "review", w.server));
  return { w, parent, child };
}

test("rexpi_agent_result uses the authenticated provider, recovers explicitly, and rejects child self-reads", async t => {
  const f = await peerPair(t), handle = makeHandle({ taskId: f.child.state.taskId,
    conversationId: f.child.state.conversationId });
  f.parent.agent.register(handle); f.child.agent.register(handle);
  const parentTools = new Map(), childTools = new Map();
  registerAgentTools({ registerTool: tool => parentTools.set(tool.name, tool) },
    () => ({ runtime: f.parent.runtime, peer: f.parent.peer, agent: f.parent.agent }));
  registerAgentTools({ registerTool: tool => childTools.set(tool.name, tool) },
    () => ({ runtime: f.child.runtime, peer: f.child.peer, agent: f.child.agent }));
  assert.deepEqual([...parentTools.keys()], ["rexpi_agent_complete", "rexpi_agent_result", "rexpi_agent_cancel", "rexpi_agent_stop",
    "rexpi_agent_status", "rexpi_agent_events"]);
  const read = (tools, waitMs) => tools.get("rexpi_agent_result").execute("result",
    { handle, ...(waitMs === undefined ? {} : { waitMs }) }, undefined, undefined,
    tools === parentTools ? f.parent.ctx : f.child.ctx);
  assert.equal(parentTools.get("rexpi_agent_result").parameters.properties.waitMs.maximum, 30_000);

  assert.equal((await read(parentTools)).details.state, "pending");
  f.child.peer.detach();
  assert.equal((await read(parentTools)).details.state, "unknown");
  const completion = f.child.agent.complete(handle, f.child.state, makeCompletion(handle));
  assert.equal(completion.outcome, "completed");
  await f.child.peer.attach(f.child.ctx); f.child.agent.attach(f.child.peer, f.child.peer);
  const ready = await read(parentTools);
  assert.equal(ready.details.state, "ready"); assert.deepEqual(ready.details.completion, completion);
  assert.equal(JSON.parse(ready.content[0].text).state, "ready");
  assert.deepEqual((await read(parentTools, 1000)).details, ready.details, "terminal waits reuse retained evidence");
  await assert.rejects(read(childTools), /remote handle/);
  await assert.rejects(f.child.peer.agentResult(handle), /Invalid or ambiguous peer target/);

  f.child.agent.detach(); f.child.peer.detach();
  const nativeCalls = f.w.calls.length;
  const retained = await read(parentTools);
  assert.equal(retained.details, ready.details); assert.deepEqual(retained, ready);
  assert.equal(f.w.calls.length, nativeCalls);
  assert.equal(f.parent.sent.length, 0); assert.equal(f.child.sent.length, 0);
  const page = f.parent.agent.events(handle);
  assert.equal(page.events.at(-1).lifecycle.activity, "unknown");
  assert.equal(page.events.at(-1).lifecycle.delivery, "created");
});
