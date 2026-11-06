import { isPeerAgentCancelUnknownError, isPeerAgentResultEvidenceError, isPeerSendUnknownError, peerAgentNotificationId,
  type PeerAgentActivityResult, type PeerAgentCancelLocalResult, type PeerAgentCancelProvider,
  type PeerAgentCancelReason, type PeerAgentCancelResult, type PeerAgentNotification, type PeerAgentResultProvider,
  type PeerAgentResultResult, type PeerAgentStopLocalResult, type PeerAgentStopProvider,
  type PeerAgentStopReason, type PeerAgentStopResult, type PeerSendResult, isPeerAgentStopUnknownError } from "./peer.ts";
import {
  assertSameAgentRun, createAgentLifecycleState, parseAgentHandle, reduceAgentLifecycleState,
  sameAgentConversation, type AgentHandle, type AgentLifecycleState, type AgentStateObservation,
} from "./agent.ts";
import { identity as parseIdentity, parseOrientation, record, type Identity, type Orientation } from "./state.ts";

export const MAX_AGENT_RUNS = 64;
export const MAX_AGENT_EVENTS_PER_RUN = 256;
export const MAX_AGENT_EVENT_PAGE_SIZE = 100;
export const MAX_AGENT_EVENT_BYTES = 4096;
export const MAX_AGENT_EVENT_PAGE_BYTES = 48 * 1024;
export const MAX_AGENT_STATUS_BYTES = 16 * 1024;
export const MAX_AGENT_CURSOR_BYTES = 2048;
export const MAX_AGENT_COMPLETION_SUMMARY_BYTES = 8 * 1024;
export const MAX_AGENT_COMPLETION_ARTIFACTS = 32;
export const MAX_AGENT_COMPLETION_ARTIFACT_BYTES = 2048;
export const MAX_AGENT_COMPLETION_ERROR_CODE_BYTES = 128;
export const MAX_AGENT_COMPLETION_ERROR_MESSAGE_BYTES = 2048;
export const MAX_AGENT_COMPLETION_ERROR_DETAILS_BYTES = 4096;
export const MAX_AGENT_COMPLETION_BYTES = 16 * 1024;
export const MAX_AGENT_RESULT_BYTES = 20 * 1024;
export const MAX_AGENT_RESULT_WAIT_MS = 30_000;
const AGENT_RESULT_WAIT_POLL_MS = 100;
export const MAX_AGENT_CANCELLATION_BYTES = 4096;
export const MAX_AGENT_STOP_BYTES = 4096;

const AGENT_READ_NOTICE = "Correlated observations only; idle/settled is not completion, resultAvailable reflects only explicit local completion, and retained evidence is not remote liveness.";
const AGENT_RESULT_NOTICE = "Explicit correlated completion only; pending means the target reported no completion, cancelling means only that abort was requested, unknown means unavailable or ambiguous evidence, and retained terminal results do not prove remote liveness. This read triggers no notification or model work.";
const AGENT_CANCEL_NOTICE = "Requested records no acknowledgement. Acknowledged means only that Pi abort was requested for a verified busy target; it proves neither quiescence nor a cancelled result. Settled means no abort was needed for idle, settled, exited, or explicitly terminal work. Unknown is ambiguous and is never automatically retried. Activity, delivery, conversation, events, and explicit result evidence remain independent.";
const AGENT_STOP_NOTICE = "Accepted means Pi shutdown was requested, not that the endpoint exited. Closed requires positive prior exit evidence. Disconnected means definite pre-write or unavailable transport; unknown is ambiguous after a possible request, a shutdown throw, or replacement. No outcome cancels work, retracts delivery/results, or permits automatic retry.";
const TERMINAL_BINDINGS = new Set(["exited", "replaced"]);
const TERMINAL_RESULTS = new Set(["ready", "failed", "cancelled"]);

export interface AgentActivityReader {
  agentActivity(target: string, signal?: AbortSignal): Promise<PeerAgentActivityResult>;
  agentResult?(handle: AgentHandle, signal?: AbortSignal): Promise<PeerAgentResultResult>;
  agentCancel?(handle: AgentHandle, signal?: AbortSignal, expectedEndpointId?: string): Promise<PeerAgentCancelResult>;
  agentStop?(handle: AgentHandle, signal?: AbortSignal, expectedEndpointId?: string): Promise<PeerAgentStopResult>;
  setAgentResultProvider?(provider?: PeerAgentResultProvider): void;
  setAgentCancelProvider?(provider?: PeerAgentCancelProvider): void;
  setAgentStopProvider?(provider?: PeerAgentStopProvider): void;
}

export interface AgentRuntimeOptions {
  maxRuns?: number;
  maxEventsPerRun?: number;
  maxPageSize?: number;
  maxPageBytes?: number;
}

export interface AgentRegistrationOptions {
  /** Explicit per-run opt-in; registration alone never authorizes a notification. */
  notifyParentOnSettlement?: boolean;
}

export interface AgentNotificationSender {
  notifyParent(value: PeerAgentNotification, signal?: AbortSignal): Promise<PeerSendResult>;
}

interface SettlementNotification {
  readonly eventId: string;
  readonly messageId: string;
  authorityRevoked: boolean;
}

export type AgentRuntimeObservation = Extract<AgentStateObservation,
  { type: "binding.verified" | "binding.unknown" | "binding.exited" | "binding.replaced" |
    "activity.sample" | "activity.settled" }>;
export type AgentDeliveryObservation = Extract<AgentStateObservation,
  { type: "delivery.requested" | "delivery.accepted" | "delivery.unknown" | "delivery.revoked" }>;
export type AgentCompletionObservation = Extract<AgentStateObservation,
  { type: "result.pending" | "result.unknown" | "result.completed" | "result.failed" | "result.cancelled" }>;
export type AgentCancellationObservation = Extract<AgentStateObservation, { type: "cancellation.acknowledged" }>
  | { readonly type: "cancellation.requested" | "cancellation.settled" | "cancellation.unknown" };
export type AgentStopObservation = { readonly type: "stop.accepted" | "stop.closed" | "stop.disconnected" | "stop.unknown" };
type AgentRecordedObservation = AgentRuntimeObservation | AgentDeliveryObservation;

export type AgentCompletionOutcome = "completed" | "failed" | "cancelled";
export interface AgentCompletionError {
  readonly code?: string;
  readonly message: string;
  readonly details?: string;
}
export interface AgentCompletion {
  readonly requestId: string;
  readonly runId: string;
  readonly runtimeId: string;
  readonly outcome: AgentCompletionOutcome;
  readonly summary: string;
  readonly artifacts: readonly string[];
  readonly error?: AgentCompletionError;
}

