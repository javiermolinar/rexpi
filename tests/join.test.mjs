import test from "node:test";
import assert from "node:assert/strict";
import { JoinCache, JoinRuntime, MAX_JOIN_OUTCOME_BYTES } from "../lib/join.ts";
import { uuid } from "./fixtures.mjs";

const source = { taskId: uuid(), conversationId: uuid(), piSessionId: uuid(), role: "main" };
const handle = id => ({ version: 1, taskId: source.taskId, conversationId: uuid(), runtimeId: uuid(), runId: uuid(),
  requestId: id, messageId: uuid(), endpointGeneration: 1 });
const result = (id, state) => ({ handle: handle(id), runtimeId: uuid(), runId: uuid(), requestId: id, state,
  evidence: "current", notice: "fixture" });
const child = (id, state = "delegated", extra = {}) => ({ id, task: `task ${id}`, options: {}, state,
  ...(state === "delegated" ? { handle: handle(id), delegation: { creation: "confirmed", binding: "bound" } } : {}), ...extra });
function execution(children, settled = Promise.resolve()) {
  return { settled, snapshot: () => structuredClone({ id: "fanout-join", children, completed: true, dispatching: 0 }),
    cancel() { throw new Error("Join cannot cancel dispatch"); } };
}

test("join preserves partial success, child failure, cancellation, stale and unknown outcomes", async () => {
  const children = [child("ready"), child("failed"), child("pending"), child("cancelled"), child("stale")];
  const calls = [];
  const delegation = { async result(handle) {
    const id = handle.requestId; calls.push(id);
    if (id === "stale") throw new Error("stale endpoint");
    return result(id, id === "pending" ? "pending" : id);
  } };
  const joined = await new JoinRuntime(delegation).join(execution(children), source);
  assert.equal(joined.state, "partial"); assert.equal(joined.completed, false); assert.equal(joined.coordinator, "complete");
  assert.deepEqual(joined.children.map(child => child.state), ["succeeded", "failed", "unknown", "cancelled", "unknown"]);
  assert.equal(joined.children[0].result.state, "ready"); assert.equal(joined.children[1].result.state, "failed");
  assert.equal(joined.children[2].result.state, "pending"); assert.match(joined.children[4].error, /stale endpoint/);
  assert.equal(joined.children.length, children.length); assert.ok(joined.bytes <= MAX_JOIN_OUTCOME_BYTES);
  assert.deepEqual(calls.sort(), ["cancelled", "failed", "pending", "ready", "stale"]);
});

test("terminal joins cache evidence while explicit partial refresh only rereads results", async () => {
  let state = "pending", calls = 0;
  const delegation = { async result(handle) { calls++; return result(handle.requestId, state); } };
  const cache = new JoinCache(), join = new JoinRuntime(delegation, cache), run = execution([child("recover")]);
  const partial = await join.join(run, source);
  assert.equal(partial.children[0].state, "unknown"); assert.equal(calls, 1);
  state = "ready";
  const recovered = await join.join(run, source);
  assert.equal(recovered.children[0].state, "succeeded"); assert.equal(recovered.completed, true); assert.equal(calls, 2);
  const replacementControls = { async result() { throw new Error("terminal join must not reread"); } };
  const replacement = new JoinRuntime(replacementControls, cache);
  assert.equal(await replacement.join(run, source), recovered, "replacement reuses terminal outcome without new work");
});

test("dispatch failure, blocked, revoked and cancelled children remain distinct", async () => {
  const children = [child("failed", "failed", { error: "grant rejected" }), child("blocked", "blocked"),
    child("revoked", "revoked"), child("cancelled", "cancelled")];
  const joined = await new JoinRuntime({ result() { throw new Error("No result read expected"); } })
    .join(execution(children), source);
  assert.deepEqual(joined.children.map(child => child.state), ["failed", "not-dispatched", "not-dispatched", "cancelled"]);
  assert.equal(joined.state, "partial"); assert.equal(joined.completed, true);
  assert.equal(joined.children[0].error, "grant rejected");
});

test("coordinator interruption returns current evidence without result reads or duplicated work", async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const children = [child("dispatching", "dispatching"), child("queued", "queued"), child("delegated")];
  let reads = 0;
  const join = new JoinRuntime({ async result() { reads++; return result("delegated", "ready"); } });
  const controller = new AbortController();
  const pending = join.join(execution(children, waiting), source, controller.signal);
  controller.abort();
  const interrupted = await pending;
  assert.equal(interrupted.coordinator, "interrupted"); assert.equal(interrupted.completed, false);
  assert.deepEqual(interrupted.children.map(child => child.state), ["unknown", "unknown", "unknown"]);
  assert.equal(reads, 0); release();
});

test("interruption during result retrieval preserves completed children and marks only unresolved evidence unknown", async () => {
  const controller = new AbortController(); let calls = 0;
  const delegation = { async result(handle, _source, signal) {
    calls++;
    if (handle.requestId === "ready") return result("ready", "ready");
    controller.abort(); assert.equal(signal.aborted, true); throw new Error("transport interrupted");
  } };
  const joined = await new JoinRuntime(delegation).join(execution([child("ready"), child("unknown")]), source, controller.signal);
  assert.equal(joined.coordinator, "interrupted");
  assert.deepEqual(joined.children.map(child => child.state), ["succeeded", "unknown"]);
  assert.equal(joined.children[0].result.state, "ready"); assert.match(joined.children[1].error, /interrupted/);
  assert.equal(calls >= 1, true);
});

test("join identity conflicts reject without replacing an existing outcome", async () => {
  const join = new JoinRuntime({ async result(handle) { return result(handle.requestId, "ready"); } });
  const run = execution([child("stable")]);
  const first = await join.join(run, source);
  const changed = execution([child("stable")]);
  changed.snapshot = () => ({ id: "fanout-join", children: [{ ...child("stable"), task: "changed task" }],
    completed: true, dispatching: 0 });
  await assert.rejects(join.join(changed, source), /Conflicting fan-out join identity/);
  assert.equal(await join.join(run, source), first);
});
