import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentRuntime } from "../lib/agent-runtime.ts";
import { DelegationCache, DelegationRuntime } from "../lib/delegation.ts";
import { JoinCache, JoinRuntime } from "../lib/join.ts";
import { CAPABILITY_GRANT_ENV, decodeCapabilityGrant, Launcher } from "../lib/launch.ts";
import { MessagingRuntime } from "../lib/messaging/runtime.ts";
import { BOOTSTRAP_ENV, decodeBootstrap } from "../lib/state.ts";
import { AGENT_NOTIFY_SETTLEMENT_ENV } from "../lib/agent.ts";
import { peerAgentNotificationId } from "../lib/peer.ts";
import { registerDelegationTool } from "../extensions/delegation.ts";
import { active, binding } from "./fixtures.mjs";

const extension = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const grant = (overrides = {}) => ({ tools: ["read", "rexpi_message_send", "rexpi_agent_complete"], readPaths: ["."], writePaths: [],
  delegation: { maxDepth: 0 }, returnResults: false, turns: 3, timeoutMs: 10_000, ...overrides });
async function fixture(t, options = {}) {
  const a = await active(t), sm = SessionManager.create(a.root, join(a.root, "sessions"), { id: "test-session" });
  sm.appendMessage({ role: "user", content: "explicit delegated task", timestamp: Date.now() });
  for (const e of a.entries) sm.appendCustomEntry(e.customType, e.data);
  a.ctx.sessionManager = sm; a.ctx.isIdle = () => true; a.ctx.hasPendingMessages = () => false;
  const messaging = new MessagingRuntime({ appendEntry: (type, data) => sm.appendCustomEntry(type, data), sendMessage() {} },
    a.runtime, a.root, { setTimer: () => ({ unref() {} }), clearTimer() {} });
  messaging.attach(a.ctx); t.after(() => messaging.detach());
  const agent = new AgentRuntime(), cache = new DelegationCache();
  const launcher = new Launcher(a.runtime, { extension, piBinary: "/bin/echo", agentDirectory: a.root,
    stateDirectory: a.store.directory, path: process.env.PATH, startupTimeoutMs: options.startupTimeoutMs ?? 100,
    messaging, agents: agent });
  const delegation = new DelegationRuntime(launcher, agent, cache);
  const f = { ...a, sm, messaging, agent, launcher, delegation, cache };
  f.ack = args => {
    const raw = args.find(s => s.startsWith(BOOTSTRAP_ENV + "="));
    const seed = decodeBootstrap(raw.slice(raw.indexOf("=") + 1));
    a.store.write(binding(seed, { blockId: a.w.next.blockId })); return seed;
  };
  if (!options.noAck) a.w.onCreate = f.ack;
  return f;
}

test("delegation composes a fresh related launch with literal task/grant and independent evidence", async t => {
  const f = await fixture(t), task = "Review only the granted files\nDo not expand scope";
  const result = await f.delegation.delegate("delegation-one", task, { grant: grant() }, f.root);
  assert.equal(result.creation, "confirmed"); assert.equal(result.binding, "bound");
  assert.equal(result.activity, "unknown"); assert.equal(result.result, "pending");
  assert.deepEqual(result.subscription, { settlement: false });
  assert.equal(result.handle.requestId, "delegation-one");
  assert.equal(result.launch.handle.requestId, result.handle.requestId);
  assert.equal(result.launch.returnSetup, undefined);
  assert.equal(f.w.created.length, 1);
  const prompt = f.w.created[0].at(-1);
  assert.ok(prompt.startsWith(task + "\n\nDelegation capability manifest:\n"));
  assert.match(prompt, /Allowed tools: read, rexpi_message_send, rexpi_agent_complete/);
  assert.match(prompt, /Read paths: \./);
  assert.match(prompt, /Write paths: none/);
  assert.match(prompt, /Turn budget: 3; result return: disabled/);
  assert.match(prompt, /Reserve the final turn for rexpi_agent_complete/);
  const encoded = f.w.created[0].find(value => value.startsWith(CAPABILITY_GRANT_ENV + "="));
  assert.deepEqual(decodeCapabilityGrant(encoded.slice(encoded.indexOf("=") + 1)), grant());
  assert.equal(JSON.stringify(result).includes("token"), false);
  const events = f.agent.events(result.handle).events;
  assert.deepEqual(events.map(event => event.type), ["run.registered", "binding.verified"]);
  assert.equal(events.at(-1).lifecycle.activity, "unknown"); assert.equal(events.at(-1).lifecycle.result, "pending");
  f.agent.observeLocalSettlement(result.launch.identity);
  assert.equal(f.agent.events(result.handle).events.some(event => event.type.startsWith("delivery.")), false,
    "settlement subscription remains opt-in");
});

