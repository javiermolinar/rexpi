import test from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  AgentRuntime,
  MAX_AGENT_COMPLETION_ARTIFACT_BYTES,
  MAX_AGENT_COMPLETION_ARTIFACTS,
  MAX_AGENT_COMPLETION_ERROR_CODE_BYTES,
  MAX_AGENT_COMPLETION_ERROR_DETAILS_BYTES,
  MAX_AGENT_COMPLETION_ERROR_MESSAGE_BYTES,
  MAX_AGENT_COMPLETION_SUMMARY_BYTES,
} from "../lib/agent-runtime.ts";
import { registerAgentTools } from "../extensions/agent.ts";

const TASK_ID = "00000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000002";
const RUNTIME_ID = "00000000-0000-4000-8000-000000000003";
let sequence = 0;

function makeHandle(overrides = {}) {
  const suffix = String(++sequence).padStart(12, "0");
  return {
    version: 1,
    taskId: TASK_ID,
    conversationId: CONVERSATION_ID,
    runtimeId: RUNTIME_ID,
    runId: "00000000-0000-4000-8000-" + suffix,
    requestId: "request-" + suffix,
    messageId: "10000000-0000-4000-8000-" + suffix,
    endpointGeneration: 1,
    ...overrides,
  };
}

function localIdentity(handle, overrides = {}) {
  return {
    version: 1,
    taskId: handle.taskId,
    conversationId: handle.conversationId,
    piSessionId: "child-session",
    role: "chat",
    origin: { taskId: handle.taskId, conversationId: "00000000-0000-4000-8000-000000000099",
      piSessionId: "parent-session", role: "main" },
    ...overrides,
  };
}

function completion(handle, overrides = {}) {
  return {
    requestId: handle.requestId,
    runId: handle.runId,
    runtimeId: handle.runtimeId,
    outcome: "completed",
    summary: "Implemented the requested change.",
    artifacts: ["artifacts/result.txt"],
    ...overrides,
  };
}

function tracked() {
  const runtime = new AgentRuntime();
  const handle = runtime.register(makeHandle());
  return { runtime, handle, source: localIdentity(handle) };
}

function assertNoCompletion(runtime, handle, latestEventId = "1") {
  const page = runtime.events(handle);
  assert.equal(page.resultAvailable, false);
  assert.equal(page.lifecycle, undefined);
  assert.equal(page.latestEventId, latestEventId);
  assert.equal(page.events.at(-1).lifecycle.result, "pending");
}

test("explicit completed, failed, and cancelled records update only result evidence", async () => {
  for (const [outcome, result] of [["completed", "ready"], ["failed", "failed"], ["cancelled", "cancelled"]]) {
    const { runtime, handle, source } = tracked();
    runtime.observe(handle, { type: "activity.sample", idle: false, pendingMessages: true });
    const before = runtime.events(handle);
    assert.equal(before.resultAvailable, false);
    const input = completion(handle, {
      outcome,
      summary: outcome + " summary",
      ...(outcome === "completed" ? {} : { error: { code: "E_TEST", message: "expected failure", details: "detail" } }),
    });
    const stored = runtime.complete(handle, source, input);
    assert.deepEqual(stored, { ...input, artifacts: input.artifacts });
    assert.ok(Object.isFrozen(stored));
    assert.ok(Object.isFrozen(stored.artifacts));
    if (stored.error) assert.ok(Object.isFrozen(stored.error));

    const status = await runtime.status(handle);
    assert.equal(status.resultAvailable, true);
    assert.equal(status.lifecycle.result, result);
    assert.equal(status.lifecycle.activity, "running");
    assert.equal(status.lifecycle.delivery, "created");
    assert.equal(status.pendingInput, true);
    assert.equal(Object.hasOwn(status, "completion"), false);
    assert.equal(Object.hasOwn(status, "summary"), false);

    const page = runtime.events(handle);
    assert.equal(page.resultAvailable, true);
    assert.equal(Number(page.latestEventId), Number(before.latestEventId) + 1);
    assert.equal(page.events.at(-1).type, "result." + outcome);
    assert.deepEqual(page.events.at(-1).observation, { type: "result." + outcome });
    assert.equal(page.events.at(-1).lifecycle.result, result);
    assert.equal(page.events.at(-1).lifecycle.activity, "running");
    assert.equal(page.events.at(-1).lifecycle.delivery, "created");
    assert.equal(JSON.stringify(page).includes(outcome + " summary"), false);
  }
});

