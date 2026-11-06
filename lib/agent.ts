import { record, uuid, type Identity } from "./state.ts";

export const AGENT_HANDLE_VERSION = 1 as const;
export const AGENT_BOOTSTRAP_ENV = "PI_REX_AGENT_HANDLE";
export const AGENT_NOTIFY_SETTLEMENT_ENV = "PI_REX_AGENT_NOTIFY_SETTLEMENT";
const MAX_AGENT_BOOTSTRAP_BYTES = 2048;

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HANDLE_FIELDS = ["version", "taskId", "conversationId", "runtimeId", "runId", "requestId", "messageId", "endpointGeneration"] as const;

/**
 * Public, token-free correlation for one agent run at one endpoint incarnation.
 * endpointGeneration changes when the endpoint is replaced; it is not an activity state.
 */
export interface AgentHandle {
  version: typeof AGENT_HANDLE_VERSION;
  taskId: string;
  conversationId: string;
  runtimeId: string;
  runId: string;
  requestId: string;
  messageId: string;
  endpointGeneration: number;
}

export type AgentHandleExpectation = Partial<Omit<AgentHandle, "version">>;

function exactFields(value: Record<string, unknown>): void {
  const actual = Object.keys(value);
  if (actual.length !== HANDLE_FIELDS.length || HANDLE_FIELDS.some(field => !Object.hasOwn(value, field)))
    throw new Error("AgentHandle requires exactly the versioned token-free identity fields");
}

function endpointGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("Invalid agent endpoint generation");
  return Number(value);
}

/** Parse and whitelist every field so secrets on input cannot leak into a returned handle. */
export function parseAgentHandle(value: unknown, expected: AgentHandleExpectation = {}): AgentHandle {
  const input = record(value);
  exactFields(input);
  if (input.version !== AGENT_HANDLE_VERSION) throw new Error("Unsupported AgentHandle version");
  if (!uuid(input.taskId) || !uuid(input.conversationId) || !uuid(input.runtimeId)
      || !uuid(input.runId) || !uuid(input.messageId) || typeof input.requestId !== "string"
      || !REQUEST_ID.test(input.requestId)) throw new Error("Invalid agent identity or correlation identifier");
  const handle: AgentHandle = Object.freeze({
    version: AGENT_HANDLE_VERSION,
    taskId: input.taskId,
    conversationId: input.conversationId,
    runtimeId: input.runtimeId,
    runId: input.runId,
    requestId: input.requestId,
    messageId: input.messageId,
    endpointGeneration: endpointGeneration(input.endpointGeneration),
  });
  for (const [field, wanted] of Object.entries(expected)) {
    if (wanted === undefined) continue;
    if (!Object.hasOwn(handle, field)) throw new Error("Unknown AgentHandle expectation");
    if (handle[field as keyof AgentHandle] !== wanted) {
      if (field === "endpointGeneration") throw new Error("Stale agent endpoint generation");
      throw new Error("Ambiguous or mismatched agent identity: " + field);
    }
  }
  return handle;
}

/** Bridge an existing related identity without copying session, role, lease, or route secrets. */
export function agentHandleFromIdentity(identity: Identity, correlation: Omit<AgentHandle, "version" | "taskId" | "conversationId">): AgentHandle {
  return parseAgentHandle({ version: AGENT_HANDLE_VERSION, taskId: identity.taskId,
    conversationId: identity.conversationId, ...correlation });
}

export function sameAgentConversation(handle: AgentHandle, identity: Identity): boolean {
  return handle.taskId === identity.taskId && handle.conversationId === identity.conversationId;
}

/** Separate, canonical, token-free launch correlation; never mix it into the orientation bootstrap. */
export function encodeAgentBootstrap(value: unknown): string {
  const encoded = Buffer.from(JSON.stringify(parseAgentHandle(value))).toString("base64url");
  if (Buffer.byteLength(encoded) > MAX_AGENT_BOOTSTRAP_BYTES) throw new Error("Agent handle bootstrap byte bound exceeded");
  return encoded;
}

