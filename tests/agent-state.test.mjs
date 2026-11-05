import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_STATE_TRANSITIONS, createAgentLifecycleState, parseAgentLifecycleState,
  reduceAgentLifecycleState } from "../lib/agent.ts";

const AXES = ["binding", "activity", "delivery", "result"];
const lifecycle = (overrides = {}) => ({ ...createAgentLifecycleState(), ...overrides });
const reduce = (state, type, evidence = {}) => reduceAgentLifecycleState(state, { type, ...evidence });
const sample = (idle, pendingMessages = false) => ({ type: "activity.sample", idle, pendingMessages });
const observationFor = entry => entry.observation === "activity.sample"
  ? sample(entry.to === "idle", true) : { type: entry.observation };

function assertOnlyAxis(before, after, axis, expected) {
  assert.equal(after[axis], expected);
  for (const other of AXES.filter(value => value !== axis)) assert.equal(after[other], before[other], other);
  assert.ok(Object.isFrozen(after));
}

test("creation is local and every axis starts without remote evidence", () => {
  const state = createAgentLifecycleState();
  assert.deepEqual(state, { binding: "created", activity: "unknown", delivery: "created", result: "pending" });
  assert.ok(Object.isFrozen(state));
  assert.deepEqual(parseAgentLifecycleState(JSON.parse(JSON.stringify(state))), state);
});

test("the exported transition table is frozen, evidenced, exhaustive, and idempotent", () => {
  assert.ok(Object.isFrozen(AGENT_STATE_TRANSITIONS));
  assert.equal(AGENT_STATE_TRANSITIONS.length, 17);
  assert.deepEqual(new Set(AGENT_STATE_TRANSITIONS.map(entry => entry.axis)), new Set(AXES));
  for (const entry of AGENT_STATE_TRANSITIONS) {
    assert.ok(entry.evidence.length > 0); assert.ok(Object.isFrozen(entry)); assert.ok(Object.isFrozen(entry.from));
    const observation = observationFor(entry);
    for (const from of entry.from) {
      const before = lifecycle({ [entry.axis]: from });
      const after = reduceAgentLifecycleState(before, observation);
      assertOnlyAxis(before, after, entry.axis, entry.to);
    }
    const known = lifecycle({ [entry.axis]: entry.to });
    assert.deepEqual(reduceAgentLifecycleState(known, observation), known,
      `${entry.observation} must be idempotent at ${entry.to}`);
  }
});

test("binding uncertainty does not fabricate exit, replacement, or execution", () => {
  const created = createAgentLifecycleState(), bound = reduce(created, "binding.verified");
  assertOnlyAxis(created, bound, "binding", "bound");
  const unknown = reduce(bound, "binding.unknown");
  assertOnlyAxis(bound, unknown, "binding", "unknown");
  assert.equal(reduce(unknown, "binding.verified").binding, "bound");
  const exited = reduce(unknown, "binding.exited");
  assertOnlyAxis(unknown, exited, "binding", "exited");
  assert.throws(() => reduce(exited, "binding.verified"), /Unsupported agent state transition/);
  assert.throws(() => reduce(exited, "binding.unknown"), /Unsupported agent state transition/);
});

test("replacement marks the old incarnation stale without inferring another axis", () => {
  const before = lifecycle({ binding: "bound", activity: "settled", delivery: "accepted", result: "ready" });
  const stale = reduce(before, "binding.replaced");
  assertOnlyAxis(before, stale, "binding", "replaced");
  assert.equal(stale.result, "ready");
  assert.throws(() => reduce(stale, "binding.verified"), /Unsupported agent state transition/);
  assert.throws(() => reduce(stale, "binding.exited"), /Unsupported agent state transition/);
});

test("running, idle, and settlement are activity evidence, never completion", () => {
  const created = createAgentLifecycleState();
  const running = reduceAgentLifecycleState(created, sample(false, true));
  assertOnlyAxis(created, running, "activity", "running");
  assert.equal(running.result, "pending");
  const idle = reduceAgentLifecycleState(running, sample(true, true));
  assertOnlyAxis(running, idle, "activity", "idle");
  assert.equal(idle.result, "pending");
  const settled = reduce(idle, "activity.settled");
  assertOnlyAxis(idle, settled, "activity", "settled");
  assert.equal(settled.result, "pending");
  assert.deepEqual(reduceAgentLifecycleState(settled, sample(true)), settled);
  assert.throws(() => reduceAgentLifecycleState(settled, sample(false)), /Unsupported agent state transition/);
});

