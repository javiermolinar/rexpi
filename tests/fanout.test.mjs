import test from "node:test";
import assert from "node:assert/strict";
import { FanoutRuntime } from "../lib/fanout.ts";
import { DelegationRuntime } from "../lib/delegation.ts";
import { agentHandleFromIdentity } from "../lib/agent.ts";
import { uuid } from "./fixtures.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject }; };
const grant = (overrides = {}) => ({ tools: ["read"], readPaths: ["."], writePaths: [],
  delegation: { maxDepth: 0 }, returnResults: false, turns: 2, timeoutMs: 1000, ...overrides });
const outcome = (id, creation = "confirmed", binding = "bound") => ({
  handle: { version: 1, taskId: uuid(), conversationId: uuid(), runtimeId: uuid(), runId: uuid(), requestId: id,
    messageId: uuid(), endpointGeneration: 1 },
  creation, binding, activity: "unknown", result: "pending", subscription: { settlement: false },
});
const children = (count, options = {}) => Array.from({ length: count }, (_, i) => ({ id: `child-${i}`,
  task: `literal task ${i}`, options: grant({ turns: i + 1 }), ...options }));
function controlled() {
  const calls = [], gates = new Map(); let active = 0, maximum = 0;
  return { calls, gates,
    get active() { return active; }, get maximum() { return maximum; },
    delegate(id, task, options, cwd, signal) {
      const gate = deferred(); gates.set(id, gate); gates.set(task.replace("literal task ", "child-"), gate);
      active++; maximum = Math.max(maximum, active);
      calls.push({ id, task, options, cwd, signal });
      return gate.promise.finally(() => { active--; });
    },
  };
}

test("fan-out honors bounded concurrency, literal per-child scope and independent handles", async t => {
  const delegate = controlled(), runtime = new FanoutRuntime(delegate), inputs = children(6), admitted = structuredClone(inputs);
  const execution = runtime.start("fanout-bound", inputs, { concurrency: 2, cwd: "/repo" });
  await flush(); assert.deepEqual(delegate.calls.map(call => call.task), ["literal task 0", "literal task 1"]);
  assert.ok(delegate.calls.every(call => call.id.startsWith("fanout:")));
  assert.equal(delegate.maximum, 2); assert.equal(execution.snapshot().dispatching, 2);
  inputs[2].task = "mutated unauthorized task"; inputs[2].options.tools.push("bash");
  for (let i = 0; i < inputs.length; i++) {
    delegate.gates.get(`child-${i}`).resolve(outcome(`child-${i}`)); await flush();
    if (i + 2 < inputs.length) assert.ok(delegate.calls.some(call => call.task === `literal task ${i + 2}`));
  }
  await execution.settled;
  assert.equal(delegate.maximum, 2); assert.equal(delegate.calls.length, 6);
  const snapshot = execution.snapshot();
  assert.equal(snapshot.completed, true); assert.equal(snapshot.stopReason, undefined);
  assert.deepEqual(snapshot.children.map(child => child.state), Array(6).fill("delegated"));
  assert.deepEqual(new Set(snapshot.children.map(child => child.handle.requestId)), new Set(children(6).map(child => child.id)));
  for (const call of delegate.calls) {
    const index = Number(call.task.at(-1));
    assert.equal(call.task, `literal task ${index}`); assert.equal(call.cwd, "/repo");
    assert.deepEqual(call.options, grant({ turns: index + 1 }));
  }
  assert.equal(delegate.calls[2].task, "literal task 2", "start snapshots mutable task input");
  assert.deepEqual(delegate.calls[2].options.tools, ["read"], "start snapshots mutable grant input");
  assert.equal(runtime.start("fanout-bound", admitted, { concurrency: 2, cwd: "/repo" }), execution,
    "exact fan-out repeat inspects the original execution");
  assert.throws(() => runtime.start("fanout-bound", inputs, { concurrency: 2, cwd: "/repo" }), /Conflicting fan-out logical ID/);
  assert.equal(delegate.calls.length, 6);
});

test("dispatch rejection or uncertain evidence stops new launches without cleaning up active handles", async t => {
  for (const mode of ["rejection", "unknown", "unbound"]) {
    const delegate = controlled(), runtime = new FanoutRuntime(delegate);
    const execution = runtime.start("fanout-" + mode, children(5), { concurrency: 2, cwd: "/repo" });
    await flush();
    if (mode === "rejection") delegate.gates.get("child-0").reject(new Error("grant rejected"));
    else delegate.gates.get("child-0").resolve(outcome("child-0", mode === "unknown" ? "unknown" : "confirmed",
      mode === "unbound" ? "unconfirmed" : "bound"));
    delegate.gates.get("child-1").resolve(outcome("child-1"));
    await execution.settled;
    assert.equal(delegate.calls.length, 2, mode);
    const snapshot = execution.snapshot();
    assert.equal(snapshot.children[0].state, "failed"); assert.equal(snapshot.children[1].state, "delegated");
    assert.deepEqual(snapshot.children.slice(2).map(child => child.state), ["blocked", "blocked", "blocked"]);
    assert.equal(snapshot.stopReason, "failure");
    assert.equal(snapshot.children[1].handle.requestId, "child-1", "successful peer handle survives another failure");
  }
});