export function decodeAgentBootstrap(raw: string): AgentHandle {
  if (typeof raw !== "string" || !raw.length || Buffer.byteLength(raw) > MAX_AGENT_BOOTSTRAP_BYTES
      || !/^[A-Za-z0-9_-]+$/.test(raw) || Buffer.from(raw, "base64url").toString("base64url") !== raw)
    throw new Error("Invalid agent handle bootstrap");
  try { return parseAgentHandle(JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))); }
  catch (error) { throw new Error("Invalid agent handle bootstrap: " + (error instanceof Error ? error.message : String(error))); }
}

/** Exact correlation is required; matching only a runtime or run is ambiguous. */
export function assertSameAgentRun(left: unknown, right: unknown): AgentHandle {
  const a = parseAgentHandle(left), b = parseAgentHandle(right);
  for (const field of HANDLE_FIELDS) {
    if (a[field] !== b[field]) {
      if (field === "endpointGeneration") throw new Error("Stale agent endpoint generation");
      throw new Error("Ambiguous or conflicting agent run correlation: " + field);
    }
  }
  return a;
}

/*
 * Independent, last-evidenced lifecycle for exactly one AgentHandle. These are
 * observations, not a scheduler, a clock, or proof that a result is stored.
 * Callers must correlate evidence to the handle before invoking the reducer;
 * the pure reducer cannot authenticate Pi/Rex events or establish freshness.
 *
 * Pi/Rex evidence mapping:
 * - Creation is local only. A unique live Rex binding for the exact endpoint,
 *   with the applicable Rex/process checks and an unexpired Runtime snapshot
 *   generation/signal fence, can justify binding.verified. A snapshot or lease
 *   alone is not proof of execution. A lost lease, aborted signal, disconnect,
 *   or inconclusive verification can justify binding.unknown, but not exit or
 *   replacement. Exit and replacement require positive evidence for that exact
 *   incarnation; replacement makes the old handle stale. Never infer either
 *   from silence, and never resurrect a terminal incarnation.
 * - PeerReadResult.activity maps to activity.sample. ctx.isIdle() === false is
 *   evidence only of a non-idle Pi context ("running" here), not model work,
 *   work on this request, or parent processing. ctx.isIdle() === true is an
 *   instantaneous idle observation, never completion. hasPendingMessages()
 *   is retained as observation input but cannot cause a transition by itself.
 *   A correlated Pi agent-end/settlement observation maps to activity.settled;
 *   it does not record an explicit result and is not erased by a later idle sample.
 * - PeerSendResult.state === "accepted" maps only to delivery.accepted after a
 *   requested notification/send. Its processingConfirmed/completionConfirmed
 *   false values are intentional: SDK acceptance proves neither parent/model
 *   processing nor a result. A send whose outcome became ambiguous after a
 *   write can map to delivery.unknown. Revocation requires positive authority
 *   loss and never retracts a previously accepted send.
 * - result.completed, result.failed, and result.cancelled require explicit
 *   correlated terminal agent-result evidence. Completed maps to ready; failed
 *   and cancelled remain distinct outcomes. Current peer reads and accepted
 *   sends expose none of them. Cancellation acknowledgement maps only to the
 *   nonterminal result.cancelling state: acknowledgement is neither cancelled
 *   execution nor quiescence. Result states never follow from idle, settlement,
 *   exit, replacement, delivery, or one another.
 *
 * Every observation changes only its own axis. In particular, later terminal
 * result evidence remains admissible after exit/replacement, and binding or
 * activity transitions never erase delivery/result evidence. States describe
 * the last evidence, not continuing liveness. Unknown observations, malformed
 * evidence, and transitions absent from the table throw instead of guessing.
 */

export const AGENT_BINDING_STATES = ["created", "bound", "unknown", "exited", "replaced"] as const;
export const AGENT_ACTIVITY_STATES = ["unknown", "running", "idle", "settled"] as const;
export const AGENT_DELIVERY_STATES = ["created", "pending", "accepted", "unknown", "revoked"] as const;
export const AGENT_RESULT_STATES = ["pending", "cancelling", "unknown", "ready", "failed", "cancelled"] as const;

export type AgentBindingState = typeof AGENT_BINDING_STATES[number];
export type AgentActivityState = typeof AGENT_ACTIVITY_STATES[number];
export type AgentDeliveryState = typeof AGENT_DELIVERY_STATES[number];
export type AgentResultState = typeof AGENT_RESULT_STATES[number];
export type AgentStateValue = AgentBindingState | AgentActivityState | AgentDeliveryState | AgentResultState;

