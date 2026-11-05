import { createHash } from "node:crypto";
import { record, uuid } from "../state.ts";

export const MESSAGE_DELIVERY_STATES = ["accepted", "delivered", "processing", "settled", "unknown"] as const;
export type MessageDeliveryState = typeof MESSAGE_DELIVERY_STATES[number];
export type MessageDeliveryObservation =
  | { readonly kind: "accepted"; readonly source: "peer-send-returned" | "mailbox-queued"
    | "mailbox-duplicate" | "sdk-followup-returned" }
  | { readonly kind: "delivered"; readonly source: "sdk-target-delivered" }
  | { readonly kind: "processing"; readonly source: "sdk-target-processing" }
  | { readonly kind: "settled"; readonly source: "sdk-target-settled" }
  | { readonly kind: "unknown"; readonly source: "send-unknown" | "disconnect" | "replacement" };
export type MessageDeliveryEvidence = MessageDeliveryObservation & {
  readonly messageId: string;
  /** Stable observation identity, not a fabricated delivery acknowledgement. */
  readonly evidenceId: string;
};
export interface MessageDeliverySnapshot {
  readonly state: MessageDeliveryState;
  readonly acceptance: "accepted" | "unknown";
  readonly delivery: "delivered" | "unknown";
  readonly processing: "processing" | "unknown";
  readonly settlement: "settled" | "unknown";
  readonly observations: readonly MessageDeliveryEvidence[];
}

