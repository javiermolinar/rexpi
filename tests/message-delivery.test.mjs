import test from "node:test";
import assert from "node:assert/strict";
import { acceptedMessageDelivery, createMessageDelivery, MessageDeliveryLedger, messageDeliveryEvidenceId,
  parseMessageDelivery, reduceMessageDelivery, unknownMessageDelivery } from "../lib/messaging/delivery.ts";
import { uuid } from "./fixtures.mjs";

const observe = (messageId, kind, source, evidenceId = uuid()) => ({ messageId, kind, source, evidenceId });

test("void send and durable mailbox acceptance leave every target acknowledgement unknown", () => {
  for (const [source, current] of [["peer-send-returned", acceptedMessageDelivery(uuid(), "peer-send-returned")],
    ["mailbox-queued", acceptedMessageDelivery(uuid(), "mailbox-queued")],
    ["mailbox-duplicate", acceptedMessageDelivery(uuid(), "mailbox-duplicate")],
    ["send-unknown", unknownMessageDelivery(uuid())]]) {
    assert.equal(current.observations[0].source, source);
    if (source === "send-unknown") {
      assert.equal(current.state, "unknown"); assert.equal(current.acceptance, "unknown");
    } else {
      assert.equal(current.state, "accepted"); assert.equal(current.acceptance, "accepted");
    }
    assert.equal(current.delivery, "unknown"); assert.equal(current.processing, "unknown");
    assert.equal(current.settlement, "unknown");
    assert.deepEqual(parseMessageDelivery(current), current);
  }
});

test("explicit target evidence advances only its own claim and never backfills missing acknowledgements", () => {
  const messageId = uuid();
  let current = reduceMessageDelivery(createMessageDelivery(), observe(messageId, "settled", "sdk-target-settled"));
  assert.equal(current.state, "settled"); assert.equal(current.settlement, "settled");
  assert.equal(current.acceptance, "unknown"); assert.equal(current.delivery, "unknown"); assert.equal(current.processing, "unknown");
  const delivered = observe(messageId, "delivered", "sdk-target-delivered");
  const reordered = reduceMessageDelivery(current, delivered);
  assert.equal(reordered.state, "settled", "late delivery evidence does not regress settlement");
  assert.equal(reordered.delivery, "delivered"); assert.equal(reordered.processing, "unknown");
  assert.deepEqual(reduceMessageDelivery(reordered, delivered), reordered, "exact observation retry is idempotent");
  current = reduceMessageDelivery(reordered, observe(messageId, "processing", "sdk-target-processing"));
  assert.equal(current.state, "settled"); assert.equal(current.processing, "processing");
  assert.equal(current.acceptance, "unknown", "processing does not fabricate transport acceptance");
});

test("disconnect, replacement and unknown outcomes preserve prior positive evidence without upgrading it", () => {
  const messageId = uuid(), accepted = acceptedMessageDelivery(messageId, "peer-send-returned");
  const disconnected = reduceMessageDelivery(accepted, observe(messageId, "unknown", "disconnect"));
  assert.equal(disconnected.state, "accepted"); assert.equal(disconnected.acceptance, "accepted");
  assert.equal(disconnected.delivery, "unknown"); assert.equal(disconnected.processing, "unknown");
  const replaced = reduceMessageDelivery(disconnected, observe(messageId, "unknown", "replacement"));
  assert.equal(replaced.state, "accepted"); assert.equal(replaced.settlement, "unknown");
  assert.equal(replaced.observations.length, 3);
  const retried = reduceMessageDelivery(replaced, observe(messageId, "accepted", "peer-send-returned",
    messageDeliveryEvidenceId(messageId, "peer-send-returned")));
  assert.deepEqual(retried, replaced, "exact accepted retry does not duplicate evidence");
  let compacted = accepted;
  for (let i = 0; i < 12; i++) compacted = reduceMessageDelivery(compacted, observe(messageId, "unknown", "disconnect"));
  assert.equal(compacted.observations.length, 8); assert.equal(compacted.state, "accepted");
  assert.equal(compacted.acceptance, "accepted", "history compaction cannot erase acceptance");
  compacted = reduceMessageDelivery(compacted, observe(messageId, "delivered", "sdk-target-delivered"));
  assert.equal(compacted.acceptance, "accepted"); assert.equal(compacted.delivery, "delivered");
});

test("miscorrelated, conflicting and evidence-free lifecycle claims fail closed", () => {
  const messageId = uuid(), evidenceId = uuid();
  const current = reduceMessageDelivery(createMessageDelivery(), observe(messageId, "accepted", "peer-send-returned", evidenceId));
  assert.throws(() => reduceMessageDelivery(current, observe(uuid(), "delivered", "sdk-target-delivered")), /Conflicting/);
  assert.throws(() => reduceMessageDelivery(current, observe(messageId, "delivered", "sdk-target-delivered", evidenceId)), /Conflicting/);
  for (const value of [observe(messageId, "processing", "agent_start"),
    observe(messageId, "delivered", "isIdle"), observe(messageId, "settled", "agent_settled"),
    observe(messageId, "accepted", "mailbox-queued", "not-uuid")])
    assert.throws(() => reduceMessageDelivery(createMessageDelivery(), value), /Invalid/);
  assert.throws(() => parseMessageDelivery({ ...current, processing: "processing" }), /not supported/);
  assert.throws(() => parseMessageDelivery({ ...current, observations: [current.observations[0], current.observations[0]] ,
    acceptance: "unknown" }), /not supported/);
});

test("bounded ledger retains exact evidence without making conversation lifecycle a message acknowledgement", () => {
  const ledger = new MessageDeliveryLedger(), messageId = uuid();
  ledger.prepare(messageId);
  assert.equal(ledger.read(messageId).state, "unknown");
  const accepted = ledger.observe(observe(messageId, "accepted", "sdk-followup-returned"));
  assert.equal(accepted.state, "accepted"); assert.equal(accepted.delivery, "unknown");
  ledger.record(unknownMessageDelivery(messageId, "disconnect"));
  assert.equal(ledger.read(messageId).state, "accepted");
  assert.equal(ledger.read(uuid()).state, "unknown");
  const other = uuid();
  for (let i = 0; i < 1022; i++) ledger.prepare(`00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`);
  ledger.prepare(other);
  assert.throws(() => ledger.prepare(uuid()), /bound reached/);
});