export interface AgentLifecycleState {
  /** Endpoint incarnation: replaced means this handle is stale. */
  readonly binding: AgentBindingState;
  /** Last Pi activity sample; running means non-idle, not model processing. */
  readonly activity: AgentActivityState;
  /** Delivery protocol only, including its ambiguous and settled outcomes. */
  readonly delivery: AgentDeliveryState;
  /** Explicit agent outcome; cancelling is only an acknowledgement. */
  readonly result: AgentResultState;
}

export type AgentStateAxis = keyof AgentLifecycleState;

export type AgentStateObservation =
  | { readonly type: "binding.verified" }
  | { readonly type: "binding.unknown" }
  | { readonly type: "binding.exited" }
  | { readonly type: "binding.replaced" }
  | { readonly type: "activity.sample"; readonly idle: boolean; readonly pendingMessages: boolean }
  | { readonly type: "activity.settled" }
  | { readonly type: "delivery.requested" }
  | { readonly type: "delivery.accepted" }
  | { readonly type: "delivery.unknown" }
  | { readonly type: "delivery.revoked" }
  | { readonly type: "cancellation.acknowledged" }
  | { readonly type: "result.pending" }
  | { readonly type: "result.unknown" }
  | { readonly type: "result.completed" }
  | { readonly type: "result.failed" }
  | { readonly type: "result.cancelled" };

export interface AgentStateTransition {
  readonly axis: AgentStateAxis;
  readonly observation: AgentStateObservation["type"];
  readonly from: readonly AgentStateValue[];
  readonly to: AgentStateValue;
  readonly evidence: string;
}

function stateTransition(axis: AgentStateAxis, observation: AgentStateObservation["type"],
    from: readonly AgentStateValue[], to: AgentStateValue, evidence: string): AgentStateTransition {
  return Object.freeze({ axis, observation, from: Object.freeze([...from]), to, evidence });
}

/** The exhaustive evidence-bearing transition table; same-state re-observation is idempotent. */
export const AGENT_STATE_TRANSITIONS: readonly AgentStateTransition[] = Object.freeze([
  stateTransition("binding", "binding.verified", ["created", "unknown"], "bound",
    "Exact current endpoint has a uniquely live verified Rex binding and valid generation/signal fence"),
  stateTransition("binding", "binding.unknown", ["created", "bound"], "unknown",
    "Binding verification or liveness became inconclusive; neither exit nor replacement is known"),
  stateTransition("binding", "binding.exited", ["created", "bound", "unknown"], "exited",
    "Positive exit evidence for this exact endpoint incarnation"),
  stateTransition("binding", "binding.replaced", ["created", "bound", "unknown"], "replaced",
    "Positive replacement evidence makes this exact endpoint generation stale"),
  stateTransition("activity", "activity.sample", ["unknown", "idle"], "running",
    "A fresh correlated Pi sample with idle=false; this says nothing about model or request processing"),
  stateTransition("activity", "activity.sample", ["unknown", "running"], "idle",
    "A fresh correlated Pi sample with idle=true; pending messages and completion are independent"),
  stateTransition("activity", "activity.settled", ["unknown", "running", "idle"], "settled",
    "Correlated Pi agent-end evidence settles activity only, not completion, delivery, or a result"),
  stateTransition("delivery", "delivery.requested", ["created"], "pending",
    "An authorized notification/send was requested; no acceptance or processing is known"),
  stateTransition("delivery", "delivery.accepted", ["pending", "unknown"], "accepted",
    "Correlated send accepted; not parent processing, activity settlement, or completion"),
  stateTransition("delivery", "delivery.unknown", ["created", "pending"], "unknown",
    "Send outcome is ambiguous after a possible write; absence of a response is not a negative result"),
  stateTransition("delivery", "delivery.revoked", ["created", "pending", "unknown"], "revoked",
    "Positive authority loss before accepted delivery; accepted evidence cannot be retracted"),
  stateTransition("result", "result.pending", ["unknown"], "pending",
    "A correlated current run is known to have no explicit terminal result"),
  stateTransition("result", "result.unknown", ["pending", "cancelling"], "unknown",
    "Result evidence is unavailable or ambiguous; terminal retained evidence is never overwritten"),
  stateTransition("result", "cancellation.acknowledged", ["pending", "unknown"], "cancelling",
    "Cancellation request was acknowledged; neither terminal cancellation nor quiescence is established"),
  stateTransition("result", "result.completed", ["pending", "unknown", "cancelling"], "ready",
    "Explicit correlated completed result is available, independent of idle and delivery"),
  stateTransition("result", "result.failed", ["pending", "unknown", "cancelling"], "failed",
    "Explicit correlated failed result is available, independent of activity and binding"),
  stateTransition("result", "result.cancelled", ["pending", "unknown", "cancelling"], "cancelled",
    "Explicit correlated cancelled result is available, independent of activity and binding"),
]);

