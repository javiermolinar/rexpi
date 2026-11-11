import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { piArguments } from "../lib/launch.ts";
import { createFilePolicySelectionRuntime, createPolicyResolver } from "../lib/model-selection.ts";
import { parsePolicy } from "../lib/vendor/pi-routing-policies/core/index.js";

const EXPLICIT = "rex/everyday-sol:high";
const AUTOMATIC = "rex/auto";
function makeConfig() {
  return {
    version: 1, autoModel: false, routingContext: "off", namespaces: { rex: {} },
    models: {
      "rex/everyday-sol": { instructions: "Preserve these assignment instructions.", defaultEffort: "high",
        efforts: { high: { provider: "fake", model: "sol-physical", thinking: "high" } } },
      "rex/fast-luna": { instructions: "Use the fast physical target.", defaultEffort: "low",
        efforts: { low: { provider: "fake", model: "luna-physical", thinking: "low" } } },
    },
    questions: { route: { type: "choice", instructions: "Choose an offered model or abstain.", criteria: {
      [EXPLICIT]: "Ordinary bounded implementation work.", "rex/fast-luna:low": "Mechanical work.",
      __abstain__: "No offered model is suitable.",
    } } },
    selector: { kind: "llm", provider: "fake", model: "selector-physical", thinking: "low", timeoutMs: 1000 },
  };
}
function physical(overrides = {}) {
  return { provider: "fake", id: "sol-physical", api: "fake-api", input: ["text"],
    contextWindow: 128000, maxTokens: 8192, auth: true, credential: "must-never-be-returned", ...overrides };
}
function makeRegistry(models = [physical(), physical({ id: "luna-physical" })]) {
  const byTarget = new Map(models.map(model => [`${model.provider}/${model.id}`, model]));
  const calls = { find: [], auth: [], inference: 0 };
  const registry = {
    find(provider, id) { calls.find.push({ provider, id }); return byTarget.get(`${provider}/${id}`); },
    hasConfiguredAuth(model) { calls.auth.push(`${model.provider}/${model.id}`); return model.auth !== false; },
    streamSimple() { calls.inference += 1; throw new Error("Unexpected direct inference"); },
  };
  return { registry, calls };
}
function fakeSelector(handler) {
  const calls = [];
  return { calls, selector: { async select(...args) { calls.push(args); return handler(...args); } } };
}
function successfulSelector() {
  return fakeSelector(() => ({ answer: { answers: { route: { type: "choice", choice: EXPLICIT } } },
    metadata: { selector: "fake-selector", latencyMs: 3, usage: { totalTokens: 0, cost: 0 } } }));
}
async function assertCode(promise, code) {
  await assert.rejects(promise, error => { assert.equal(error?.code, code); return true; });
}
function cloneResult(result) { return structuredClone(result); }

test("explicit selection resolves without constructing or invoking a selector", async () => {
  const { registry, calls } = makeRegistry(), fake = fakeSelector(() => { throw new Error("Unexpected selector"); });
  const resolver = createPolicyResolver(makeConfig(), registry, { allowAutomatic: true, selector: fake.selector });
  const result = await resolver.select(EXPLICIT, "Implement a bounded change");
  assert.equal(result.assignment.target.provider, "fake");
  assert.equal(result.assignment.target.model, "sol-physical");
  assert.equal(result.assignment.instructions, "Preserve these assignment instructions.");
  assert.equal(result.selectorMetadata, undefined);
  assert.equal(result.receipt.decisionId, result.assignment.decisionId);
  assert.equal(fake.calls.length, 0); assert.equal(calls.inference, 0);
  assert.deepEqual(calls.find, [{ provider: "fake", id: "sol-physical" }]);
});