test("idle and local settlement never synthesize completion, and completion does not settle or deliver", async () => {
  const { runtime, handle, source } = tracked();
  runtime.observe(handle, { type: "activity.sample", idle: true, pendingMessages: false });
  assert.equal((await runtime.status(handle)).resultAvailable, false);
  runtime.observeLocalSettlement(source);
  let status = await runtime.status(handle);
  assert.equal(status.lifecycle.activity, "settled");
  assert.equal(status.lifecycle.result, "pending");
  assert.equal(status.resultAvailable, false);

  runtime.complete(handle, source, completion(handle, { artifacts: [] }));
  status = await runtime.status(handle);
  assert.equal(status.lifecycle.activity, "settled");
  assert.equal(status.lifecycle.delivery, "created");
  assert.equal(status.lifecycle.result, "ready");
  assert.equal(status.resultAvailable, true);
});

test("an identical retry returns the one record and changed payloads cannot overwrite it", async () => {
  const { runtime, handle, source } = tracked();
  const input = completion(handle, {
    error: { code: "WARNING", message: "nonfatal detail", details: "retained" },
  });
  const stored = runtime.complete(handle, source, input);
  const eventId = runtime.events(handle).latestEventId;
  assert.strictEqual(runtime.complete(handle, source, input), stored);
  assert.strictEqual(runtime.complete(handle, source, { ...input, artifacts: [...input.artifacts] }), stored);
  assert.equal(runtime.events(handle).latestEventId, eventId);

  const changed = [
    { ...input, summary: "different" },
    { ...input, artifacts: ["other.txt"] },
    { ...input, outcome: "failed" },
    { ...input, error: { code: "WARNING", message: "changed", details: "retained" } },
    { ...input, requestId: "different-request" },
    { ...input, runId: "99999999-9999-4999-8999-999999999999" },
    { ...input, runtimeId: "99999999-9999-4999-8999-999999999999" },
    { ...input, outcome: "unknown" },
  ];
  for (const candidate of changed) {
    assert.throws(() => runtime.complete(handle, source, candidate));
    assert.equal(runtime.events(handle).latestEventId, eventId);
  }
  assert.strictEqual(runtime.complete(handle, source, input), stored);
  assert.equal((await runtime.status(handle)).lifecycle.result, "ready");
  assert.deepEqual(stored, input);
});

test("foreign, nonlocal, miscorrelated, malformed, and stale completions fail without mutation", async () => {
  const { runtime, handle, source } = tracked();
  const foreign = makeHandle();
  assert.throws(() => runtime.complete(foreign, localIdentity(foreign), completion(foreign)), /Unknown, foreign/);
  const { origin, ...rootSource } = source;
  assert.throws(() => runtime.complete(handle, rootSource, completion(handle)), /version|verified local child/);
  assert.throws(() => runtime.complete(handle, { ...source, origin: undefined }, completion(handle)), /verified local child/);
  assert.throws(() => runtime.complete(handle,
    localIdentity(handle, { conversationId: "88888888-8888-4888-8888-888888888888" }),
    completion(handle)), /verified local child/);
  assert.throws(() => runtime.complete(handle,
    localIdentity(handle, { taskId: "99999999-9999-4999-8999-999999999999" }),
    completion(handle)), /verified local child/);
  for (const field of ["requestId", "runId", "runtimeId"]) {
    const value = field === "requestId" ? "other-request" : "99999999-9999-4999-8999-999999999999";
    assert.throws(() => runtime.complete(handle, source, completion(handle, { [field]: value })),
      new RegExp("correlation: " + field));
  }
  for (const input of [null, {}, completion(handle, { outcome: "inferred" }),
    completion(handle, { outcome: "completed", extra: true })]) {
    assert.throws(() => runtime.complete(handle, source, input));
  }
  assertNoCompletion(runtime, handle);

  const newer = runtime.register({ ...handle, endpointGeneration: handle.endpointGeneration + 1 });
  assert.equal((await runtime.status(handle)).lifecycle.binding, "replaced");
  assert.throws(() => runtime.complete(handle, source, completion(handle)), /Stale or replaced/);
  assertNoCompletion(runtime, handle, "2");
  assert.doesNotThrow(() => runtime.complete(newer, source, completion(newer)));
});