test("cancellation stops only new dispatch and aborts in-flight admission without replacement", async t => {
  const delegate = controlled(), runtime = new FanoutRuntime(delegate);
  const execution = runtime.start("fanout-cancel", children(5), { concurrency: 2, cwd: "/repo" });
  await flush(); execution.cancel();
  assert.deepEqual(execution.snapshot().children.slice(2).map(child => child.state),
    ["cancelled", "cancelled", "cancelled"]);
  assert.equal(delegate.calls[0].signal.aborted, true); assert.equal(delegate.calls[1].signal.aborted, true);
  delegate.gates.get("child-0").resolve(outcome("child-0")); delegate.gates.get("child-1").resolve(outcome("child-1"));
  await execution.settled;
  assert.equal(delegate.calls.length, 2);
  assert.deepEqual(execution.snapshot().children.slice(0, 2).map(child => child.state), ["delegated", "delegated"]);
  assert.equal(execution.snapshot().stopReason, "cancelled");
  const controller = new AbortController(); controller.abort();
  const idle = runtime.start("fanout-pre-cancel", children(2), { concurrency: 1, cwd: "/repo", signal: controller.signal });
  await idle.settled;
  assert.deepEqual(idle.snapshot().children.map(child => child.state), ["cancelled", "cancelled"]);
  assert.equal(delegate.calls.length, 2);
});

test("authority revocation prevents additional launches and preserves already dispatched evidence", async t => {
  const delegate = controlled(); let allowed = true;
  const runtime = new FanoutRuntime(delegate);
  const execution = runtime.start("fanout-revoked", children(4),
    { concurrency: 1, cwd: "/repo", authority: () => allowed });
  await flush(); allowed = false;
  delegate.gates.get("child-0").resolve(outcome("child-0")); await execution.settled;
  assert.equal(delegate.calls.length, 1);
  assert.equal(execution.snapshot().children[0].state, "delegated");
  assert.deepEqual(execution.snapshot().children.slice(1).map(child => child.state), ["revoked", "revoked", "revoked"]);
  assert.equal(execution.snapshot().stopReason, "revoked");
  const throwing = runtime.start("fanout-revocation-error", children(2),
    { concurrency: 1, cwd: "/repo", authority: () => { throw new Error("revoked"); } });
  await throwing.settled;
  assert.deepEqual(throwing.snapshot().children.map(child => child.state), ["revoked", "revoked"]);
  assert.equal(delegate.calls.length, 1);
});

test("identical child IDs in different fan-outs use independent delegation outcomes", async () => {
  let launches = 0;
  const origin = { taskId: uuid(), conversationId: uuid(), piSessionId: "parent", role: "main" };
  const launcher = { async launch(id) {
    launches++;
    const identity = { taskId: origin.taskId, conversationId: uuid(), piSessionId: "child-" + launches, role: "chat" };
    const handle = agentHandleFromIdentity(identity, { runtimeId: uuid(), runId: uuid(), requestId: id,
      messageId: uuid(), endpointGeneration: 1 });
    return { launchId: id, creation: "confirmed", placement: "tab", identity, origin,
      startup: { state: "bound" }, handle };
  } };
  const delegation = new DelegationRuntime(launcher), runtime = new FanoutRuntime(delegation);
  const inputs = [{ id: "shared-child", task: "same task", options: { grant: grant({ tools: ["read", "rexpi_agent_complete"] }) } }];
  const first = runtime.start("batch-a", inputs, { concurrency: 1, cwd: "/repo" });
  await first.settled;
  const second = runtime.start("batch-b", inputs, { concurrency: 1, cwd: "/repo" });
  await second.settled;
  assert.equal(launches, 2, JSON.stringify({ first: first.snapshot(), second: second.snapshot() }));
  assert.notEqual(first.snapshot().children[0].handle.conversationId, second.snapshot().children[0].handle.conversationId);
  assert.notEqual(first.snapshot().children[0].handle.requestId, second.snapshot().children[0].handle.requestId);
  assert.equal(runtime.start("batch-a", inputs, { concurrency: 1, cwd: "/repo" }), first);
  assert.equal(runtime.start("batch-b", inputs, { concurrency: 1, cwd: "/repo" }), second);
  assert.equal(launches, 2);
});

test("invalid batches reject before any child launch", async () => {
  const delegate = controlled(), runtime = new FanoutRuntime(delegate);
  assert.throws(() => runtime.start("duplicates", [children(1)[0], children(1)[0]], { concurrency: 1, cwd: "/repo" }), /unique/);
  for (const concurrency of [0, 9, 1.5, NaN])
    assert.throws(() => runtime.start("bad-concurrency", children(1), { concurrency, cwd: "/repo" }), /concurrency/);
  assert.throws(() => runtime.start("too-many", children(65), { concurrency: 2, cwd: "/repo" }), /at most 64/);
  assert.equal(delegate.calls.length, 0);
});