export interface AgentEvent {
  readonly id: string;
  readonly type: "run.registered" | AgentRecordedObservation["type"] | AgentCompletionObservation["type"]
    | AgentCancellationObservation["type"] | AgentStopObservation["type"];
  readonly observation: { readonly type: "run.registered" } | AgentRecordedObservation | AgentCompletionObservation
    | AgentCancellationObservation | AgentStopObservation;
  readonly lifecycle: AgentLifecycleState;
  readonly pendingInput: boolean | null;
}

export type AgentResultState = "pending" | "cancelling" | "unknown" | "ready" | "failed" | "cancelled";
export interface AgentResult {
  readonly handle: AgentHandle;
  readonly runtimeId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly state: AgentResultState;
  readonly outcome?: AgentCompletionOutcome;
  readonly completion?: AgentCompletion;
  readonly evidence: "current" | "retained";
  readonly readError?: string;
  readonly notice: string;
}

export interface AgentStatus {
  readonly handle: AgentHandle;
  readonly runtimeId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly lifecycle: AgentLifecycleState;
  readonly pendingInput: boolean | null;
  readonly resultAvailable: boolean;
  readonly evidence: "current" | "retained";
  readonly readError?: string;
  readonly notice: string;
}

export interface AgentEventPage {
  readonly handle: AgentHandle;
  readonly runtimeId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly events: readonly AgentEvent[];
  readonly bytes: number;
  readonly oldestEventId: string | null;
  readonly latestEventId: string;
  readonly dropped: number;
  readonly resultAvailable: boolean;
  readonly next?: string;
  readonly notice: string;
}

export type AgentCancellationState = "requested" | "acknowledged" | "settled" | "unknown";
export type AgentCancellationReason = PeerAgentCancelReason | "pre-write" | "transport" | "changed";
export interface AgentCancellation {
  readonly handle: AgentHandle;
  readonly runtimeId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly state: AgentCancellationState;
  readonly reason: AgentCancellationReason;
  readonly readError?: string;
  readonly notice: string;
}

export type AgentStopState = "accepted" | "closed" | "disconnected" | "unknown";
export type AgentStopReason = PeerAgentStopReason | "pre-write" | "unavailable" | "transport" | "changed";
export interface AgentStop {
  readonly handle: AgentHandle;
  readonly runtimeId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly state: AgentStopState;
  readonly reason: AgentStopReason;
  readonly readError?: string;
  readonly notice: string;
}

interface RunRecord {
  readonly handle: AgentHandle;
  lifecycle: AgentLifecycleState;
  pendingInput: boolean | null;
  events: AgentEvent[];
  nextEventId: number;
  dropped: number;
  endpointId?: string;
  probe: number;
  notifyParentOnSettlement: boolean;
  notification?: SettlementNotification;
  completion?: AgentCompletion;
  retainedResult?: AgentResult;
  cancellation?: AgentCancellation;
  cancellationPromise?: Promise<AgentCancellation>;
  localCancellation?: PeerAgentCancelLocalResult;
  stop?: AgentStop;
  stopPromise?: Promise<AgentStop>;
  localStop?: PeerAgentStopLocalResult;
}

