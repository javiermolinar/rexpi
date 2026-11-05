import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_HANDLE_VERSION, agentHandleFromIdentity, assertSameAgentRun, parseAgentHandle,
  sameAgentConversation } from "../lib/agent.ts";
import { decodePeerRequest } from "../lib/peer.ts";
import { endpointFromBinding } from "../lib/messaging/protocol.ts";
import { binding, identity, rid, uuid } from "./fixtures.mjs";

function handle(overrides = {}) {
  return { version: AGENT_HANDLE_VERSION, taskId: uuid(), conversationId: uuid(), runtimeId: uuid(),
    runId: uuid(), requestId: "delegation:one", messageId: uuid(), endpointGeneration: 1, ...overrides };
}

test("AgentHandle accepts current related identities and serializes only token-free fields", () => {
  const related = { ...identity("review"), token: uuid(), blockId: rid("block") };
  const value = agentHandleFromIdentity(related, { runtimeId: uuid(), runId: uuid(), requestId: "peer-task",
    messageId: uuid(), endpointGeneration: 1 });
  assert.deepEqual(Object.keys(value).sort(), ["conversationId", "endpointGeneration", "messageId", "requestId",
    "runId", "runtimeId", "taskId", "version"].sort());
  assert.equal(value.taskId, related.taskId); assert.equal(value.conversationId, related.conversationId);
  assert.ok(Object.isFrozen(value)); assert.ok(sameAgentConversation(value, related));
  assert.equal(JSON.stringify(value).includes(related.token), false);
  assert.equal(JSON.stringify(value).includes(related.blockId), false);
  assert.deepEqual(parseAgentHandle(JSON.parse(JSON.stringify(value))), value);
});

test("AgentHandle rejects missing, additional, secret-bearing, and unsupported-version fields", () => {
  for (const key of Object.keys(handle())) {
    const value = handle(); delete value[key];
    assert.throws(() => parseAgentHandle(value), /exactly|Invalid|Unsupported/, key);
  }
  for (const extra of [{ token: uuid() }, { leaseToken: uuid() }, { piSessionId: uuid() }, { id: uuid() }])
    assert.throws(() => parseAgentHandle(handle(extra)), /exactly/);
  assert.throws(() => parseAgentHandle(handle({ version: 0 })), /Unsupported/);
  assert.throws(() => parseAgentHandle(handle({ version: 2 })), /Unsupported/);
});

test("AgentHandle rejects malformed identity and correlation identifiers", () => {
  for (const field of ["taskId", "conversationId", "runtimeId", "runId", "messageId"]) {
    for (const value of [undefined, null, "", "not-a-uuid", uuid().toUpperCase(), 1])
      assert.throws(() => parseAgentHandle(handle({ [field]: value })), /Invalid|exactly/, field + ":" + value);
  }
  for (const requestId of ["", "white space", "slash/value", "x".repeat(129), 1, null])
    assert.throws(() => parseAgentHandle(handle({ requestId })), /Invalid/);
  for (const endpointGeneration of [0, -1, 1.5, NaN, Infinity, "1", null])
    assert.throws(() => parseAgentHandle(handle({ endpointGeneration })), /Invalid agent endpoint/);
});

test("exact endpoint generations reject stale and future endpoint incarnations", () => {
  const current = handle({ endpointGeneration: 7 });
  assert.deepEqual(parseAgentHandle(current, { endpointGeneration: 7 }), current);
  assert.throws(() => parseAgentHandle(current, { endpointGeneration: 6 }), /Stale agent endpoint generation/);
  assert.throws(() => parseAgentHandle(current, { endpointGeneration: 8 }), /Stale agent endpoint generation/);
});

test("partial identity matches and conflicting run correlations are ambiguous", () => {
  const current = handle();
  assert.deepEqual(parseAgentHandle(current, { taskId: current.taskId, requestId: current.requestId }), current);
  for (const field of ["taskId", "conversationId", "runtimeId", "runId", "messageId"])
    assert.throws(() => parseAgentHandle(current, { [field]: uuid() }), /Ambiguous.*field|Ambiguous.*identity/, field);
  assert.throws(() => parseAgentHandle(current, { requestId: "another-request" }), /Ambiguous/);
  assert.throws(() => parseAgentHandle(current, { token: "secret" }), /Unknown AgentHandle expectation/);
  assert.deepEqual(assertSameAgentRun(current, { ...current }), current);
  for (const field of ["taskId", "conversationId", "runtimeId", "runId", "messageId"])
    assert.throws(() => assertSameAgentRun(current, handle({ ...current, [field]: uuid() })), /conflicting/, field);
  assert.throws(() => assertSameAgentRun(current, { ...current, requestId: "other" }), /conflicting/);
  assert.throws(() => assertSameAgentRun(current, { ...current, endpointGeneration: 2 }), /Stale/);
});

test("related peer request routes retain their version-one request envelope with strict correlation", () => {
  const fromIdentity = identity("main"), toIdentity = identity("review");
  toIdentity.taskId = fromIdentity.taskId;
  const from = endpointFromBinding(binding(fromIdentity));
  const to = endpointFromBinding(binding(toIdentity));
  const body = JSON.stringify({ type: "pi-rex.peer", version: 1, id: uuid(), op: "send", from, to,
    params: { id: uuid(), requestId: "peer-task", runId: uuid(), runtimeId: uuid(), inReplyTo: null,
      kind: "question", text: "Review this finding", delivery: "followUp", triggerTurn: true } });
  const decoded = decodePeerRequest(body);
  assert.equal(decoded.from.token, from.token); assert.equal(decoded.to.token, to.token);
  assert.equal(decoded.params.requestId, "peer-task"); assert.equal(decoded.op, "send");
  const publicHandle = handle({ taskId: from.taskId, conversationId: to.conversationId,
    requestId: decoded.params.requestId });
  assert.equal("token" in publicHandle, false); assert.equal("from" in publicHandle, false);
});
