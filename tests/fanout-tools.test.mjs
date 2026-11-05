import test from "node:test";
import assert from "node:assert/strict";
import { registerFanoutTools } from "../extensions/fanout.ts";
import { FanoutRegistry, FanoutRuntime } from "../lib/fanout.ts";
import { JoinCache, JoinRuntime } from "../lib/join.ts";
import { uuid } from "./fixtures.mjs";

const source = { taskId: uuid(), conversationId: uuid(), piSessionId: "test-session", role: "main" };
const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "test-session" } };
const grant = () => ({ tools: ["read"], readPaths: ["."], writePaths: [], delegation: { maxDepth: 0 },
  returnResults: false, turns: 2, timeoutMs: 1000 });
const input = (id, task = `task ${id}`) => ({ id, task, grant: grant() });
function fixture() {
  const registry = new FanoutRegistry(), joinCache = new JoinCache(), launches = [], states = new Map();
  const handle = id => ({ version: 1, taskId: source.taskId, conversationId: uuid(), runtimeId: uuid(), runId: uuid(),
    requestId: id, messageId: uuid(), endpointGeneration: 1 });
  const delegation = {
    async delegate(id, task, options) {
      launches.push({ id, task, options });
      const value = handle(id);
      return { handle: value, creation: "confirmed", binding: "bound", activity: "unknown", result: "pending",
        subscription: { settlement: false }, launch: { origin: source } };
    },
    async result(value) {
      const state = states.get(value.requestId) ?? "pending";
      return { handle: value, runtimeId: value.runtimeId, runId: value.runId, requestId: value.requestId,
        state, evidence: "current", notice: "fixture" };
    },
  };
  const fanout = new FanoutRuntime(delegation, registry), join = new JoinRuntime(delegation, joinCache);
  const runtime = { snapshot: () => ({ state: source }) };
  const tools = new Map(); let current = { runtime, fanout, join, registry };
  registerFanoutTools({ registerTool: tool => tools.set(tool.name, tool) }, () => current);
  return { registry, join, launches, states, tools, runtime, fanout,
    set current(value) { current = value; }, get current() { return current; } };
}

test("rex_fanout and rex_join refresh partial outcomes without relaunching", async () => {
  const f = fixture();
  const params = { children: [input("one"), input("two")], concurrency: 1 };
  const first = await f.tools.get("rex_fanout").execute("fanout-tool", params, undefined, undefined, ctx);
  assert.equal(first.details.fanoutId, "fanout-tool"); assert.equal(first.details.state, "unknown");
  assert.deepEqual(first.details.children.map(child => child.state), ["unknown", "unknown"]);
  assert.equal(f.launches.length, 2);
  f.states.set("one", "ready"); f.states.set("two", "failed");
  const joined = await f.tools.get("rex_join").execute("join-tool", { fanoutId: "fanout-tool" }, undefined, undefined, ctx);
  assert.equal(joined.details.state, "partial"); assert.equal(joined.details.completed, true);
  assert.deepEqual(joined.details.children.map(child => child.state), ["succeeded", "failed"]);
  f.current = { registry: f.registry, join: f.join };
  const repeated = await f.tools.get("rex_fanout").execute("fanout-tool", params, undefined, undefined, ctx);
  assert.deepEqual(repeated.details, joined.details, "exact existing fan-out needs no replacement runtime or capability");
  assert.equal(f.launches.length, 2);
  await assert.rejects(f.tools.get("rex_fanout").execute("fanout-tool",
    { children: [input("one", "changed scope"), input("two")], concurrency: 1 }, undefined, undefined, ctx),
    /Conflicting fan-out logical ID/);
  assert.equal(f.launches.length, 2);
});

test("fan-out cancellation returns interrupted child evidence without launching replacements", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  const result = await f.tools.get("rex_fanout").execute("cancelled-fanout",
    { children: [input("one"), input("two")], concurrency: 2 }, controller.signal, undefined, ctx);
  assert.equal(result.details.coordinator, "interrupted");
  assert.deepEqual(result.details.children.map(child => child.state), ["cancelled", "cancelled"]);
  assert.equal(f.launches.length, 0);
  await assert.rejects(f.tools.get("rex_join").execute("missing", { fanoutId: "missing" }, undefined, undefined, ctx),
    /Unknown fan-out logical ID/);
});

test("all child grants are attenuated before any fan-out launch", async () => {
  const f = fixture(), derived = [];
  f.current = { ...f.current, capability: {
    deriveChildGrant(value) { derived.push(value); if (derived.length === 2) throw new Error("second grant denied"); return value; },
    toolSignal: signal => signal ?? new AbortController().signal,
  } };
  await assert.rejects(f.tools.get("rex_fanout").execute("rejected-fanout",
    { children: [input("one"), input("two")] }, undefined, undefined, ctx), /second grant denied/);
  assert.equal(derived.length, 2); assert.equal(f.launches.length, 0);
  assert.equal(JSON.stringify(derived).includes("token"), false);
});