test("automatic selection shares only bounded task state and returns selector metadata and receipt", async () => {
  const { registry, calls } = makeRegistry(), fake = successfulSelector();
  const resolver = createPolicyResolver(makeConfig(), registry, { allowAutomatic: true, selector: fake.selector });
  const task = `${"a".repeat(2999)}😀tail`;
  const result = await resolver.select(AUTOMATIC, task);
  assert.equal(fake.calls.length, 1);
  const state = fake.calls[0][0].state;
  assert.deepEqual(Object.keys(state).sort(), ["task", "taskTruncated"]);
  assert.equal(state.task, task.slice(0, 3000)); assert.equal(state.task.length, 3000);
  assert.equal(state.taskTruncated, true);
  assert.equal(result.assignment.target.model, "sol-physical");
  assert.equal(result.receipt.decisionId, result.assignment.decisionId);
  assert.match(JSON.stringify(result.selectorMetadata), /fake-selector/);
  assert.match(JSON.stringify(result.selectorMetadata), /latencyMs/);
  assert.equal(calls.inference, 0);
});

test("automatic selection fails before inventory or inference unless explicitly enabled", async () => {
  const { registry, calls } = makeRegistry(), fake = successfulSelector();
  const resolver = createPolicyResolver(makeConfig(), registry, { selector: fake.selector });
  await assertCode(resolver.select(AUTOMATIC, "Choose automatically"), "automatic_disabled");
  assert.equal(calls.find.length, 0); assert.equal(calls.auth.length, 0);
  assert.equal(calls.inference, 0); assert.equal(fake.calls.length, 0);
});

for (const [name, models, reason] of [
  ["missing physical model", [], "model_missing"],
  ["virtual target", [physical({ api: "pi-virtual" })], "not_physical"],
  ["missing auth", [physical({ auth: false })], "auth_missing"],
  ["unsupported input", [physical({ input: ["image"] })], "input_unsupported"],
]) test(`${name} fails closed with a stable inventory receipt`, async () => {
  const { registry } = makeRegistry(models); let receipt;
  const resolver = createPolicyResolver(makeConfig(), registry, { onReceipt: value => { receipt = value; } });
  await assertCode(resolver.select(EXPLICIT, "Resolve an ineligible target"), "INELIGIBLE");
  assert.equal(receipt.candidates.at(-1).reason, reason);
  assert.doesNotMatch(JSON.stringify(receipt), /must-never-be-returned/);
});

test("revoked credentials invalidate an assignment without trying another variant", async () => {
  const target = physical(), { registry, calls } = makeRegistry([target, physical({ id: "luna-physical" })]);
  const receipts = [], resolver = createPolicyResolver(makeConfig(), registry, { onReceipt: value => receipts.push(value) });
  const selected = await resolver.select(EXPLICIT, "Resolve before credential revocation");
  target.auth = false;
  await assertCode(resolver.revalidate(selected), "INELIGIBLE");
  assert.equal(receipts.at(-1).operation, "revalidate");
  assert.equal(receipts.at(-1).candidates.at(-1).reason, "auth_missing");
  assert.deepEqual(calls.find, Array(2).fill({ provider: "fake", id: "sol-physical" }));
  assert.equal(calls.inference, 0);
});

test("revalidation returns a fresh receipt and current assignment instructions", async () => {
  const { registry } = makeRegistry(), resolver = createPolicyResolver(makeConfig(), registry);
  const selected = await resolver.select(EXPLICIT, "Resolve before revalidation");
  const revalidated = await resolver.revalidate(selected);
  assert.notEqual(revalidated.receipt, selected.receipt);
  assert.equal(revalidated.receipt.decisionId, selected.assignment.decisionId);
  assert.equal(revalidated.assignment.instructions, "Preserve these assignment instructions.");
  assert.deepEqual(revalidated.assignment.target, selected.assignment.target);
});

test("stale policy revision prevents revalidation and does not fall back", async () => {
  const { registry } = makeRegistry(), resolver = createPolicyResolver(makeConfig(), registry);
  const stale = cloneResult(await resolver.select(EXPLICIT, "Resolve a revision"));
  stale.assignment.policyRevision = "stale-policy-revision";
  await assertCode(resolver.revalidate(stale), "STALE_DECISION");
});