test("result correlation and settlement subscription use the exact issued capability", async t => {
  const f = await fixture(t), task = "Return only scoped findings";
  const result = await f.delegation.delegate("delegation-return", task,
    { grant: grant({ returnResults: true }), notifyParentOnSettlement: true }, f.root);
  assert.equal(result.returnSetup.state, "registered");
  for (const field of ["requestId", "runId", "messageId"])
    assert.equal(result.handle[field], result.returnSetup[field], field);
  assert.notEqual(result.handle.runtimeId, result.returnSetup.runtimeId,
    "child agent runtime and parent messaging runtime are separate evidence domains");
  assert.ok(f.w.created[0].at(-1).startsWith(task + "\n\nDelegation capability manifest:"));
  assert.match(f.w.created[0].at(-1), /Turn budget: 3; result return: enabled/);
  assert.match(f.w.created[0].at(-1), /Reserve the final two turns for rexpi_message_send and rexpi_agent_complete/);
  assert.match(f.w.created[0].at(-1), /inReplyTo=/);
  assert.deepEqual(result.subscription, { settlement: true });
  f.agent.observeLocalSettlement(result.launch.identity);
  const events = f.agent.events(result.handle).events;
  assert.equal(events.at(-1).type, "delivery.revoked", "subscription is exact, but no notifier/delivery is fabricated");
  assert.equal(events.some(event => event.type === "delivery.accepted"), false);
  assert.equal(events.at(-1).lifecycle.activity, "settled"); assert.equal(events.at(-1).lifecycle.result, "pending");
});

test("real child bootstrap supports explicit completion and settlement without conflating their evidence", async t => {
  const f = await fixture(t), result = await f.delegation.delegate("real-child-contract", "Complete the assigned task",
    { grant: grant(), notifyParentOnSettlement: true }, f.root);
  const args = f.w.created[0], prompt = args.at(-1);
  assert.ok(prompt.startsWith("Complete the assigned task\n\nDelegation capability manifest:"));
  assert.ok(args.includes(AGENT_NOTIFY_SETTLEMENT_ENV + "=1"));

  const child = new AgentRuntime(), notifications = [];
  child.register(result.handle, { notifyParentOnSettlement: args.includes(AGENT_NOTIFY_SETTLEMENT_ENV + "=1") });
  child.attach({}, { async notifyParent(notification) {
    notifications.push(notification);
    return { id: peerAgentNotificationId(notification), state: "accepted", processingConfirmed: false, completionConfirmed: false };
  } });
  child.observeLocalSettlement(result.launch.identity);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications.length, 1);
  assert.equal(child.cachedStatuses()[0].lifecycle.delivery, "accepted");
  assert.equal(child.cachedStatuses()[0].lifecycle.result, "pending");

  const completion = child.complete(result.handle, { version: 1, ...result.launch.identity, origin: result.launch.origin }, {
    requestId: result.handle.requestId, runId: result.handle.runId, runtimeId: result.handle.runtimeId,
    outcome: "completed", summary: "Assigned task completed",
  });
  const parent = new AgentRuntime({ async agentResult() {
    return { target: result.launch.identity, endpointId: "a".repeat(64), handle: result.handle, completion };
  } });
  parent.register(result.handle);
  const evidence = await parent.result(result.handle, result.launch.origin);
  assert.equal(evidence.state, "ready");
  assert.deepEqual(evidence.completion, completion);
  const execution = { settled: Promise.resolve(), cancel() {}, snapshot: () => ({ id: "real-child-join", completed: true,
    dispatching: 0, children: [{ id: "real-child", state: "delegated", handle: result.handle, delegation: result }] }) };
  const join = new JoinRuntime({ result: (handle, source, signal) => parent.result(handle, source, signal) }, new JoinCache());
  const joined = await join.join(execution, result.launch.origin);
  assert.equal(joined.state, "succeeded");
  assert.equal(joined.children[0].state, "succeeded");
});

