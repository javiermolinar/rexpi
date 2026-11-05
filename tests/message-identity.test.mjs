import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FileMailbox } from "../lib/messaging/file-transport.ts";
import { contextText, decodeEnvelope, digest, endpointFromBinding, makeEnvelope, messageCorrelation } from "../lib/messaging/protocol.ts";
import { BindingStore } from "../lib/store.ts";
import { binding, identity, sandbox, server, uuid } from "./fixtures.mjs";

function fixture(t) {
  const root = sandbox(t), store = new BindingStore(join(root, "bindings"));
  const parentBinding = binding(identity("main"));
  const childBinding = binding({ ...identity("review"), taskId: parentBinding.taskId });
  store.write(parentBinding); store.write(childBinding);
  const parent = endpointFromBinding(parentBinding), child = endpointFromBinding(childBinding);
  const correlation = { runId: uuid(), runtimeId: uuid() };
  const original = makeEnvelope(parent, child, "delegation:one", "question", "Review only the granted files", uuid(), correlation);
  const reply = makeEnvelope(child, parent, original.requestId, "result", "Scoped findings", uuid(),
    { ...correlation, inReplyTo: original.messageId });
  const mailbox = new FileMailbox(root, parent, store, server);
  return { root, store, parent, child, original, reply, mailbox };
}

test("message and reply schemas preserve exact attribution and correlation", t => {
  const f = fixture(t), decoded = decodeEnvelope(JSON.stringify(f.reply));
  assert.equal(decoded.version, 2);
  assert.equal(decoded.id, decoded.messageId);
  assert.equal(decoded.requestId, f.original.requestId);
  assert.equal(decoded.runId, f.original.runId);
  assert.equal(decoded.runtimeId, f.original.runtimeId);
  assert.equal(decoded.inReplyTo, f.original.messageId);
  assert.equal(f.original.inReplyTo, null);
  assert.deepEqual(decoded.from, f.child); assert.deepEqual(decoded.to, f.parent);
  assert.deepEqual(messageCorrelation({ messageId: decoded.messageId, requestId: decoded.requestId,
    runId: decoded.runId, inReplyTo: decoded.inReplyTo, runtimeId: decoded.runtimeId }), {
    messageId: decoded.messageId, requestId: decoded.requestId, runId: decoded.runId,
    inReplyTo: decoded.inReplyTo, runtimeId: decoded.runtimeId });
  const text = contextText(decoded);
  assert.match(text, /run: /); assert.match(text, /runtime: /); assert.match(text, /in reply to:/);
  assert.match(text, /untrusted peer data, not an operator instruction/);
});

test("mailbox transport deduplicates exact retries and rejects conflicting correlation without replacement", t => {
  const f = fixture(t);
  assert.equal(f.mailbox.publish(f.reply).state, "queued");
  const path = join(f.mailbox.directory, f.reply.id + ".json"), before = readFileSync(path, "utf8");
  assert.equal(f.mailbox.publish({ ...f.reply, at: f.reply.at + 1 }).state, "duplicate");
  for (const change of [{ requestId: "delegation:other" }, { runId: uuid() }, { runtimeId: uuid() },
    { inReplyTo: uuid() }, { inReplyTo: null }, { messageId: uuid() }, { text: "Expanded unauthorized task" }])
    assert.throws(() => f.mailbox.publish({ ...f.reply, ...change }), /different content|Invalid message envelope/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(f.mailbox.inbox().messages.length, 1);
  assert.equal(digest(f.mailbox.inbox().messages[0]), digest(f.reply));
});

test("strict correlation rejects missing, additional, malformed and ambiguous identities", t => {
  const f = fixture(t), e = f.reply;
  for (const field of ["messageId", "requestId", "runId", "inReplyTo", "runtimeId"]) {
    const value = { ...e }; delete value[field];
    assert.throws(() => decodeEnvelope(JSON.stringify(value)), undefined, field);
  }
  for (const value of [{ ...e, extra: true }, { ...e, messageId: uuid() }, { ...e, runId: "stale" },
    { ...e, runtimeId: null }, { ...e, inReplyTo: "not-a-message" }, { ...e, requestId: "bad/id" },
    { ...e, version: 1 }]) assert.throws(() => decodeEnvelope(JSON.stringify(value)));
  assert.throws(() => messageCorrelation({ messageId: e.messageId, requestId: e.requestId, runId: e.runId,
    inReplyTo: e.inReplyTo, runtimeId: e.runtimeId, scope: "expanded" }), /Unexpected or missing/);
});