test("changed assignment target prevents revalidation and does not fall back", async () => {
  const { registry } = makeRegistry(), resolver = createPolicyResolver(makeConfig(), registry);
  const changed = cloneResult(await resolver.select(EXPLICIT, "Resolve a target"));
  changed.assignment.target.model = "other-physical";
  await assertCode(resolver.revalidate(changed), "STALE_DECISION");
});

test("cancellation and selector failures propagate without retry or fallback", async t => {
  await t.test("pre-cancelled explicit selection", async () => {
    const { registry, calls } = makeRegistry(), resolver = createPolicyResolver(makeConfig(), registry);
    const controller = new AbortController(), reason = new Error("cancelled by parent");
    controller.abort(reason);
    await assert.rejects(resolver.select(EXPLICIT, "Cancelled work", controller.signal), error => error === reason);
    assert.equal(calls.find.length, 0);
  });
  await t.test("automatic selector failure", async () => {
    const { registry } = makeRegistry(), reason = new Error("selector failed");
    const fake = fakeSelector(() => { throw reason; });
    const resolver = createPolicyResolver(makeConfig(), registry, { allowAutomatic: true, selector: fake.selector });
    await assert.rejects(resolver.select(AUTOMATIC, "Fail selection"), error => error === reason);
    assert.equal(fake.calls.length, 1, "selector must not be retried");
  });
});

test("adapter performs no registration, session switch, delegation, launch, or explicit inference", async () => {
  const sideEffects = [], { registry, calls } = makeRegistry();
  for (const name of ["register", "registerModel", "setSessionModel", "delegate", "launch"])
    registry[name] = () => sideEffects.push(name);
  const fake = fakeSelector(() => { throw new Error("selector must remain unused"); });
  const resolver = createPolicyResolver(makeConfig(), registry, { allowAutomatic: true, selector: fake.selector });
  const selected = await resolver.select(EXPLICIT, "Resolve without runtime side effects");
  await resolver.revalidate(selected);
  assert.deepEqual(sideEffects, []); assert.equal(fake.calls.length, 0); assert.equal(calls.inference, 0);
});