test("notification acceptance is not parent processing and revocation cannot retract acceptance", () => {
  const requested = reduce(createAgentLifecycleState(), "delivery.requested");
  assert.equal(requested.delivery, "pending"); assert.equal(requested.activity, "unknown");
  const accepted = reduce(requested, "delivery.accepted");
  assertOnlyAxis(requested, accepted, "delivery", "accepted");
  assert.equal(accepted.result, "pending"); assert.equal(accepted.activity, "unknown");
  assert.throws(() => reduce(accepted, "delivery.revoked"), /Unsupported agent state transition/);
  const revoked = reduce(requested, "delivery.revoked");
  assert.equal(revoked.delivery, "revoked"); assert.equal(revoked.result, "pending");
  assert.throws(() => reduce(revoked, "delivery.accepted"), /Unsupported agent state transition/);
});

test("ambiguous notification delivery can recover only from correlated acceptance", () => {
  const unknown = reduce(createAgentLifecycleState(), "delivery.unknown");
  assert.equal(unknown.delivery, "unknown");
  const accepted = reduce(unknown, "delivery.accepted");
  assertOnlyAxis(unknown, accepted, "delivery", "accepted");
  assert.throws(() => reduce(accepted, "delivery.unknown"), /Unsupported agent state transition/);
});

test("completed, failed, and cancelled results are distinct and independent of settlement", () => {
  for (const [observation, expected] of [["result.completed", "ready"], ["result.failed", "failed"],
      ["result.cancelled", "cancelled"]]) {
    const before = lifecycle({ binding: "created", activity: "running", delivery: "created" });
    const after = reduce(before, observation);
    assertOnlyAxis(before, after, "result", expected);
    assert.equal(after.activity, "running");
    assert.throws(() => reduce(after, "result.unknown"), /Unsupported agent state transition/);
  }
  const settled = reduce(createAgentLifecycleState(), "activity.settled");
  assert.equal(settled.result, "pending");
});

test("result uncertainty is explicit and terminal evidence is never overwritten", () => {
  const pending = createAgentLifecycleState(), unknown = reduce(pending, "result.unknown");
  assertOnlyAxis(pending, unknown, "result", "unknown");
  assert.equal(reduce(unknown, "result.pending").result, "pending");
  const ready = reduce(unknown, "result.completed");
  assert.equal(ready.result, "ready");
  assert.throws(() => reduce(ready, "result.failed"), /Unsupported agent state transition/);
  assert.throws(() => reduce(ready, "result.cancelled"), /Unsupported agent state transition/);
});

test("cancellation acknowledgement is neither cancellation nor quiescence", () => {
  const running = reduceAgentLifecycleState(createAgentLifecycleState(), sample(false));
  const acknowledged = reduce(running, "cancellation.acknowledged");
  assertOnlyAxis(running, acknowledged, "result", "cancelling");
  assert.equal(acknowledged.activity, "running"); assert.equal(acknowledged.delivery, "created");
  const cancelled = reduce(acknowledged, "result.cancelled");
  assertOnlyAxis(acknowledged, cancelled, "result", "cancelled");
  assert.equal(cancelled.activity, "running");
  assert.throws(() => reduce(cancelled, "result.completed"), /Unsupported agent state transition/);
});

test("exit and replacement preserve result evidence and admit late correlated results", () => {
  const ready = lifecycle({ binding: "bound", activity: "running", delivery: "unknown", result: "ready" });
  for (const observation of ["binding.exited", "binding.replaced"]) {
    const after = reduce(ready, observation);
    assertOnlyAxis(ready, after, "binding", observation === "binding.exited" ? "exited" : "replaced");
    assert.equal(after.result, "ready");
  }
  const late = reduce(lifecycle({ binding: "exited", activity: "idle" }), "result.failed");
  assert.equal(late.result, "failed"); assert.equal(late.binding, "exited"); assert.equal(late.activity, "idle");
});

test("reduction does not mutate prior evidence snapshots", () => {
  const before = createAgentLifecycleState(), serialized = JSON.stringify(before);
  reduce(before, "delivery.requested");
  assert.equal(JSON.stringify(before), serialized);
  assert.throws(() => { before.result = "ready"; }, TypeError);
});

test("malformed, additional, unsupported, and evidence-free observations fail closed", () => {
  const state = createAgentLifecycleState();
  for (const observation of [null, {}, { type: "result.inferred" }, { type: "activity.sample" },
      { type: "activity.sample", idle: true }, sample("yes"),
      { type: "delivery.accepted", processingConfirmed: true }, { type: "result.completed", idle: true }])
    assert.throws(() => reduceAgentLifecycleState(state, observation));
});

test("malformed lifecycle snapshots and unsupported axis values fail closed", () => {
  for (const axis of AXES) {
    const missing = lifecycle(); delete missing[axis];
    assert.throws(() => parseAgentLifecycleState(missing), /exactly/);
    assert.throws(() => parseAgentLifecycleState(lifecycle({ [axis]: "inferred" })), /Invalid/);
  }
  assert.throws(() => parseAgentLifecycleState({ ...createAgentLifecycleState(), token: "secret" }), /exactly/);
  assert.throws(() => parseAgentLifecycleState([]), /Expected/);
});
