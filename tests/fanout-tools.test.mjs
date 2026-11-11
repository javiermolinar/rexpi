import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
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
      const value = handle(task.replace(/^task /, ""));
      return { handle: value, creation: "confirmed", binding: "bound", activity: "unknown", result: "pending",
        subscription: { settlement: false }, launch: { origin: source },
        ...(options.selection ? { routing: {
          assignment: { decisionId: `decision-${task}`, selection: options.selection,
            choice: options.selection, target: { provider: "fake", model: "physical", thinking: "high" } },
          receipt: { operation: "revalidate" }, selectorMetadata: { task, usage: { totalTokens: 5, cost: 0.01 } },
        } } : {}) };
    },
    async result(value) {
      const configured = states.get(value.requestId) ?? "pending";
      const state = typeof configured === "string" ? configured : configured.state;
      const completion = typeof configured === "string" ? undefined : configured.completion;
      return { handle: value, runtimeId: value.runtimeId, runId: value.runId, requestId: value.requestId,
        state, ...(completion ? { outcome: completion.outcome, completion } : {}), evidence: "current", notice: "fixture" };
    },
  };
  const fanout = new FanoutRuntime(delegation, registry), join = new JoinRuntime(delegation, joinCache);
  const runtime = { snapshot: () => ({ state: source }) };
  const tools = new Map(); let current = { runtime, fanout, join, registry };
  registerFanoutTools({ registerTool: tool => tools.set(tool.name, tool) }, () => current);
  return { registry, join, launches, states, tools, runtime, fanout,
    set current(value) { current = value; }, get current() { return current; } };
}