const FIELDS = ["state", "acceptance", "delivery", "processing", "settlement", "observations"];
const SOURCES: Record<MessageDeliveryObservation["kind"], readonly string[]> = {
  accepted: ["peer-send-returned", "mailbox-queued", "mailbox-duplicate", "sdk-followup-returned"],
  delivered: ["sdk-target-delivered"], processing: ["sdk-target-processing"], settled: ["sdk-target-settled"],
  unknown: ["send-unknown", "disconnect", "replacement"],
};
const RANK: Record<MessageDeliveryState, number> = { unknown: 0, accepted: 1, delivered: 2, processing: 3, settled: 4 };
function fields(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key)))
    throw new Error("Unexpected or missing message delivery fields");
}
function evidence(value: unknown): MessageDeliveryEvidence {
  const input = record(value);
  fields(input, ["messageId", "evidenceId", "kind", "source"]);
  if (!uuid(input.messageId) || !uuid(input.evidenceId) || typeof input.kind !== "string"
      || !Object.hasOwn(SOURCES, input.kind) || typeof input.source !== "string"
      || !SOURCES[input.kind as MessageDeliveryObservation["kind"]].includes(input.source))
    throw new Error("Invalid message delivery evidence");
  return Object.freeze({ messageId: input.messageId, evidenceId: input.evidenceId,
    kind: input.kind as MessageDeliveryObservation["kind"], source: input.source } as MessageDeliveryEvidence);
}
export function createMessageDelivery(): MessageDeliverySnapshot {
  return Object.freeze({ state: "unknown", acceptance: "unknown", delivery: "unknown", processing: "unknown",
    settlement: "unknown", observations: Object.freeze([]) });
}
function positiveState(observations: readonly MessageDeliveryEvidence[]): MessageDeliveryState {
  let state: MessageDeliveryState = "unknown";
  for (const observation of observations) if (observation.kind !== "unknown" && RANK[observation.kind] > RANK[state])
    state = observation.kind;
  return state;
}
function snapshot(observations: readonly MessageDeliveryEvidence[]): MessageDeliverySnapshot {
  const accepted = observations.some(item => item.kind === "accepted");
  const delivered = observations.some(item => item.kind === "delivered");
  const processing = observations.some(item => item.kind === "processing");
  const settled = observations.some(item => item.kind === "settled");
  return Object.freeze({ state: positiveState(observations), acceptance: accepted ? "accepted" : "unknown",
    delivery: delivered ? "delivered" : "unknown", processing: processing ? "processing" : "unknown",
    settlement: settled ? "settled" : "unknown", observations: Object.freeze([...observations]) });
}
export function parseMessageDelivery(value: unknown): MessageDeliverySnapshot {
  const input = record(value); fields(input, FIELDS);
  if (!Array.isArray(input.observations) || input.observations.length > 8) throw new Error("Invalid delivery evidence history");
  const observations = input.observations.map(evidence), messageIds = new Set(observations.map(item => item.messageId));
  if (messageIds.size > 1) throw new Error("Message delivery evidence is not correlated to one message");
  const expected = snapshot(observations);
  for (const key of ["state", "acceptance", "delivery", "processing", "settlement"] as const)
    if (input[key] !== expected[key]) throw new Error("Message delivery summary is not supported by its evidence");
  return expected;
}
/** Apply only explicit correlated evidence. Unknown lifecycle observations never erase prior positive evidence. */
export function reduceMessageDelivery(current: MessageDeliverySnapshot, value: unknown): MessageDeliverySnapshot {
  const prior = parseMessageDelivery(current), observation = evidence(value);
  if (prior.observations.length && prior.observations[0].messageId !== observation.messageId)
    throw new Error("Conflicting message delivery correlation");
  const existing = new Map(prior.observations.map(item => [item.evidenceId, item] as const));
  const duplicate = existing.get(observation.evidenceId);
  if (duplicate) {
    if (duplicate.messageId !== observation.messageId || duplicate.kind !== observation.kind
        || duplicate.source !== observation.source) throw new Error("Conflicting message delivery evidence ID");
    return prior;
  }
  const observations = [...prior.observations, observation];
  if (observations.length <= 8) return snapshot(observations);
  // Preserve the first concrete evidence for every claim; trim only redundant later observations.
  const firstByKind = new Map<string, MessageDeliveryEvidence>();
  for (const item of observations) if (!firstByKind.has(item.kind)) firstByKind.set(item.kind, item);
  const keep = new Set([...firstByKind.values()].map(item => item.evidenceId));
  for (let i = observations.length - 1; i >= 0 && keep.size < 8; i--) keep.add(observations[i].evidenceId);
  return snapshot(observations.filter(item => keep.has(item.evidenceId)));
}
export function messageDeliveryEvidenceId(messageId: string, source: MessageDeliveryObservation["source"]): string {
  if (!uuid(messageId) || !Object.values(SOURCES).some(sources => sources.includes(source)))
    throw new Error("Invalid message delivery evidence correlation");
  const hex = createHash("sha256").update(messageId + ":" + source).digest("hex").split("");
  hex[12] = "5"; hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)]
    .map(part => part.join("")).join("-");
}
export function acceptedMessageDelivery(messageId: string,
    source: Extract<MessageDeliveryObservation, { kind: "accepted" }>["source"]): MessageDeliverySnapshot {
  return reduceMessageDelivery(createMessageDelivery(), {
    messageId, evidenceId: messageDeliveryEvidenceId(messageId, source), kind: "accepted", source });
}
export function unknownMessageDelivery(messageId: string,
    source: Extract<MessageDeliveryObservation, { kind: "unknown" }>["source"] = "send-unknown"): MessageDeliverySnapshot {
  return reduceMessageDelivery(createMessageDelivery(), {
    messageId, evidenceId: messageDeliveryEvidenceId(messageId, source), kind: "unknown", source });
}

/** Bounded in-memory evidence only. Replacement cannot turn retained acceptance into a retry permit. */
export class MessageDeliveryLedger {
  private readonly messages = new Map<string, MessageDeliverySnapshot>();
  /** Reserve bounded capacity before a void/native effect without claiming acceptance. */
  prepare(messageId: string): void {
    if (!uuid(messageId)) throw new Error("Invalid message correlation");
    if (!this.messages.has(messageId) && this.messages.size >= 1024)
      throw new Error("Message delivery evidence history bound reached");
    if (!this.messages.has(messageId)) this.messages.set(messageId, createMessageDelivery());
  }
  observe(value: unknown): MessageDeliverySnapshot {
    const observation = evidence(value);
    this.prepare(observation.messageId);
    const current = this.messages.get(observation.messageId)!;
    const next = reduceMessageDelivery(current, observation);
    this.messages.set(observation.messageId, next); return next;
  }
  record(value: unknown): MessageDeliverySnapshot {
    const parsed = parseMessageDelivery(value);
    if (!parsed.observations.length) return parsed;
    let current = parsed;
    for (const observation of parsed.observations) current = this.observe(observation);
    return current;
  }
  read(messageId: string): MessageDeliverySnapshot {
    if (!uuid(messageId)) throw new Error("Invalid message correlation");
    return this.messages.get(messageId) ?? createMessageDelivery();
  }
}