function key(handle: AgentHandle): string {
  return JSON.stringify([handle.version, handle.taskId, handle.conversationId, handle.runtimeId,
    handle.runId, handle.requestId, handle.messageId, handle.endpointGeneration]);
}
function runKey(handle: AgentHandle): string { return handle.runtimeId + ":" + handle.runId; }
function bound(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error("Invalid " + label);
  return result;
}
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 256);
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Agent result wait aborted")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function completionText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || !value.trim().length) throw new Error(label + " must be a nonblank string");
  if (Buffer.byteLength(value) > maximum) throw new Error(label + " byte bound exceeded");
  return value;
}
function parseCompletion(value: unknown): { completion: AgentCompletion; observation: AgentCompletionObservation } {
  const input = record(value);
  const required = ["requestId", "runId", "runtimeId", "outcome", "summary"] as const;
  const optional = ["artifacts", "error"] as const;
  if (required.some(field => !Object.hasOwn(input, field))
      || Object.keys(input).some(field => !(required as readonly string[]).includes(field)
        && !(optional as readonly string[]).includes(field)))
    throw new Error("Agent completion requires exactly its correlation, outcome, summary, artifacts, and error fields");
  if (input.outcome !== "completed" && input.outcome !== "failed" && input.outcome !== "cancelled")
    throw new Error("Invalid agent completion outcome");
  const rawArtifacts = input.artifacts === undefined ? [] : input.artifacts;
  if (!Array.isArray(rawArtifacts) || rawArtifacts.length > MAX_AGENT_COMPLETION_ARTIFACTS)
    throw new Error("Agent completion artifact count bound exceeded or artifacts are not an array");
  const artifacts = Object.freeze(Array.from(rawArtifacts, (artifact, index) =>
    completionText(artifact, MAX_AGENT_COMPLETION_ARTIFACT_BYTES, "Agent completion artifact " + index)));
  let error: AgentCompletionError | undefined;
  if (input.error !== undefined) {
    const detail = record(input.error);
    if (!Object.hasOwn(detail, "message")
        || Object.keys(detail).some(field => field !== "code" && field !== "message" && field !== "details"))
      throw new Error("Agent completion error requires exactly its code, message, and details fields");
    error = Object.freeze({
      ...(detail.code === undefined ? {} : { code: completionText(detail.code,
        MAX_AGENT_COMPLETION_ERROR_CODE_BYTES, "Agent completion error code") }),
      message: completionText(detail.message, MAX_AGENT_COMPLETION_ERROR_MESSAGE_BYTES,
        "Agent completion error message"),
      ...(detail.details === undefined ? {} : { details: completionText(detail.details,
        MAX_AGENT_COMPLETION_ERROR_DETAILS_BYTES, "Agent completion error details") }),
    });
  }
  const completion: AgentCompletion = Object.freeze({
    requestId: typeof input.requestId === "string" ? input.requestId : "",
    runId: typeof input.runId === "string" ? input.runId : "",
    runtimeId: typeof input.runtimeId === "string" ? input.runtimeId : "",
    outcome: input.outcome,
    summary: completionText(input.summary, MAX_AGENT_COMPLETION_SUMMARY_BYTES, "Agent completion summary"),
    artifacts,
    ...(error ? { error } : {}),
  });
  if (Buffer.byteLength(JSON.stringify(completion)) > MAX_AGENT_COMPLETION_BYTES)
    throw new Error("Agent completion serialized byte bound exceeded");
  const observation: AgentCompletionObservation = { type: `result.${input.outcome}` };
  return { completion, observation };
}
function sameCompletion(left: AgentCompletion, right: AgentCompletion): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function endpointId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid agent endpoint incarnation evidence");
  return value;
}
function eventId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value)) throw new Error("Malformed agent event cursor");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || String(id) !== value) throw new Error("Malformed agent event cursor");
  return id;
}
function encodeCursor(handle: AgentHandle, after: string): string {
  return Buffer.from(JSON.stringify({ version: 1, handle, after })).toString("base64url");
}
function decodeCursor(raw: string, handle: AgentHandle): number {
  if (!raw.length || Buffer.byteLength(raw) > MAX_AGENT_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new Error("Malformed agent event cursor");
  try {
    const canonical = Buffer.from(raw, "base64url").toString("base64url") === raw;
    const value = record(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (!canonical || Object.keys(value).length !== 3 || !Object.hasOwn(value, "version")
        || !Object.hasOwn(value, "handle") || !Object.hasOwn(value, "after") || value.version !== 1)
      throw new Error("Malformed agent event cursor");
    assertSameAgentRun(value.handle, handle);
    return eventId(value.after);
  } catch (error) {
    if (error instanceof Error && /Malformed agent event cursor/.test(error.message)) throw error;
    throw new Error("Foreign, stale, or mismatched agent event cursor: " + errorText(error));
  }
}

/** Local, token-free agent observations. Registration is explicit; remote reads never notify. */
export class AgentRuntime {
  private reader?: AgentActivityReader;
  private notifier?: AgentNotificationSender;
  private epoch = 0;
  private readonly runs = new Map<string, RunRecord>();
  private readonly runIdentities = new Map<string, AgentHandle>();
  private readonly generations = new Map<string, number>();
  private readonly maxRuns: number;
  private readonly maxEvents: number;
  private readonly maxPageSize: number;
  private readonly maxPageBytes: number;

  constructor(reader?: AgentActivityReader, options: AgentRuntimeOptions = {}) {
    this.reader = reader;
    this.maxRuns = bound(options.maxRuns, MAX_AGENT_RUNS, MAX_AGENT_RUNS, "agent run bound");
    this.maxEvents = bound(options.maxEventsPerRun, MAX_AGENT_EVENTS_PER_RUN, MAX_AGENT_EVENTS_PER_RUN, "agent event bound");
    this.maxPageSize = bound(options.maxPageSize, MAX_AGENT_EVENT_PAGE_SIZE, MAX_AGENT_EVENT_PAGE_SIZE, "agent page-size bound");
    this.maxPageBytes = bound(options.maxPageBytes, MAX_AGENT_EVENT_PAGE_BYTES, MAX_AGENT_EVENT_PAGE_BYTES, "agent page-byte bound");
  }

  attach(reader: AgentActivityReader, notifier?: AgentNotificationSender): void {
    this.epoch++;
    this.reader?.setAgentResultProvider?.(undefined);
    this.reader?.setAgentCancelProvider?.(undefined);
    this.reader?.setAgentStopProvider?.(undefined);
    this.reader = reader;
    this.notifier = notifier;
    reader.setAgentResultProvider?.({ completion: value => this.peerCompletion(value) });
    reader.setAgentCancelProvider?.({ cancel: (value, effect) => this.peerCancel(value, effect) });
    reader.setAgentStopProvider?.({ stop: (value, effect) => this.peerStop(value, effect) });
  }

  /** Detach fresh-observation and notification authority; exact-handle evidence remains readable. */
  detach(): void {
    this.epoch++;
    this.reader?.setAgentResultProvider?.(undefined);
    this.reader?.setAgentCancelProvider?.(undefined);
    this.reader?.setAgentStopProvider?.(undefined);
    this.reader = undefined;
    this.notifier = undefined;
    for (const current of this.runs.values()) {
      current.probe++;
      if (current.lifecycle.binding === "bound") this.apply(current, { type: "binding.unknown" });
      this.revokeDelivery(current);
    }
  }

  register(value: unknown, options: AgentRegistrationOptions = {}): AgentHandle {
    const handle = parseAgentHandle(value), id = key(handle), registration = record(options);
    if (Object.keys(registration).some(field => field !== "notifyParentOnSettlement")
        || (registration.notifyParentOnSettlement !== undefined
          && typeof registration.notifyParentOnSettlement !== "boolean"))
      throw new Error("Invalid agent registration notification option");
    const notifyParentOnSettlement = registration.notifyParentOnSettlement === true;
    const existing = this.runs.get(id);
    if (existing) {
      if (Object.hasOwn(registration, "notifyParentOnSettlement")
          && existing.notifyParentOnSettlement !== notifyParentOnSettlement)
        throw new Error("Conflicting agent settlement notification registration");
      return existing.handle;
    }
    const sameRun = this.runIdentities.get(runKey(handle));
    if (sameRun) {
      for (const field of ["taskId", "conversationId", "runtimeId", "runId", "requestId", "messageId"] as const)
        if (sameRun[field] !== handle[field]) throw new Error("Ambiguous or conflicting agent run association: " + field);
      if (handle.endpointGeneration <= sameRun.endpointGeneration) throw new Error("Stale or ambiguous agent endpoint generation");
    }
    if (this.runs.size >= this.maxRuns) throw new Error("Agent run history bound reached");
    const generation = this.generations.get(handle.conversationId) ?? 0;
    if (handle.endpointGeneration < generation) throw new Error("Stale agent endpoint generation");
    if (handle.endpointGeneration > generation) {
      // Explicit registration of a newer generation is positive local replacement evidence.
      for (const current of this.runs.values()) {
        if (current.handle.conversationId === handle.conversationId
            && current.handle.endpointGeneration < handle.endpointGeneration && !TERMINAL_BINDINGS.has(current.lifecycle.binding))
          this.apply(current, { type: "binding.replaced" });
      }
      this.generations.set(handle.conversationId, handle.endpointGeneration);
    }
    const current: RunRecord = { handle, lifecycle: createAgentLifecycleState(), pendingInput: null,
      events: [], nextEventId: 1, dropped: 0, probe: 0, notifyParentOnSettlement };
    this.runs.set(id, current); this.runIdentities.set(runKey(handle), handle);
    this.append(current, "run.registered", { type: "run.registered" });
    return handle;
  }

  /** Alias for explicit test/future-launch tracking; it does not discover or create runs. */
  track(value: unknown, options: AgentRegistrationOptions = {}): AgentHandle { return this.register(value, options); }

  private exact(value: unknown): RunRecord {
    const handle = parseAgentHandle(value), current = this.runs.get(key(handle));
    if (!current) throw new Error("Unknown, foreign, or ambiguous agent handle");
    return current;
  }

  private append(current: RunRecord, type: AgentEvent["type"], observation: AgentEvent["observation"]): void {
    if (!Number.isSafeInteger(current.nextEventId)) throw new Error("Agent event ID bound reached");
    const event: AgentEvent = Object.freeze({ id: String(current.nextEventId++), type,
      observation: Object.freeze({ ...observation }), lifecycle: current.lifecycle, pendingInput: current.pendingInput });
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_AGENT_EVENT_BYTES) throw new Error("Agent event byte bound exceeded");
    current.events.push(event);
    while (current.events.length > this.maxEvents) { current.events.shift(); current.dropped++; }
  }

  private apply(current: RunRecord, observation: AgentRecordedObservation): void {
    const repeatedTerminal = (current.lifecycle.binding === "replaced" && observation.type === "binding.replaced")
      || (current.lifecycle.binding === "exited" && observation.type === "binding.exited");
    if (!observation.type.startsWith("delivery.") && TERMINAL_BINDINGS.has(current.lifecycle.binding) && !repeatedTerminal)
      throw new Error("Stale agent handle cannot accept new target/run evidence");
    current.lifecycle = reduceAgentLifecycleState(current.lifecycle, observation);
    if (observation.type === "activity.sample") current.pendingInput = observation.pendingMessages;
    this.append(current, observation.type, observation);
    if (observation.type === "binding.replaced") this.revokeDelivery(current);
  }

  private revokeDelivery(current: RunRecord): void {
    if (!current.notifyParentOnSettlement) return;
    if (current.lifecycle.delivery === "created" || current.lifecycle.delivery === "unknown")
      this.apply(current, { type: "delivery.revoked" });
    else if (current.lifecycle.delivery === "pending" && current.notification)
      // An in-flight send cannot be unsent. Block all future sends, but retain a later accepted/unknown outcome.
      current.notification.authorityRevoked = true;
  }

  /**
   * Correlate verified local Pi agent-end evidence only to handles for this exact conversation.
   * This synchronous hook schedules delivery and returns; status/events and peer reads never call it.
   */
  observeLocalSettlement(source: Identity): void {
    const local = parseIdentity(source);
    const eligible = [...this.runs.values()].filter(current =>
      current.handle.taskId === local.taskId && current.handle.conversationId === local.conversationId
      && !TERMINAL_BINDINGS.has(current.lifecycle.binding) && current.lifecycle.activity !== "settled");
    // Pi agent-end has no runId. Never fan one conversation-level observation out to ambiguous runs.
    if (eligible.length > 1) throw new Error("Ambiguous local agent settlement; exact run correlation is required");
    for (const current of eligible) {
      this.apply(current, { type: "activity.settled" });
      if (!current.notifyParentOnSettlement || current.notification) continue;
      const notification: PeerAgentNotification = { type: "activity.settled", handle: current.handle,
        eventId: String(current.nextEventId - 1) };
      const retained: SettlementNotification = { eventId: notification.eventId,
        messageId: peerAgentNotificationId(notification), authorityRevoked: false };
      current.notification = retained;
      if (current.lifecycle.delivery === "revoked") { retained.authorityRevoked = true; continue; }
      const notifier = this.notifier;
      if (!notifier) {
        retained.authorityRevoked = true;
        this.apply(current, { type: "delivery.revoked" });
        continue;
      }
      this.apply(current, { type: "delivery.requested" });
      this.deliver(current, retained, notification, notifier);
    }
  }

  private deliver(current: RunRecord, retained: SettlementNotification,
      notification: PeerAgentNotification, notifier: AgentNotificationSender): void {
    void Promise.resolve().then(() => notifier.notifyParent(notification)).then(result => {
      if (current.notification !== retained || current.lifecycle.delivery !== "pending") return;
      if (result.id !== retained.messageId || result.state !== "accepted"
          || result.processingConfirmed !== false || result.completionConfirmed !== false) {
        this.apply(current, { type: "delivery.unknown" });
        if (retained.authorityRevoked) this.apply(current, { type: "delivery.revoked" });
        return;
      }
      this.apply(current, { type: "delivery.accepted" });
    }).catch(error => {
      if (current.notification !== retained || current.lifecycle.delivery !== "pending") return;
      const unknown = isPeerSendUnknownError(error);
      this.apply(current, { type: unknown ? "delivery.unknown" : "delivery.revoked" });
      if (unknown && retained.authorityRevoked) this.apply(current, { type: "delivery.revoked" });
    });
  }

  /** Record one explicit result for the verified local conversation; never infer or deliver it. */
  complete(value: unknown, source: Orientation, input: unknown): AgentCompletion {
    const current = this.exact(value), local = parseOrientation(source);
    if (!local.origin || local.origin.taskId !== local.taskId || local.origin.conversationId === local.conversationId
        || !sameAgentConversation(current.handle, local))
      throw new Error("Agent completion requires the verified local child conversation");
    const generation = this.generations.get(current.handle.conversationId) ?? current.handle.endpointGeneration;
    if (current.lifecycle.binding === "replaced" || current.handle.endpointGeneration < generation)
      throw new Error("Stale or replaced agent run cannot be completed");
    const { completion, observation } = parseCompletion(input);
    for (const field of ["requestId", "runId", "runtimeId"] as const) {
      if (completion[field] !== current.handle[field])
        throw new Error("Conflicting agent completion correlation: " + field);
    }
    if (current.completion) {
      if (!sameCompletion(current.completion, completion)) throw new Error("Conflicting agent completion payload");
      return current.completion;
    }
    this.applyResult(current, observation);
    current.completion = completion;
    return completion;
  }

  private peerCompletion(value: unknown): AgentCompletion | undefined {
    const current = this.exact(value);
    const generation = this.generations.get(current.handle.conversationId) ?? current.handle.endpointGeneration;
    if (current.lifecycle.binding === "replaced" || current.handle.endpointGeneration < generation)
      throw new Error("Stale or replaced agent result evidence");
    return current.completion;
  }

  /** Child-side exact-run validation and synchronous abort-effect deduplication. */
  private peerCancel(value: unknown, effect: () => PeerAgentCancelLocalResult): PeerAgentCancelLocalResult {
    const current = this.exact(value);
    const generation = this.generations.get(current.handle.conversationId) ?? current.handle.endpointGeneration;
    if (current.lifecycle.binding === "replaced" || current.handle.endpointGeneration < generation)
      throw new Error("Stale or replaced agent run cannot be cancelled");
    if (current.localCancellation) return current.localCancellation;
    let outcome: PeerAgentCancelLocalResult;
    if (current.completion) outcome = { state: "settled", reason: "already-settled" };
    else if (current.lifecycle.activity === "settled" || current.lifecycle.binding === "exited")
      outcome = { state: "settled", reason: "no-active-work" };
    else {
      // Pi exposes conversation busy/abort, not a current runId. Never guess between live registrations.
      const eligible = [...this.runs.values()].filter(other =>
        other.handle.taskId === current.handle.taskId && other.handle.conversationId === current.handle.conversationId
        && other.handle.endpointGeneration === current.handle.endpointGeneration
        && !TERMINAL_BINDINGS.has(other.lifecycle.binding) && !other.completion && other.lifecycle.activity !== "settled");
      if (eligible.length !== 1 || eligible[0] !== current)
        throw new Error("Ambiguous local agent cancellation; exact active run correlation is required");
      outcome = effect();
    }
    current.localCancellation = outcome;
    this.observeCancellation(current, outcome.state);
    return outcome;
  }

  /** Endpoint shutdown is safe only when every live registration resolves to this exact runtime. */
  private assertStopAssociation(current: RunRecord): void {
    for (const other of this.runs.values()) {
      if (other === current || other.handle.conversationId !== current.handle.conversationId
          || other.handle.endpointGeneration !== current.handle.endpointGeneration
          || TERMINAL_BINDINGS.has(other.lifecycle.binding)) continue;
      if (other.handle.runtimeId !== current.handle.runtimeId)
        throw new Error("Ambiguous local agent stop; exact runtime association is required");
      if (current.endpointId && other.endpointId && current.endpointId !== other.endpointId)
        throw new Error("Ambiguous target/endpoint-generation association");
    }
  }

  /** Child-side exact endpoint validation and shutdown-effect deduplication. */
  private peerStop(value: unknown, effect: () => PeerAgentStopLocalResult): PeerAgentStopLocalResult {
    const current = this.exact(value);
    const generation = this.generations.get(current.handle.conversationId) ?? current.handle.endpointGeneration;
    if (current.lifecycle.binding === "replaced" || current.handle.endpointGeneration < generation)
      throw new Error("Stale or replaced agent endpoint cannot be stopped");
    if (current.localStop) return current.localStop;
    // Distinct runs may intentionally identify the same runtime. Share its endpoint effect/outcome too.
    for (const other of this.runs.values()) {
      if (other !== current && other.handle.conversationId === current.handle.conversationId
          && other.handle.runtimeId === current.handle.runtimeId
          && other.handle.endpointGeneration === current.handle.endpointGeneration && other.localStop) {
        current.localStop = other.localStop;
        this.observeStop(current, other.localStop.state);
        return other.localStop;
      }
    }
    let outcome: PeerAgentStopLocalResult;
    if (current.lifecycle.binding === "exited") outcome = { state: "closed", reason: "already-exited" };
    else {
      this.assertStopAssociation(current);
      outcome = effect();
    }
    current.localStop = outcome;
    this.observeStop(current, outcome.state);
    return outcome;
  }

  private observeCancellation(current: RunRecord, state: AgentCancellationState): void {
    if (state === "acknowledged" && !TERMINAL_RESULTS.has(current.lifecycle.result)) {
      current.lifecycle = reduceAgentLifecycleState(current.lifecycle, { type: "cancellation.acknowledged" });
    } else if (state === "unknown" && ["pending", "cancelling"].includes(current.lifecycle.result)) {
      current.lifecycle = reduceAgentLifecycleState(current.lifecycle, { type: "result.unknown" });
    }
    this.append(current, `cancellation.${state}`, { type: `cancellation.${state}` });
  }

  private applyResult(current: RunRecord,
      observation: AgentCompletionObservation | { readonly type: "result.pending" | "result.unknown" }): void {
    current.lifecycle = reduceAgentLifecycleState(current.lifecycle, observation);
    this.append(current, observation.type, observation);
  }

  observe(value: unknown, observation: AgentRuntimeObservation): AgentLifecycleState {
    const current = this.exact(value);
    this.apply(current, observation);
    return current.lifecycle;
  }

  replace(value: unknown): AgentLifecycleState { return this.observe(value, { type: "binding.replaced" }); }

  /** A local Pi session replacement stales retained handles without erasing their outcomes. */
  replaceAll(): void {
    for (const current of this.runs.values())
      if (!TERMINAL_BINDINGS.has(current.lifecycle.binding)) this.apply(current, { type: "binding.replaced" });
  }

  private snapshot(current: RunRecord, evidence: AgentStatus["evidence"], readError?: string): AgentStatus {
    const result: AgentStatus = { handle: current.handle, runtimeId: current.handle.runtimeId,
      runId: current.handle.runId, requestId: current.handle.requestId, lifecycle: current.lifecycle,
      pendingInput: current.pendingInput, resultAvailable: current.completion !== undefined, evidence,
      ...(readError ? { readError } : {}), notice: AGENT_READ_NOTICE };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_AGENT_STATUS_BYTES) throw new Error("Agent status byte bound exceeded");
    return result;
  }

  /** Pin the exact verified endpoint incarnation without adding lease material to AgentHandle. */
  pinEndpoint(value: unknown, incarnation: unknown): AgentHandle {
    const current = this.exact(value), expected = endpointId(incarnation);
    if (current.endpointId && current.endpointId !== expected) {
      if (!TERMINAL_BINDINGS.has(current.lifecycle.binding)) this.apply(current, { type: "binding.replaced" });
      throw new Error("Stale or conflicting agent endpoint incarnation");
    }
    this.sameIncarnation(current, expected);
    current.endpointId = expected;
    return current.handle;
  }

  private acceptIncarnation(current: RunRecord, observed: string): boolean {
    if (current.endpointId && current.endpointId !== observed) {
      if (!TERMINAL_BINDINGS.has(current.lifecycle.binding)) this.apply(current, { type: "binding.replaced" });
      return false;
    }
    this.sameIncarnation(current, observed);
    current.endpointId = observed;
    return true;
  }

  private sameIncarnation(current: RunRecord, observed: string): void {
    for (const other of this.runs.values()) {
      if (other.handle.conversationId === current.handle.conversationId
          && other.handle.endpointGeneration === current.handle.endpointGeneration
          && other.endpointId && other.endpointId !== observed)
        throw new Error("Ambiguous target/endpoint-generation association");
    }
  }

  /** Synchronous exact-handle evidence for local presentation and run-end cleanup; never performs a peer read. */
  hasCompletion(value: unknown): boolean { return this.exact(value).completion !== undefined; }
  cachedStatuses(): readonly AgentStatus[] {
    return [...this.runs.values()].map(current => this.snapshot(current, "retained"));
  }

  async status(value: unknown, signal?: AbortSignal): Promise<AgentStatus> {
    const current = this.exact(value), reader = this.reader, epoch = this.epoch, probe = ++current.probe;
    signal?.throwIfAborted();
    if (!reader || TERMINAL_BINDINGS.has(current.lifecycle.binding)) return this.snapshot(current, "retained");
    let result: PeerAgentActivityResult;
    try {
      result = await reader.agentActivity(current.handle.conversationId, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (epoch === this.epoch && this.reader === reader && probe === current.probe
          && !TERMINAL_BINDINGS.has(current.lifecycle.binding)) {
        this.apply(current, { type: "binding.unknown" });
        return this.snapshot(current, "retained", errorText(error));
      }
      return this.snapshot(current, "retained");
    }
    if (epoch !== this.epoch || this.reader !== reader || probe !== current.probe)
      return this.snapshot(current, "retained");
    if (!sameAgentConversation(current.handle, result.target)) throw new Error("Mismatched agent target evidence");
    const incarnation = endpointId(result.endpointId);
    if (!this.acceptIncarnation(current, incarnation)) return this.snapshot(current, "retained");
    const activity = record(result.activity);
    if (typeof activity.idle !== "boolean" || typeof activity.pendingMessages !== "boolean"
        || typeof activity.settled !== "boolean" || Object.keys(activity).length !== 3)
      throw new Error("Invalid agent activity evidence");
    this.apply(current, { type: "binding.verified" });
    this.apply(current, { type: "activity.sample", idle: activity.idle, pendingMessages: activity.pendingMessages });
    if (activity.settled) this.apply(current, { type: "activity.settled" });
    return this.snapshot(current, "current");
  }

  private resultSnapshot(current: RunRecord, state: AgentResultState, evidence: AgentResult["evidence"],
      readError?: string, completion?: AgentCompletion): AgentResult {
    const result: AgentResult = Object.freeze({ handle: current.handle, runtimeId: current.handle.runtimeId,
      runId: current.handle.runId, requestId: current.handle.requestId, state,
      ...(completion ? { outcome: completion.outcome, completion } : {}), evidence,
      ...(readError ? { readError } : {}), notice: AGENT_RESULT_NOTICE });
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_AGENT_RESULT_BYTES)
      throw new Error("Agent result byte bound exceeded");
    return result;
  }

  private unknownResult(current: RunRecord, error?: unknown, observe = true): AgentResult {
    if (current.retainedResult) return current.retainedResult;
    const readError = error === undefined ? "Agent result evidence is unavailable" : errorText(error);
    if (observe && ["pending", "cancelling"].includes(current.lifecycle.result))
      this.applyResult(current, { type: "result.unknown" });
    return this.resultSnapshot(current, "unknown", "retained", readError);
  }

  /** Parent-side remote read. A terminal result is returned from retained evidence thereafter. */
  async result(value: unknown, source: Identity, signal?: AbortSignal): Promise<AgentResult> {
    const handle = parseAgentHandle(value), current = this.exact(handle), local = parseIdentity(source);
    if (handle.taskId !== local.taskId || handle.conversationId === local.conversationId)
      throw new Error("Agent result requires a remote handle in the same related task");
    if (current.retainedResult) return current.retainedResult;
    signal?.throwIfAborted();
    const reader = this.reader;
    if (!reader?.agentResult || TERMINAL_BINDINGS.has(current.lifecycle.binding))
      return this.unknownResult(current);
    const epoch = this.epoch, probe = ++current.probe;
    let response: PeerAgentResultResult;
    try {
      response = await reader.agentResult(current.handle, signal);
    } catch (error) {
      if (isPeerAgentResultEvidenceError(error)) throw error;
      signal?.throwIfAborted();
      if (current.retainedResult) return current.retainedResult;
      const observe = epoch === this.epoch && this.reader === reader && probe === current.probe
        && !TERMINAL_BINDINGS.has(current.lifecycle.binding);
      return this.unknownResult(current, error, observe);
    }
    if (current.retainedResult) return current.retainedResult;
    if (epoch !== this.epoch || this.reader !== reader || probe !== current.probe
        || TERMINAL_BINDINGS.has(current.lifecycle.binding))
      return this.unknownResult(current, "Agent result evidence changed during the read", false);

    // Validate the complete response before accepting even a pending observation.
    const input = record(response), fields = ["target", "endpointId", "handle"];
    if (Object.hasOwn(input, "completion")) fields.push("completion");
    if (Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field)))
      throw new Error("Unexpected or missing agent result response fields");
    const target = parseIdentity(input.target);
    if (!sameAgentConversation(current.handle, target)) throw new Error("Mismatched agent result target evidence");
    assertSameAgentRun(input.handle, current.handle);
    const incarnation = endpointId(input.endpointId);
    if (!this.acceptIncarnation(current, incarnation))
      return this.unknownResult(current, "Agent endpoint replacement makes the result unknown");

    if (!Object.hasOwn(input, "completion")) {
      if (current.lifecycle.result === "cancelling")
        return this.resultSnapshot(current, "cancelling", "current");
      this.applyResult(current, { type: "result.pending" });
      return this.resultSnapshot(current, "pending", "current");
    }
    const { completion, observation } = parseCompletion(input.completion);
    for (const field of ["requestId", "runId", "runtimeId"] as const)
      if (completion[field] !== current.handle[field])
        throw new Error("Conflicting agent completion correlation: " + field);
    if (current.completion && !sameCompletion(current.completion, completion))
      throw new Error("Conflicting agent completion payload");
    if (current.retainedResult) return current.retainedResult;
    const state: AgentResultState = completion.outcome === "completed" ? "ready" : completion.outcome;
    const retained = this.resultSnapshot(current, state, "retained", undefined, completion);
    this.applyResult(current, observation);
    current.completion = completion;
    current.retainedResult = retained;
    return retained;
  }

  /** Bounded exact-handle reads. Unknown evidence returns immediately; waiting never infers a result. */
  async waitForResult(value: unknown, source: Identity, waitMs: number, signal?: AbortSignal): Promise<AgentResult> {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_AGENT_RESULT_WAIT_MS)
      throw new Error("Invalid agent result wait bound");
    if (waitMs === 0) return this.result(value, source, signal);
    const handle = parseAgentHandle(value), current = this.exact(handle), local = parseIdentity(source);
    if (handle.taskId !== local.taskId || handle.conversationId === local.conversationId)
      throw new Error("Agent result requires a remote handle in the same related task");
    const deadline = Date.now() + waitMs, timeout = AbortSignal.timeout(waitMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let last: AgentResult | undefined;
    try {
      for (;;) {
        last = await this.result(handle, local, combined);
        if (last.state !== "pending" && last.state !== "cancelling") return last;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return last;
        await pause(Math.min(AGENT_RESULT_WAIT_POLL_MS, remaining), combined);
        if (Date.now() >= deadline) return last;
      }
    } catch (error) {
      if (!timeout.aborted || signal?.aborted) throw error;
      if (current.retainedResult) return current.retainedResult;
      if (last) return last;
      return this.unknownResult(current, new Error("Agent result wait deadline exceeded"), false);
    }
  }

  private cancellationSnapshot(current: RunRecord, state: AgentCancellationState,
      reason: AgentCancellationReason, readError?: string): AgentCancellation {
    const result: AgentCancellation = Object.freeze({ handle: current.handle, runtimeId: current.handle.runtimeId,
      runId: current.handle.runId, requestId: current.handle.requestId, state, reason,
      ...(readError ? { readError: errorText(readError) } : {}), notice: AGENT_CANCEL_NOTICE });
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_AGENT_CANCELLATION_BYTES)
      throw new Error("Agent cancellation byte bound exceeded");
    return result;
  }

  private finishCancellation(current: RunRecord, state: AgentCancellationState,
      reason: AgentCancellationReason, readError?: string): AgentCancellation {
    if (current.cancellation) return current.cancellation;
    const result = this.cancellationSnapshot(current, state, reason, readError);
    this.observeCancellation(current, state);
    current.cancellation = result;
    return result;
  }

  /**
   * Parent-side cancellation for one exact related remote run. Every final outcome is retained:
   * retries, including retries after unknown, cannot issue a second abort for this logical run.
   */
  async cancel(value: unknown, source: Identity, signal?: AbortSignal): Promise<AgentCancellation> {
    const handle = parseAgentHandle(value), current = this.exact(handle), local = parseIdentity(source);
    if (handle.taskId !== local.taskId || handle.conversationId === local.conversationId)
      throw new Error("Agent cancellation requires a remote handle in the same related task");
    const generation = this.generations.get(handle.conversationId) ?? handle.endpointGeneration;
    if (current.lifecycle.binding === "replaced" || handle.endpointGeneration < generation)
      throw new Error("Stale or replaced agent run cannot be cancelled");
    if (current.cancellation) return current.cancellation;
    if (current.cancellationPromise) return current.cancellationPromise;
    signal?.throwIfAborted();
    if (current.completion || current.retainedResult)
      return this.finishCancellation(current, "settled", "already-settled");
    if (current.lifecycle.activity === "settled" || current.lifecycle.binding === "exited")
      return this.finishCancellation(current, "settled", "no-active-work");
    const reader = this.reader, epoch = this.epoch;
    const operation = Promise.resolve().then(() => this.performCancellation(current, reader, epoch, signal));
    current.cancellationPromise = operation;
    try { return await operation; }
    finally { if (current.cancellationPromise === operation) current.cancellationPromise = undefined; }
  }

  private async preflightControl(current: RunRecord, reader: AgentActivityReader, signal?: AbortSignal): Promise<boolean> {
    const evidence = await reader.agentActivity(current.handle.conversationId, signal);
    if (!sameAgentConversation(current.handle, evidence.target)) throw new Error("Mismatched agent control preflight target");
    return this.acceptIncarnation(current, endpointId(evidence.endpointId));
  }

  private async performCancellation(current: RunRecord, reader: AgentActivityReader | undefined,
      epoch: number, signal?: AbortSignal): Promise<AgentCancellation> {
    if (!reader?.agentCancel)
      return this.finishCancellation(current, "unknown", "transport", "Agent cancellation is disconnected or unavailable");
    let response: PeerAgentCancelResult, preflight = false;
    try {
      preflight = true;
      if (!await this.preflightControl(current, reader, signal))
        return this.finishCancellation(current, "unknown", "changed", "Agent endpoint replacement makes cancellation unknown");
      preflight = false;
      response = await reader.agentCancel(current.handle, signal, current.endpointId);
    } catch (error) {
      if (preflight)
        return this.finishCancellation(current, "unknown", "transport", errorText(error));
      if (isPeerAgentCancelUnknownError(error))
        return this.finishCancellation(current, "unknown", "transport", errorText(error));
      // PeerRuntime reserves its unknown error for post-write ambiguity; this is a definite pre-write failure.
      return this.finishCancellation(current, "requested", "pre-write", errorText(error));
    }
    const generation = this.generations.get(current.handle.conversationId) ?? current.handle.endpointGeneration;
    if (epoch !== this.epoch || this.reader !== reader || current.lifecycle.binding === "replaced"
        || current.handle.endpointGeneration < generation)
      return this.finishCancellation(current, "unknown", "changed", "Agent cancellation authority changed during the request");
    try {
      const input = record(response), optionalError = Object.hasOwn(input, "error");
      const fields = ["target", "endpointId", "handle", "state", "reason", ...(optionalError ? ["error"] : [])];
      if (Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field)))
        throw new Error("Unexpected or missing agent cancel response fields");
      const target = parseIdentity(input.target);
      if (!sameAgentConversation(current.handle, target)) throw new Error("Mismatched agent cancel target evidence");
      assertSameAgentRun(input.handle, current.handle);
      const incarnation = endpointId(input.endpointId);
      if (!this.acceptIncarnation(current, incarnation)) throw new Error("Agent endpoint replacement makes cancellation unknown");
      const acknowledged = input.state === "acknowledged" && input.reason === "busy";
      const settled = input.state === "settled"
        && ["idle", "already-settled", "no-active-work"].includes(String(input.reason));
      const unknown = input.state === "unknown" && input.reason === "abort-throw";
      if (!acknowledged && !settled && !unknown) throw new Error("Invalid agent cancel outcome");
      if (optionalError && (typeof input.error !== "string" || !input.error.length || input.error.length > 1024))
        throw new Error("Invalid agent cancel error evidence");
      if (acknowledged) return this.finishCancellation(current, "acknowledged", "busy");
      if (settled) return this.finishCancellation(current, "settled", input.reason as PeerAgentCancelReason);
      return this.finishCancellation(current, "unknown", "abort-throw",
        optionalError ? input.error as string : "Pi abort threw; its outcome is unknown");
    } catch (error) {
      // Validation failure after a request cannot prove that no abort occurred.
      return this.finishCancellation(current, "unknown", "changed", errorText(error));
    }
  }

  private stopSnapshot(current: RunRecord, state: AgentStopState,
      reason: AgentStopReason, readError?: string): AgentStop {
    const result: AgentStop = Object.freeze({ handle: current.handle, runtimeId: current.handle.runtimeId,
      runId: current.handle.runId, requestId: current.handle.requestId, state, reason,
      ...(readError ? { readError: errorText(readError) } : {}), notice: AGENT_STOP_NOTICE });
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_AGENT_STOP_BYTES) throw new Error("Agent stop byte bound exceeded");
    return result;
  }

  private observeStop(current: RunRecord, state: AgentStopState): void {
    // Stop is endpoint evidence only: never synthesize cancellation, completion, delivery, or activity evidence.
    this.append(current, `stop.${state}`, { type: `stop.${state}` });
  }

  private finishStop(current: RunRecord, state: AgentStopState,
      reason: AgentStopReason, readError?: string): AgentStop {
    if (current.stop) return current.stop;
    const result = this.stopSnapshot(current, state, reason, readError);
    this.observeStop(current, state);
    current.stop = result;
    return result;
  }

  /**
   * Parent-side, explicitly authorized stop of one exact related remote endpoint. All final outcomes
   * are retained, including disconnected and unknown, so no call is automatically or manually repeated
   * through this runtime. The child-side provider independently deduplicates the native shutdown effect.
   */
  async stop(value: unknown, source: Identity, authorization: unknown, signal?: AbortSignal): Promise<AgentStop> {
    const permission = record(authorization);
    if (Object.keys(permission).length !== 1 || permission.authorize !== true)
      throw new Error("Agent stop requires explicit authorize:true");
    const handle = parseAgentHandle(value), current = this.exact(handle), local = parseIdentity(source);
    if (handle.taskId !== local.taskId || handle.conversationId === local.conversationId)
      throw new Error("Agent stop requires a remote handle in the same related task");
    const generation = this.generations.get(handle.conversationId) ?? handle.endpointGeneration;
    if (current.lifecycle.binding === "replaced" || handle.endpointGeneration < generation)
      throw new Error("Stale or replaced agent endpoint cannot be stopped");
    if (current.stop) return current.stop;
    if (current.stopPromise) return current.stopPromise;
    signal?.throwIfAborted();
    if (current.lifecycle.binding === "exited") return this.finishStop(current, "closed", "already-exited");
    this.assertStopAssociation(current);
    const reader = this.reader, epoch = this.epoch;
    const operation = Promise.resolve().then(() => this.performStop(current, reader, epoch, signal));
    current.stopPromise = operation;
    try { return await operation; }
    finally { if (current.stopPromise === operation) current.stopPromise = undefined; }
  }

  private async performStop(current: RunRecord, reader: AgentActivityReader | undefined,
      epoch: number, signal?: AbortSignal): Promise<AgentStop> {
    if (!reader?.agentStop)
      return this.finishStop(current, "disconnected", "unavailable", "Agent stop is disconnected or unavailable");
    let response: PeerAgentStopResult, preflight = false;
    try {
      preflight = true;
      if (!await this.preflightControl(current, reader, signal))
        return this.finishStop(current, "unknown", "changed", "Agent endpoint replacement makes stop unknown");
      preflight = false;
      response = await reader.agentStop(current.handle, signal, current.endpointId);
    } catch (error) {
      const generation = this.generations.get(current.handle.conversationId) ?? current.handle.endpointGeneration;
      if (epoch !== this.epoch || this.reader !== reader || current.lifecycle.binding === "replaced"
          || current.handle.endpointGeneration < generation)
        return this.finishStop(current, "unknown", "changed", "Agent stop authority changed during the request");
      if (preflight)
        return this.finishStop(current, "disconnected", "pre-write", errorText(error));
      if (isPeerAgentStopUnknownError(error))
        return this.finishStop(current, "unknown", "transport", errorText(error));
      // The peer transport uses its unknown error only after a write; other failures are definite pre-write.
      return this.finishStop(current, "disconnected", "pre-write", errorText(error));
    }
    const generation = this.generations.get(current.handle.conversationId) ?? current.handle.endpointGeneration;
    if (epoch !== this.epoch || this.reader !== reader || current.lifecycle.binding === "replaced"
        || current.handle.endpointGeneration < generation)
      return this.finishStop(current, "unknown", "changed", "Agent stop authority changed during the request");
    try {
      const input = record(response), optionalError = Object.hasOwn(input, "error");
      const fields = ["target", "endpointId", "handle", "state", "reason", ...(optionalError ? ["error"] : [])];
      if (Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field)))
        throw new Error("Unexpected or missing agent stop response fields");
      const target = parseIdentity(input.target);
      if (!sameAgentConversation(current.handle, target)) throw new Error("Mismatched agent stop target evidence");
      assertSameAgentRun(input.handle, current.handle);
      const incarnation = endpointId(input.endpointId);
      if (!this.acceptIncarnation(current, incarnation)) throw new Error("Agent endpoint replacement makes stop unknown");
      this.assertStopAssociation(current);
      current.endpointId = incarnation;
      const accepted = input.state === "accepted" && input.reason === "shutdown-requested";
      const closed = input.state === "closed" && input.reason === "already-exited";
      const unknown = input.state === "unknown" && input.reason === "shutdown-throw";
      if (!accepted && !closed && !unknown) throw new Error("Invalid agent stop outcome");
      if (optionalError && (typeof input.error !== "string" || !input.error.length || input.error.length > 1024))
        throw new Error("Invalid agent stop error evidence");
      if (accepted) return this.finishStop(current, "accepted", "shutdown-requested");
      if (closed) return this.finishStop(current, "closed", "already-exited");
      return this.finishStop(current, "unknown", "shutdown-throw",
        optionalError ? input.error as string : "Pi shutdown threw; its outcome is unknown");
    } catch (error) {
      // Validation failure after a request cannot prove that shutdown was not requested.
      return this.finishStop(current, "unknown", "changed", errorText(error));
    }
  }

  events(value: unknown, input: { limit?: number; cursor?: string } = {}): AgentEventPage {
    const current = this.exact(value), options = record(input);
    if (Object.keys(options).some(field => field !== "limit" && field !== "cursor"))
      throw new Error("Unexpected agent event read field");
    const limit = options.limit ?? this.maxPageSize;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > this.maxPageSize)
      throw new Error("Invalid agent event page size");
    if (options.cursor !== undefined && typeof options.cursor !== "string") throw new Error("Malformed agent event cursor");
    let start = 0;
    if (options.cursor !== undefined) {
      if (current.lifecycle.binding === "replaced") throw new Error("Replaced agent event cursor is stale");
      const after = decodeCursor(options.cursor, current.handle);
      const index = current.events.findIndex(event => Number(event.id) === after);
      if (index < 0) {
        const oldest = current.events.length ? Number(current.events[0].id) : current.nextEventId;
        if (after < oldest) throw new Error("Agent event cursor was evicted by retention");
        throw new Error("Stale or ambiguous agent event cursor");
      }
      start = index + 1;
    }
    const selected = current.events.slice(start, start + Number(limit));
    // The whole wire object, not merely its entries, is byte-bounded.
    while (selected.length) {
      const nextIndex = start + selected.length;
      const next = nextIndex < current.events.length ? encodeCursor(current.handle, selected.at(-1)!.id) : undefined;
      const candidate = this.page(current, selected, next);
      if (Buffer.byteLength(JSON.stringify(candidate)) <= this.maxPageBytes) return candidate;
      selected.pop();
    }
    const empty = this.page(current, selected);
    if (start < current.events.length || Buffer.byteLength(JSON.stringify(empty)) > this.maxPageBytes)
      throw new Error("Agent event page byte bound exceeded");
    return empty;
  }

  private page(current: RunRecord, events: readonly AgentEvent[], next?: string): AgentEventPage {
    return { handle: current.handle, runtimeId: current.handle.runtimeId, runId: current.handle.runId,
      requestId: current.handle.requestId, events, bytes: events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0),
      oldestEventId: current.events[0]?.id ?? null, latestEventId: String(current.nextEventId - 1),
      dropped: current.dropped, resultAvailable: current.completion !== undefined, ...(next ? { next } : {}), notice: AGENT_READ_NOTICE };
  }
}