test("rejected grants create nothing and creation/binding failures preserve separate evidence", async t => {
  const f = await fixture(t);
  await assert.rejects(f.delegation.delegate("bad-grant", "task", { grant: grant({ timeoutMs: 0 }) }, f.root), /timeoutMs/);
  await assert.rejects(f.delegation.delegate("blank-task", " \n", { grant: grant() }, f.root), /task/);
  assert.equal(f.w.created.length, 0);
  await assert.rejects(f.delegation.delegate("missing-completion-tool", "task", { grant: grant({ tools: ["read"] }) }, f.root),
    /rexpi_agent_complete/);
  await assert.rejects(f.delegation.delegate("missing-result-tool", "task",
    { grant: grant({ tools: ["read", "rexpi_agent_complete"], returnResults: true }) }, f.root),
  /returnResults=true requires rexpi_message_send/);
  assert.equal(f.w.created.length, 0);
  f.w.failCreate = true;
  const unknown = await f.delegation.delegate("unknown-create", "task", { grant: grant() }, f.root);
  assert.equal(unknown.creation, "unknown"); assert.equal(unknown.binding, "unconfirmed");
  assert.equal(unknown.activity, "unknown"); assert.equal(unknown.result, "pending");
  assert.equal(f.w.created.length, 1);
  f.w.failCreate = false; f.w.onCreate = undefined;
  const unbound = await f.delegation.delegate("unbound", "task", { grant: grant() }, f.root);
  assert.equal(unbound.creation, "confirmed"); assert.equal(unbound.binding, "unconfirmed");
  assert.equal(unbound.activity, "unknown"); assert.equal(unbound.result, "pending");
});

test("rexpi_delegate tool preserves task and options through the existing composer", async t => {
  const f = await fixture(t), tools = new Map();
  let current = { runtime: f.runtime, delegation: f.delegation, messaging: f.messaging, cache: f.cache };
  registerDelegationTool({ registerTool: tool => tools.set(tool.name, tool) }, () => current);
  assert.deepEqual([...tools.keys()], ["rexpi_delegate"]);
  const tool = tools.get("rexpi_delegate"), task = "@literal /not-a-command $(unchanged)";
  const input = { task, grant: grant(), focus: false, thinking: "high" };
  const result = await tool.execute("tool-delegation", input, undefined, undefined, f.ctx);
  assert.equal(result.details.handle.requestId, "tool-delegation");
  assert.equal(result.details.creation, "confirmed"); assert.equal(result.details.binding, "bound");
  assert.ok(f.w.created[0].at(-1).startsWith("Task:\n" + task));
  assert.ok(f.w.created[0].includes("--thinking")); assert.ok(f.w.created[0].includes("high"));
  assert.match(result.content[0].text, /activity unknown; result pending/);
  const visible = JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf("\n") + 1));
  assert.deepEqual(visible.handle, result.details.handle, "model-visible text contains the exact launch handle");
  assert.equal(JSON.stringify(result.details).includes("token"), false);
  assert.deepEqual(await tool.execute("tool-delegation", input, undefined, undefined, f.ctx), result);
  current = { cache: f.cache };
  assert.deepEqual(await tool.execute("tool-delegation", input, undefined, undefined, f.ctx), result,
    "historical inspection needs no replacement runtime or grant authority");
  assert.equal(f.w.created.length, 1);
});

test("exact delegation retries inspect one outcome; conflicts and coordinator replacement never relaunch", async t => {
  const f = await fixture(t), options = { grant: grant({ returnResults: true }), notifyParentOnSettlement: true };
  const first = f.delegation.delegate("repeat-delegation", "literal task", options, f.root);
  assert.equal(f.delegation.delegate("repeat-delegation", "literal task", options, f.root), first);
  const original = await first;
  for (const changed of [{ task: "expanded task" }, { options: { ...options, notifyParentOnSettlement: false } },
    { options: { grant: grant({ returnResults: false }) } }])
    await assert.rejects(f.delegation.delegate("repeat-delegation", changed.task ?? "literal task",
      changed.options ?? options, f.root), /Conflicting delegation logical ID/);
  assert.equal(f.w.created.length, 1);
  f.agent.detach();
  const replacement = new DelegationRuntime(f.launcher, f.agent, f.cache);
  assert.equal(replacement.delegate("repeat-delegation", "literal task", options, f.root), first);
  const inspected = await replacement.inspect("repeat-delegation");
  assert.equal(inspected.delegation, original); assert.deepEqual(inspected.status.handle, original.handle);
  assert.equal(inspected.delegation.binding, "bound", "original launch evidence is immutable");
  assert.equal(inspected.status.lifecycle.binding, "unknown", "replacement status is separate evidence");
  await assert.rejects(replacement.inspect("missing-delegation"), /Unknown delegation logical ID/);
  assert.equal(f.w.created.length, 1);
});