const AGENT_STATE_FIELDS = ["binding", "activity", "delivery", "result"] as const;

function stateFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field)))
    throw new Error(label + " requires exactly its declared evidence fields");
}

function stateValue<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** Strictly parse a snapshot without adding persisted completion or transport behavior. */
export function parseAgentLifecycleState(value: unknown): AgentLifecycleState {
  const input = record(value);
  stateFields(input, AGENT_STATE_FIELDS, "AgentLifecycleState");
  if (!stateValue(input.binding, AGENT_BINDING_STATES) || !stateValue(input.activity, AGENT_ACTIVITY_STATES)
      || !stateValue(input.delivery, AGENT_DELIVERY_STATES) || !stateValue(input.result, AGENT_RESULT_STATES))
    throw new Error("Invalid agent lifecycle state");
  return Object.freeze({ binding: input.binding, activity: input.activity,
    delivery: input.delivery, result: input.result });
}

/** Local creation proves no binding, activity, remote delivery, or result. */
export function createAgentLifecycleState(): AgentLifecycleState {
  return Object.freeze({ binding: "created", activity: "unknown", delivery: "created", result: "pending" });
}

function observedAxis(value: unknown): AgentStateAxis {
  const input = record(value);
  switch (input.type) {
    case "binding.verified": case "binding.unknown": case "binding.exited": case "binding.replaced":
      stateFields(input, ["type"], "Binding observation");
      return "binding";
    case "activity.sample":
      stateFields(input, ["type", "idle", "pendingMessages"], "Activity observation");
      if (typeof input.idle !== "boolean" || typeof input.pendingMessages !== "boolean")
        throw new Error("Activity observation requires the Pi idle and pendingMessages booleans");
      return "activity";
    case "activity.settled":
      stateFields(input, ["type"], "Settlement observation");
      return "activity";
    case "delivery.requested": case "delivery.accepted": case "delivery.unknown": case "delivery.revoked":
      stateFields(input, ["type"], "Delivery observation");
      return "delivery";
    case "cancellation.acknowledged": case "result.pending": case "result.unknown":
    case "result.completed": case "result.failed": case "result.cancelled":
      stateFields(input, ["type"], "Result observation");
      return "result";
    default:
      throw new Error("Unsupported or evidence-free agent state observation");
  }
}

/**
 * Apply one already-correlated observation. No implicit transitions or cross-axis
 * guards exist. Ambiguous evidence must use its explicit unknown observation;
 * unsupported attempts fail closed rather than leaving a fabricated transition.
 */
export function reduceAgentLifecycleState(current: AgentLifecycleState,
    observation: AgentStateObservation): AgentLifecycleState {
  const state = parseAgentLifecycleState(current), axis = observedAxis(observation);
  const type = observation.type;
  const candidates = AGENT_STATE_TRANSITIONS.filter(entry => entry.axis === axis && entry.observation === type);
  const input = record(observation);
  const matches = candidates.filter(entry => axis !== "activity" || entry.observation !== "activity.sample"
    || (entry.to === "idle") === input.idle);
  // An idle sample after agent-end does not retract the settlement observation.
  if (axis === "activity" && type === "activity.sample" && state.activity === "settled" && input.idle === true)
    return state;
  const transition = matches.find(entry => entry.to === state[axis])
    ?? matches.find(entry => entry.from.includes(state[axis]));
  if (!transition) throw new Error("Unsupported agent state transition: " + state[axis] + " + " + type);
  return Object.freeze({ ...state, [axis]: transition.to });
}