test("an exited handle is still rejected when its endpoint generation becomes stale", () => {
  const { runtime, handle, source } = tracked();
  runtime.observe(handle, { type: "binding.exited" });
  runtime.register({ ...handle, endpointGeneration: handle.endpointGeneration + 1 });
  assert.equal(runtime.events(handle).events.at(-1).lifecycle.binding, "exited");
  assert.throws(() => runtime.complete(handle, source, completion(handle)), /Stale or replaced/);
  assertNoCompletion(runtime, handle, "2");
});

test("summary, artifact, error, count, and total serialized record bounds fail closed", () => {
  const { runtime, handle, source } = tracked();
  const invalid = [
    completion(handle, { summary: " \n\t " }),
    completion(handle, { summary: "x".repeat(MAX_AGENT_COMPLETION_SUMMARY_BYTES + 1) }),
    completion(handle, { summary: "🦖".repeat(Math.floor(MAX_AGENT_COMPLETION_SUMMARY_BYTES / 4) + 1) }),
    completion(handle, { artifacts: "not-an-array" }),
    completion(handle, { artifacts: null }),
    completion(handle, { artifacts: Array(1) }),
    completion(handle, { artifacts: Array(MAX_AGENT_COMPLETION_ARTIFACTS + 1).fill("x") }),
    completion(handle, { artifacts: [" "] }),
    completion(handle, { artifacts: [42] }),
    completion(handle, { artifacts: ["x".repeat(MAX_AGENT_COMPLETION_ARTIFACT_BYTES + 1)] }),
    completion(handle, { error: null }),
    completion(handle, { error: {} }),
    completion(handle, { error: { message: " ", } }),
    completion(handle, { error: { message: "x".repeat(MAX_AGENT_COMPLETION_ERROR_MESSAGE_BYTES + 1) } }),
    completion(handle, { error: { code: "x".repeat(MAX_AGENT_COMPLETION_ERROR_CODE_BYTES + 1), message: "x" } }),
    completion(handle, { error: { message: "x", details: "x".repeat(MAX_AGENT_COMPLETION_ERROR_DETAILS_BYTES + 1) } }),
    completion(handle, { error: { message: "x", unexpected: true } }),
    completion(handle, {
      summary: "x".repeat(MAX_AGENT_COMPLETION_SUMMARY_BYTES),
      artifacts: Array(8).fill("x".repeat(MAX_AGENT_COMPLETION_ARTIFACT_BYTES)),
    }),
  ];
  for (const input of invalid) {
    assert.throws(() => runtime.complete(handle, source, input));
    assertNoCompletion(runtime, handle);
  }
  const stored = runtime.complete(handle, source, completion(handle, {
    artifacts: Array(MAX_AGENT_COMPLETION_ARTIFACTS).fill("x"),
  }));
  assert.equal(stored.artifacts.length, MAX_AGENT_COMPLETION_ARTIFACTS);
});

test("completion evidence uses existing per-run event retention and adds no run", () => {
  const runtime = new AgentRuntime(undefined, { maxEventsPerRun: 2, maxRuns: 1 });
  const handle = runtime.register(makeHandle()), source = localIdentity(handle);
  runtime.observe(handle, { type: "activity.sample", idle: true, pendingMessages: false });
  const stored = runtime.complete(handle, source, completion(handle));
  const page = runtime.events(handle);
  assert.equal(page.events.length, 2);
  assert.equal(page.dropped, 1);
  assert.equal(page.oldestEventId, "2");
  assert.equal(page.latestEventId, "3");
  assert.equal(page.events.at(-1).type, "result.completed");
  assert.equal(page.resultAvailable, true);
  assert.strictEqual(runtime.complete(handle, source, completion(handle)), stored);
  assert.throws(() => runtime.register(makeHandle()), /run history bound/);
});