test("delegation admission snapshots mutable task grants before deferred launch", async t => {
  const f = await fixture(t), options = { grant: grant(), notifyParentOnSettlement: false };
  const pending = f.delegation.delegate("snapshot-delegation", "literal task", options, f.root);
  options.grant.tools.push("bash"); options.notifyParentOnSettlement = true;
  const result = await pending, encoded = f.w.created[0].find(value => value.startsWith(CAPABILITY_GRANT_ENV + "="));
  assert.deepEqual(decodeCapabilityGrant(encoded.slice(encoded.indexOf("=") + 1)), grant());
  assert.deepEqual(result.subscription, { settlement: false });
  assert.equal(f.w.created.length, 1);
  await assert.rejects(f.delegation.delegate("snapshot-delegation", "literal task", options, f.root),
    /Conflicting delegation logical ID/);
  assert.equal(f.w.created.length, 1);
});

test("uncertain creation and rejected inputs remain fenced by their original logical IDs", async t => {
  const f = await fixture(t); f.w.failCreate = true;
  const unknown = await f.delegation.delegate("uncertain-delegation", "task", { grant: grant() }, f.root);
  assert.equal(unknown.creation, "unknown");
  assert.equal(await f.delegation.delegate("uncertain-delegation", "task", { grant: grant() }, f.root), unknown);
  assert.equal(f.w.created.length, 1);
  const rejected = f.delegation.delegate("rejected-delegation", "task", { grant: grant({ timeoutMs: 0 }) }, f.root);
  await assert.rejects(rejected, /timeoutMs/);
  await assert.rejects(f.delegation.delegate("rejected-delegation", "task", { grant: grant() }, f.root),
    /Conflicting delegation logical ID/);
  assert.equal(f.w.created.length, 1, "a corrected grant cannot acquire a new launch under a rejected ID");
});

test("delegation deduplication binds the literal parent cwd without launching on changed scope", async t => {
  const f = await fixture(t), options = { grant: grant() };
  await f.delegation.delegate("cwd-scoped-delegation", "literal task", options, f.root);
  await assert.rejects(f.delegation.delegate("cwd-scoped-delegation", "literal task", options, join(f.root, "other")),
    /Conflicting delegation logical ID/);
  assert.equal(f.w.created.length, 1);
});

test("delegation result, cancellation and stop controls preserve the original handle and stale failures", async t => {
  const handle = { version: 1, taskId: "task", conversationId: "conversation", runtimeId: "runtime", runId: "run",
    requestId: "request", messageId: "message", endpointGeneration: 1 };
  const source = { taskId: "task", conversationId: "parent", piSessionId: "session", role: "main" }, calls = [];
  const controls = {
    async status(value) { calls.push(["status", value]); return { handle: value, state: "status" }; },
    async result(value, orientation, signal) { calls.push(["result", value, orientation, signal]); return { handle: value, state: "ready" }; },
    async cancel(value, orientation) { calls.push(["cancel", value, orientation]); return { handle: value, state: "acknowledged" }; },
    async stop(value, orientation, authorize) { calls.push(["stop", value, orientation, authorize]); return { handle: value, state: "disconnected" }; },
  };
  const delegation = new DelegationRuntime({ launch() { throw new Error("Controls cannot launch"); } }, controls);
  assert.equal((await delegation.status(handle)).handle, handle);
  assert.equal((await delegation.result(handle, source)).handle, handle);
  assert.equal((await delegation.cancel(handle, source)).handle, handle);
  assert.equal((await delegation.stop(handle, source, true)).handle, handle);
  assert.deepEqual(calls.map(call => call[0]), ["status", "result", "cancel", "stop"]);
  for (const call of calls) assert.equal(call[1], handle);
  assert.deepEqual(calls.find(call => call[0] === "stop")[3], { authorize: true });
  const stale = new Error("Stale original endpoint");
  controls.result = async () => { throw stale; };
  await assert.rejects(delegation.result(handle, source), error => error === stale);
  const noControls = new DelegationRuntime({ launch() { throw new Error("No launch expected"); } });
  assert.throws(() => noControls.cancel(handle, source), /unavailable/);
});

test("delegation stop uses the real authorization object contract", async t => {
  const f = await fixture(t), result = await f.delegation.delegate("real-stop-contract", "task", { grant: grant() }, f.root);
  const stopped = await f.delegation.stop(result.handle, f.runtime.snapshot().state, true);
  assert.equal(stopped.state, "disconnected");
});