test("file-backed selection is lazy and revalidation reads the current policy", async t => {
  const directory = await mkdtemp(join(tmpdir(), "rexpi-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policyPath = join(directory, "custom-policy.json"), config = makeConfig();
  await writeFile(policyPath, JSON.stringify(config));
  const { registry } = makeRegistry();
  const runtime = createFilePolicySelectionRuntime(join(directory, "missing-default"), registry,
    { PI_VIRTUAL_MODELS_CONFIG: policyPath });
  const selected = await runtime.select(EXPLICIT, "Resolve from the explicit policy path", false);
  assert.equal(selected.assignment.target.thinking, "high");
  const changed = structuredClone(config);
  changed.models["rex/everyday-sol"].efforts.high.thinking = "low";
  await writeFile(policyPath, JSON.stringify(changed));
  await assertCode(runtime.revalidate(selected), "STALE_DECISION");
  const next = await runtime.select(EXPLICIT, "Resolve the revised policy", false);
  assert.equal(next.assignment.target.thinking, "low");
  const missing = createFilePolicySelectionRuntime(join(directory, "missing"), registry);
  await assert.rejects(missing.select(EXPLICIT, "Missing policy", false), /ENOENT/);
});

test("invalid selection and task inputs are rejected before inventory", async () => {
  const { registry, calls } = makeRegistry(), resolver = createPolicyResolver(makeConfig(), registry);
  await assertCode(resolver.select("", "task"), "invalid_selection");
  await assertCode(resolver.select(EXPLICIT, ""), "invalid_task");
  assert.equal(calls.find.length, 0);
});

test("physical and native virtual launches preserve exact model identities", () => {
  assert.deepEqual(piArguments({ provider: "openai-codex", model: "gpt-6-astra", thinking: "max" }, "child", "extension").slice(4),
    ["--provider", "openai-codex", "--model", "gpt-6-astra", "--thinking", "max"]);
  assert.deepEqual(piArguments({ provider: "rex", model: "rex/deep-astra/high", thinking: "off" }, "child", "extension").slice(4),
    ["--provider", "rex", "--model", "rex/deep-astra/high", "--thinking", "off"]);
});

test("example policy and guide retain every exact policy, native, and physical spelling", async () => {
  const example = JSON.parse(await readFile(new URL("../examples/virtual-models.json", import.meta.url), "utf8"));
  const guide = await readFile(new URL("../docs/configuration.md", import.meta.url), "utf8");
  parsePolicy(example);
  const expected = [
    ["rex/deep-astra", "high", "openai-codex", "gpt-6-astra", "max"],
    ["rex/deep-opus", "high", "anthropic", "claude-opus-5-5", "max"],
    ["rex/everyday-sol", "high", "openai-codex", "gpt-6.1-sol", "high"],
    ["rex/everyday-kimi", "high", "openrouter", "moonshotai/kimi-k3.1-pro", "high"],
    ["rex/everyday-flash", "high", "openrouter", "deepseek/deepseek-v4.1-flash", "max"],
    ["rex/fast-luna", "low", "openai-codex", "gpt-6-luna", "low"],
  ];
  for (const [role, effort, provider, model, thinking] of expected) {
    assert.deepEqual(example.models[role].efforts[effort], { provider, model, thinking });
    for (const spelling of [`${role}:${effort}`, `${role}/${effort}`, provider, model])
      assert.ok(guide.includes(spelling), `guide is missing ${spelling}`);
  }
  for (const diagnostic of ["/vmodel doctor", "/vmodel preview", "/vmodel explain", "--allow-inference"])
    assert.ok(guide.includes(diagnostic), `guide is missing ${diagnostic}`);
});

test("Pi 1.5 native virtual models preserve route state through continuation and retry", async t => {
  const directory = await mkdtemp(join(tmpdir(), "rexpi-native-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime), calls = [];
  runtime.registerProvider("fake", { name: "Fake", baseUrl: "http://provider.invalid", apiKey: "fake",
    api: "openai-completions", streamSimple() { throw new Error("No live provider call is allowed"); }, models: [{
      id: "sol-physical", name: "Fake Sol", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }] });
  const target = registry.find("fake", "sol-physical");
  runtime.registerVirtualModel({ provider: "rex", id: "rex/deep-astra/high", name: "Fake native virtual",
    thinkingLevels: ["off"], input: ["text"], route(request) {
      calls.push({ reason: request.reason, state: request.state, previous: request.previous?.model.id });
      if (request.reason === "user") return { model: target, thinkingLevel: "high", state: { assignment: "pinned" } };
      assert.deepEqual(request.state, { assignment: "pinned" });
      assert.equal(request.previous.model.id, "sol-physical");
      return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel, state: request.state };
    } });
  const virtual = registry.find("rex", "rex/deep-astra/high");
  assert.equal(virtual.api, "pi-virtual");
  const first = await runtime.resolveModel(virtual, [], { reason: "user", thinkingLevel: "off" });
  const response = { role: "assistant", content: [], api: target.api, provider: target.provider, model: target.id,
    thinkingLevel: first.thinkingLevel, usage: {}, stopReason: "stop", timestamp: Date.now() };
  for (const reason of ["continuation", "retry"]) {
    const next = await runtime.resolveModel(virtual, [response], { reason, thinkingLevel: "off", state: first.state });
    assert.equal(next.model.id, "sol-physical"); assert.equal(next.thinkingLevel, "high");
    assert.deepEqual(next.state, { assignment: "pinned" });
  }
  assert.deepEqual(calls, [{ reason: "user", state: undefined, previous: undefined },
    { reason: "continuation", state: { assignment: "pinned" }, previous: "sol-physical" },
    { reason: "retry", state: { assignment: "pinned" }, previous: "sol-physical" }]);
  runtime.unregisterVirtualModel("rex", "rex/deep-astra/high");
  assert.equal(registry.find("rex", "rex/deep-astra/high"), undefined);
});