test("rexpi_agent_complete is sequential and fenced to the verified source session and local child", async () => {
  const { runtime, handle, source } = tracked();
  const tools = new Map();
  const pi = { registerTool(definition) { tools.set(definition.name, definition); } };
  let orientation = { version: 1, ...source };
  const verifiedRuntime = { snapshot: () => ({ state: orientation }) };
  registerAgentTools(pi, () => ({ runtime: verifiedRuntime, peer: {}, agent: runtime }));
  const tool = tools.get("rexpi_agent_complete");
  assert.ok(tool);
  assert.equal(tool.executionMode, "sequential");
  const ctx = { sessionManager: { getSessionId: () => source.piSessionId } };
  const params = { handle, ...completion(handle) };

  const wrongSession = { sessionManager: { getSessionId: () => "another-session" } };
  await assert.rejects(tool.execute("call-0", params, undefined, undefined, wrongSession), /source conversation changed/);
  assertNoCompletion(runtime, handle);

  orientation = { ...orientation, conversationId: "99999999-9999-4999-8999-999999999999" };
  await assert.rejects(tool.execute("call-1", params, undefined, undefined, ctx), /verified local child/);
  assertNoCompletion(runtime, handle);

  orientation = { version: 1, ...source };
  const result = await tool.execute("call-2", params, undefined, undefined, ctx);
  assert.equal(result.details.outcome, "completed");
  assert.equal(result.terminate, true);
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  assert.equal((await runtime.status(handle)).resultAvailable, true);
  const eventId = runtime.events(handle).latestEventId;
  const retry = await tool.execute("call-3", params, undefined, undefined, ctx);
  assert.strictEqual(retry.details, result.details);
  assert.equal(runtime.events(handle).latestEventId, eventId);
});

test("a successful completion terminates Pi's agent loop without a second model request", async () => {
  const { runtime, handle, source } = tracked();
  const tools = new Map();
  registerAgentTools({ registerTool(definition) { tools.set(definition.name, definition); } },
    () => ({ runtime: { snapshot: () => ({ state: { version: 1, ...source } }) }, peer: {}, agent: runtime }));
  const definition = tools.get("rexpi_agent_complete");
  const ctx = { sessionManager: { getSessionId: () => source.piSessionId } };
  const tool = { ...definition,
    execute: (id, params, signal, onUpdate) => definition.execute(id, params, signal, onUpdate, ctx) };
  const response = (content, stopReason) => {
    const stream = createAssistantMessageEventStream();
    stream.end({ role: "assistant", content, api: "test", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason, timestamp: Date.now() });
    return stream;
  };
  let requests = 0;
  const streamFn = () => {
    requests++;
    if (requests === 1) return response([{ type: "toolCall", id: "complete-once", name: "rexpi_agent_complete",
      arguments: { handle, ...completion(handle) } }], "toolUse");
    return response([{ type: "text", text: "unexpected second request" }], "stop");
  };
  await runAgentLoop([{ role: "user", content: "Finish once", timestamp: Date.now() }],
    { messages: [], tools: [tool] }, { model: { provider: "test" }, convertToLlm: messages => messages },
    () => {}, undefined, streamFn);
  assert.equal(requests, 1, "terminate:true suppresses the follow-up model turn");
  assert.equal((await runtime.status(handle)).resultAvailable, true);
});

test("a mixed tool batch continues without prematurely finishing the capability", async () => {
  const { runtime, handle, source } = tracked();
  const tools = new Map();
  registerAgentTools({ registerTool(definition) { tools.set(definition.name, definition); } },
    () => ({ runtime: { snapshot: () => ({ state: { version: 1, ...source } }) }, peer: {}, agent: runtime }));
  const definition = tools.get("rexpi_agent_complete"), ctx = { sessionManager: { getSessionId: () => source.piSessionId } };
  const completionTool = { ...definition,
    execute: (id, params, signal, onUpdate) => definition.execute(id, params, signal, onUpdate, ctx) };
  const sibling = { name: "ordinary_tool", label: "Ordinary", description: "Ordinary sibling",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [{ type: "text", text: "done" }], details: {}, terminate: false }; } };
  const response = (content, stopReason) => {
    const stream = createAssistantMessageEventStream();
    stream.end({ role: "assistant", content, api: "test", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason, timestamp: Date.now() });
    return stream;
  };
  let requests = 0;
  const streamFn = () => {
    requests++;
    if (requests === 1) return response([
      { type: "toolCall", id: "complete-mixed", name: "rexpi_agent_complete", arguments: { handle, ...completion(handle) } },
      { type: "toolCall", id: "ordinary-mixed", name: "ordinary_tool", arguments: {} },
    ], "toolUse");
    return response([{ type: "text", text: "required mixed-batch continuation" }], "stop");
  };
  await runAgentLoop([{ role: "user", content: "Finish mixed batch", timestamp: Date.now() }],
    { messages: [], tools: [completionTool, sibling] }, { model: { provider: "test" }, convertToLlm: messages => messages },
    () => {}, undefined, streamFn);
  assert.equal(requests, 2, "a sibling without terminate:true requires the normal next model turn");
  assert.equal((await runtime.status(handle)).resultAvailable, true);
});