test("rexpi_fanout forwards independent child models and includes them in logical identity", async () => {
  const f = fixture(), children = [
    { ...input("astra"), provider: "rex", model: "rex/deep-astra/high", thinking: "off" },
    { ...input("flash"), provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", thinking: "max" },
    input("legacy"),
  ], params = { children, concurrency: 1 };
  const first = await f.tools.get("rexpi_fanout").execute("model-fanout", params, undefined, undefined, ctx);
  assert.deepEqual(f.launches.map(launch => ({ task: launch.task, options: launch.options })), [
    { task: "task astra", options: { grant: grant(), provider: "rex", model: "rex/deep-astra/high", thinking: "off" } },
    { task: "task flash", options: { grant: grant(), provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash", thinking: "max" } },
    { task: "task legacy", options: { grant: grant() } },
  ]);
  const repeated = await f.tools.get("rexpi_fanout").execute("model-fanout", params, undefined, undefined, ctx);
  assert.deepEqual(repeated.details, first.details);
  assert.equal(f.launches.length, 3, "an exact repeat inspects the original children without relaunching");
  for (const patch of [{ model: "rex/everyday-flash/high" }, { provider: "openai-codex" }, { thinking: "high" }]) {
    const changed = children.map((child, index) => index === 0 ? { ...child, ...patch } : child);
    await assert.rejects(f.tools.get("rexpi_fanout").execute("model-fanout",
      { children: changed, concurrency: 1 }, undefined, undefined, ctx), /Conflicting fan-out logical ID/);
  }
  assert.equal(f.launches.length, 3, "changed model options cannot acquire the original logical identity");
});

test("rexpi_fanout child model validation is provider-portable and remains closed", () => {
  const parameters = fixture().tools.get("rexpi_fanout").parameters;
  for (const child of [
    { ...input("virtual"), provider: "rex", model: "rex/deep-astra/high", thinking: "off" },
    { ...input("codex"), provider: "openai-codex", model: "gpt-6-astra", thinking: "max" },
    { ...input("anthropic"), provider: "anthropic", model: "claude-opus-5-5", thinking: "high" },
    input("legacy"),
  ]) assert.equal(Value.Check(parameters, { children: [child] }), true);
  assert.equal(Value.Check(parameters, { children: [{ ...input("thinking"), thinking: "unlimited" }] }), false);
  assert.equal(Value.Check(parameters, { children: [{ ...input("unknown"), extra: true }] }), false);
});

test("rexpi_fanout forwards policy selections and preserves per-child routing evidence", async () => {
  const f = fixture(), children = [
    { ...input("automatic"), selection: "rex/auto", allowAutomatic: true },
    { ...input("explicit"), selection: "rex/deep-astra:high" },
  ], params = { children, concurrency: 1 };
  const launched = await f.tools.get("rexpi_fanout").execute("selection-fanout", params, undefined, undefined, ctx);
  assert.deepEqual(f.launches.map(launch => launch.options), [
    { grant: grant(), selection: "rex/auto", allowAutomatic: true },
    { grant: grant(), selection: "rex/deep-astra:high" },
  ]);
  const routed = launched.details.children;
  assert.deepEqual(routed.map(child => child.routing.selectorMetadata.task), ["task automatic", "task explicit"]);
  assert.deepEqual(routed.map(child => child.routing.receipt.operation), ["revalidate", "revalidate"]);
  const visible = JSON.parse(launched.content[0].text);
  assert.deepEqual(visible.children.map(child => child.routing.selectorMetadata.task), ["task automatic", "task explicit"]);
  f.states.set("automatic", "ready");
  const joined = await f.tools.get("rexpi_join").execute("join-selection-fanout", { fanoutId: "selection-fanout" }, undefined, undefined, ctx);
  assert.deepEqual(joined.details.children.map(child => child.routing.selectorMetadata.task), ["task automatic", "task explicit"],
    "later result reads preserve the original per-child assignments");
  assert.equal(Value.Check(f.tools.get("rexpi_fanout").parameters, params), true);
  for (const patch of [{ selection: "rex/everyday-flash:high" }, { allowAutomatic: false }]) {
    const changed = children.map((child, index) => index === 0 ? { ...child, ...patch } : child);
    await assert.rejects(f.tools.get("rexpi_fanout").execute("selection-fanout",
      { children: changed, concurrency: 1 }, undefined, undefined, ctx), /Conflicting fan-out logical ID/);
  }
  assert.equal(f.launches.length, 2);
});

test("fan-out rejects invalid model selection combinations before any child dispatch", async () => {
  const f = fixture();
  await assert.rejects(f.tools.get("rexpi_fanout").execute("invalid-selection-fanout", { children: [
    { ...input("valid"), selection: "rex/deep-astra:high" },
    { ...input("invalid"), selection: "rex/everyday-sol:high", provider: "openai-codex" },
  ] }, undefined, undefined, ctx), /mutually exclusive/);
  assert.equal(f.launches.length, 0);
});

test("rexpi_fanout and rexpi_join refresh partial outcomes without relaunching", async () => {
  const f = fixture();
  const params = { children: [input("one"), input("two")], concurrency: 1 };
  const first = await f.tools.get("rexpi_fanout").execute("fanout-tool", params, undefined, undefined, ctx);
  assert.equal(first.details.fanoutId, "fanout-tool"); assert.equal(first.details.state, "unknown");
  assert.deepEqual(first.details.children.map(child => child.state), ["unknown", "unknown"]);
  const firstVisible = JSON.parse(first.content[0].text);
  assert.equal(firstVisible.fanoutId, "fanout-tool");
  assert.deepEqual(firstVisible.children.map(child => child.handle), first.details.children.map(child => child.handle));
  assert.deepEqual(firstVisible.children.map(child => child.result.state), ["pending", "pending"]);
  assert.equal(first.content[0].text.includes("fixture"), false, "repeated notices stay out of model-visible projections");
  assert.equal(f.launches.length, 2);
  const summary = "visible summary " + "🙂".repeat(600);
  f.states.set("one", { state: "ready", completion: { outcome: "completed", summary, artifacts: ["details-only-artifact"] } });
  f.states.set("two", "failed");
  const joined = await f.tools.get("rexpi_join").execute("join-tool", { fanoutId: "fanout-tool" }, undefined, undefined, ctx);
  assert.equal(joined.details.state, "partial"); assert.equal(joined.details.completed, true);
  assert.deepEqual(joined.details.children.map(child => child.state), ["succeeded", "failed"]);
  const joinedVisible = JSON.parse(joined.content[0].text);
  assert.deepEqual(joinedVisible.children.map(child => child.state), ["succeeded", "failed"]);
  assert.deepEqual(joinedVisible.children.map(child => child.handle), joined.details.children.map(child => child.handle));
  assert.equal(joinedVisible.children[0].result.outcome, "completed");
  assert.ok(joinedVisible.children[0].result.summary.endsWith("…"));
  assert.ok(joinedVisible.children[0].result.summary.length < summary.length);
  assert.equal(joined.details.children[0].result.completion.summary, summary, "full evidence remains in details");
  assert.equal(joined.content[0].text.includes("details-only-artifact"), false);
  assert.ok(Buffer.byteLength(joined.content[0].text) <= 256 * 1024);
  f.current = { registry: f.registry, join: f.join };
  const repeated = await f.tools.get("rexpi_fanout").execute("fanout-tool", params, undefined, undefined, ctx);
  assert.deepEqual(repeated.details, joined.details, "exact existing fan-out needs no replacement runtime or capability");
  assert.equal(f.launches.length, 2);
  await assert.rejects(f.tools.get("rexpi_fanout").execute("fanout-tool",
    { children: [input("one", "changed scope"), input("two")], concurrency: 1 }, undefined, undefined, ctx),
    /Conflicting fan-out logical ID/);
  assert.equal(f.launches.length, 2);
});

test("fan-out cancellation returns interrupted child evidence without launching replacements", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  const result = await f.tools.get("rexpi_fanout").execute("cancelled-fanout",
    { children: [input("one"), input("two")], concurrency: 2 }, controller.signal, undefined, ctx);
  assert.equal(result.details.coordinator, "interrupted");
  assert.deepEqual(result.details.children.map(child => child.state), ["cancelled", "cancelled"]);
  assert.equal(f.launches.length, 0);
  await assert.rejects(f.tools.get("rexpi_join").execute("missing", { fanoutId: "missing" }, undefined, undefined, ctx),
    /Unknown fan-out logical ID/);
});

test("capability-attenuated exact retries use raw caller identity without deriving or launching again", async () => {
  const f = fixture(); let derived = 0;
  f.current = { ...f.current, capability: {
    deriveChildGrant(value) { derived++; return { ...value, readPaths: value.readPaths.map(path => "/repo/" + path) }; },
    toolSignal: signal => signal ?? new AbortController().signal,
  } };
  const params = { children: [input("one")], concurrency: 1 };
  const first = await f.tools.get("rexpi_fanout").execute("attenuated-repeat", params, undefined, undefined, ctx);
  const repeated = await f.tools.get("rexpi_fanout").execute("attenuated-repeat", params, undefined, undefined, ctx);
  assert.deepEqual(repeated.details, first.details);
  assert.equal(derived, 1);
  assert.equal(f.launches.length, 1);
  await assert.rejects(f.tools.get("rexpi_fanout").execute("attenuated-repeat",
    { children: [input("one", "changed")], concurrency: 1 }, undefined, undefined, ctx), /Conflicting fan-out logical ID/);
  assert.equal(f.launches.length, 1);
});

test("all child grants are attenuated before any fan-out launch", async () => {
  const f = fixture(), derived = [];
  f.current = { ...f.current, capability: {
    deriveChildGrant(value) { derived.push(value); if (derived.length === 2) throw new Error("second grant denied"); return value; },
    toolSignal: signal => signal ?? new AbortController().signal,
  } };
  await assert.rejects(f.tools.get("rexpi_fanout").execute("rejected-fanout",
    { children: [input("one"), input("two")] }, undefined, undefined, ctx), /second grant denied/);
  assert.equal(derived.length, 2); assert.equal(f.launches.length, 0);
  assert.equal(JSON.stringify(derived).includes("token"), false);
});
