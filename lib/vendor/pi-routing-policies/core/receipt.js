import { randomUUID } from "node:crypto";
import { freeze, parseSelection } from "./policy.js";
import { RoutingError } from "./types.js";
const INVENTORY_CODES = new Set(["model_missing", "not_physical", "auth_missing", "input_unsupported", "restricted", "inventory_rejected"]);
const ERROR_CODES = new Set(["INVALID_CONFIG", "INVALID_SELECTION", "INELIGIBLE", "NO_CANDIDATES", "INVALID_STATE", "INVALID_ANSWER", "STALE_DECISION", "ABSTAINED", "ABORTED", "SELECTOR_UNAVAILABLE", "SELECTOR_ERROR", "SELECTOR_TIMEOUT", "NO_ASSIGNMENT"]);
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export function inventoryCode(value) {
    return INVENTORY_CODES.has(value) ? value : "inventory_rejected";
}
/** Only reported numeric usage survives. No raw provider fields, prose or task state. */
export function selectorObservation(metadata) {
    try {
        const usage = metadata?.usage;
        return Object.freeze({ totalTokens: finite(usage?.totalTokens), cost: finite(usage?.cost?.total) });
    }
    catch {
        return Object.freeze({ totalTokens: null, cost: null });
    }
}
/** Keep known usage when a completed provider response subsequently fails validation. */
export function observedSelectorResult(metadata, finish) {
    try {
        return finish();
    }
    catch (error) {
        if (error instanceof RoutingError)
            throw new RoutingError(error.code, error.message, selectorObservation(metadata));
        throw error;
    }
}
function safeSelection(policy, value) {
    if (typeof value !== "string" || value.length > 128)
        return null;
    try {
        const parsed = parseSelection(value, Object.keys(policy.automatic));
        return parsed.mode === "auto" || Object.hasOwn(policy.config.models, parsed.role) ? value : null;
    }
    catch {
        return null;
    }
}
function identity(selector) {
    try {
        const value = selector.identity;
        if (!value)
            return { kind: "custom" };
        const text = (v, max) => typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v) ? v : undefined;
        return { kind: value.kind === "classifier" || value.kind === "llm" ? value.kind : "custom",
            ...(text(value.provider, 128) !== undefined ? { provider: value.provider } : {}),
            ...(text(value.model, 512) !== undefined ? { model: value.model } : {}) };
    }
    catch {
        return { kind: "custom" };
    }
}
/** Per-operation state: never shared between concurrent decisions, and never contains the task. */
export function createReceipt(policy, operation, selection, options) {
    const id = randomUUID(), startedAt = Date.now(), start = performance.now();
    const candidates = new Map();
    let decisionId;
    let capacity;
    let assigned;
    let invoked = false, returned = false, selectorStart = 0, selectorDuration;
    let selectorIdentity;
    let usage = { totalTokens: null, cost: null };
    return {
        capacity(value) { capacity = value; },
        candidate(value) { candidates.set(value.choice, { ...value }); },
        candidates(values) { for (const value of values)
            candidates.set(value.choice, { ...value }); },
        assessments() { return freeze([...candidates.values()].map(value => ({ ...value }))); },
        prepared(value) { decisionId = value; },
        assigned(value) {
            if (/^[a-f0-9-]{36}$/i.test(value.decisionId))
                decisionId = value.decisionId;
            assigned = { choice: value.choice, target: value.target };
        },
        invoking(selector) { invoked = true; selectorStart = performance.now(); selectorIdentity = identity(selector); },
        returned(metadata) { returned = true; selectorDuration = Math.max(0, performance.now() - selectorStart); usage = selectorObservation(metadata); },
        finish(failure) {
            // Diagnostics must never change a decision/error, even when a consumer's observer throws.
            try {
                const error = failure?.error;
                const code = error instanceof RoutingError && ERROR_CODES.has(error.code) ? error.code : failure ? "INTERNAL_ERROR" : undefined;
                if (invoked && !returned) {
                    selectorDuration = Math.max(0, performance.now() - selectorStart);
                    if (error instanceof RoutingError && error.selectorObservation) {
                        usage = { totalTokens: finite(error.selectorObservation.totalTokens), cost: finite(error.selectorObservation.cost) };
                    }
                }
                const receipt = {
                    version: 1, id, policyRevision: policy.revision, selection: safeSelection(policy, selection), operation,
                    startedAt, durationMs: Math.max(0, performance.now() - start),
                    outcome: code === "ABSTAINED" ? "abstained" : code === "ABORTED" ? "aborted" : code ? "error" : operation === "prepare" ? "prepared" : "assigned",
                    ...(code ? { errorCode: code } : {}), ...(decisionId ? { decisionId } : {}),
                    candidates: [...candidates.values()], ...(capacity ? { capacity } : {}), ...(!code && assigned ? { assignment: assigned } : {}),
                    selector: { invoked, outcome: !invoked ? "not_invoked" : returned ? "returned" : code === "SELECTOR_UNAVAILABLE" ? "unavailable" : code === "SELECTOR_TIMEOUT" ? "timeout" : code === "ABORTED" ? "aborted" : "error",
                        ...(selectorIdentity ? { identity: selectorIdentity } : {}), ...(selectorDuration !== undefined ? { durationMs: selectorDuration } : {}), usage },
                };
                const delivery = options.onReceipt?.(freeze(receipt));
                if (delivery && typeof delivery.then === "function")
                    void Promise.resolve(delivery).catch(() => { });
            }
            catch { /* The explicitly injected diagnostic sink is best-effort, not routing authority. */ }
        },
    };
}
//# sourceMappingURL=receipt.js.map