import { randomUUID } from "node:crypto";
import { freeze, parsePolicy, parseSelection as parsePolicySelection, snapshot } from "./policy.js";
import { createReceipt, inventoryCode } from "./receipt.js";
import { assessCapacity, capacityRequirement, mergeCapacity } from "./capacity.js";
import { ABSTAIN, RoutingError } from "./types.js";
export * from "./types.js";
export { parsePolicy, parseSelection } from "./policy.js";
export { assessCapacity } from "./capacity.js";
function aborted(signal) {
    if (signal?.aborted)
        throw new RoutingError("ABORTED", "Routing was cancelled");
}
function constraints(value = {}) {
    if (Object.keys(value).some(key => !["allowedChoices", "requiredInputs", "capacity"].includes(key)))
        throw new RoutingError("INVALID_SELECTION", "Unknown constraint");
    if (value.allowedChoices !== undefined && (!Array.isArray(value.allowedChoices) || value.allowedChoices.some(c => typeof c !== "string"))) {
        throw new RoutingError("INVALID_SELECTION", "allowedChoices must be an array of exact variant IDs");
    }
    if (value.requiredInputs !== undefined && (!Array.isArray(value.requiredInputs) || value.requiredInputs.some(i => i !== "text" && i !== "image"))) {
        throw new RoutingError("INVALID_SELECTION", "requiredInputs must contain text or image");
    }
    return freeze({ ...(value.allowedChoices ? { allowedChoices: [...value.allowedChoices] } : {}), requiredInputs: [...(value.requiredInputs ?? ["text"])], ...(value.capacity === undefined ? {} : { capacity: capacityRequirement(value.capacity) }) });
}
/** Imports do no I/O. Each router owns immutable policy and decision handles; callers own workflow state. */
export function createRouter(config, inventory, options = {}) {
    const policy = parsePolicy(config);
    const parseSelection = (value) => parsePolicySelection(value, Object.keys(policy.automatic));
    const pending = new WeakMap();
    async function run(operation, selection, action) {
        const capture = createReceipt(policy, operation, selection, options);
        try {
            const result = await action(capture);
            capture.finish();
            return result;
        }
        catch (error) {
            capture.finish({ error });
            throw error;
        }
    }
    function validateConstraints(value) {
        for (const id of value.allowedChoices ?? [])
            if (!Object.hasOwn(policy.variants, id)) {
                throw new RoutingError("INVALID_SELECTION", `Unknown allowed choice: ${id}`);
            }
    }
    async function eligible(choice, target, limits, capture, stage, signal) {
        aborted(signal);
        const result = await inventory(target, limits.requiredInputs ?? ["text"], signal);
        aborted(signal);
        if (result.eligible !== true) {
            capture.candidate({ choice, eligible: false, stage, reason: inventoryCode(result.code) });
            return false;
        }
        const capacity = limits.capacity ? assessCapacity(limits.capacity, result.capacity) : undefined;
        capture.candidate({ choice, eligible: capacity?.eligible ?? true, stage,
            ...(capacity ? { capacity: capacity.assessment, ...(capacity.code ? { reason: capacity.code } : {}) } : {}) });
        return capacity?.eligible ?? true;
    }
    async function check(choice, limits, capture, signal) {
        const target = policy.variants[choice];
        if (!target)
            throw new RoutingError("INVALID_SELECTION", `Unknown variant: ${choice}`);
        if (limits.allowedChoices && !limits.allowedChoices.includes(choice)) {
            capture.candidate({ choice, eligible: false, stage: "filter", reason: "not_allowed" });
            throw new RoutingError("INELIGIBLE", `Choice is not permitted: ${choice}`);
        }
        if (!await eligible(choice, target, limits, capture, "recheck", signal))
            throw new RoutingError("INELIGIBLE", `Physical target is unavailable, restricted, or lacks required inputs/capacity for ${choice}`);
        return target;
    }
    function assignment(selection, choice, target, capture, decisionId = randomUUID(), capacity) {
        const instructions = policy.config.models[choice.split(":")[0]]?.instructions;
        const value = freeze({ decisionId, policyRevision: policy.revision, selection, choice, target, ...(instructions ? { instructions } : {}), ...(capacity ? { capacity } : {}) });
        capture.assigned(value);
        return value;
    }
    async function resolve(selection, limits, capture, signal) {
        const parsed = parseSelection(selection);
        if (parsed.mode !== "explicit")
            throw new RoutingError("INVALID_SELECTION", "Automatic selection requires a decision or selector");
        const role = policy.config.models[parsed.role];
        if (!role)
            throw new RoutingError("INVALID_SELECTION", `Unknown role: ${parsed.role}`);
        const c = constraints(limits);
        validateConstraints(c);
        capture.capacity(c.capacity);
        const choice = `${parsed.role}:${parsed.effort ?? role.defaultEffort}`;
        return assignment(selection, choice, await check(choice, c, capture, signal), capture, undefined, c.capacity);
    }
    async function prepare(selection, state, limits, capture, signal) {
        const parsed = parseSelection(selection);
        if (parsed.mode !== "auto")
            throw new RoutingError("INVALID_SELECTION", "Explicit choices use resolve(), not a selector");
        if (!state || typeof state !== "object" || Array.isArray(state))
            throw new RoutingError("INVALID_STATE", "State must be a JSON object");
        const stableState = snapshot(state, 16_384, "INVALID_STATE");
        const c = constraints(limits);
        validateConstraints(c);
        capture.capacity(c.capacity);
        const choices = new Set();
        const criteria = {};
        // Bounded catalog, sequential inventory checks, and cancellation between checks.
        const scope = policy.automatic[selection.split(":")[0]].namespace;
        for (const [choice, target] of Object.entries(policy.variants)) {
            const reason = scope && !choice.startsWith(`${scope}/`) ? "namespace" : parsed.effort && !choice.endsWith(`:${parsed.effort}`) ? "effort" : c.allowedChoices && !c.allowedChoices.includes(choice) ? "not_allowed" : undefined;
            if (reason) {
                capture.candidate({ choice, eligible: false, stage: "filter", reason });
                continue;
            }
            if (!await eligible(choice, target, c, capture, "inventory", signal))
                continue;
            choices.add(choice);
            criteria[choice] = policy.config.questions.route.criteria[choice];
        }
        if (!choices.size)
            throw new RoutingError("NO_CANDIDATES", "No eligible model variants satisfy this selection");
        criteria[ABSTAIN] = policy.config.questions.route.criteria[ABSTAIN];
        const decision = freeze({
            id: randomUUID(), revision: policy.revision, selection,
            request: { state: stableState, questions: { route: { ...policy.config.questions.route, criteria } } },
        });
        capture.prepared(decision.id);
        pending.set(decision, { choices, constraints: c, assessments: capture.assessments() });
        return decision;
    }
    async function accept(decision, answer, capture, signal) {
        aborted(signal);
        const saved = pending.get(decision);
        if (!saved || decision.revision !== policy.revision)
            throw new RoutingError("STALE_DECISION", "Unknown, consumed, or stale decision; prepare again");
        pending.delete(decision);
        capture.prepared(decision.id);
        capture.candidates(saved.assessments);
        capture.capacity(saved.constraints.capacity);
        // Bound untrusted LLM output without requiring a native classifier's extra probability fields.
        let value;
        try {
            value = snapshot(answer, 65_536, "INVALID_STATE");
        }
        catch {
            throw new RoutingError("INVALID_ANSWER", "Selector answer must be bounded JSON");
        }
        const envelope = value;
        const route = envelope?.answers?.route;
        if (route?.type !== "choice" || typeof route.choice !== "string")
            throw new RoutingError("INVALID_ANSWER", "Expected answers.route with type choice and a choice string");
        if (route.choice === ABSTAIN)
            throw new RoutingError("ABSTAINED", "The selector found no suitable assignment");
        if (!saved.choices.has(route.choice))
            throw new RoutingError("INVALID_ANSWER", "Selector chose an option that was not offered");
        return assignment(decision.selection, route.choice, await check(route.choice, saved.constraints, capture, signal), capture, decision.id, saved.constraints.capacity);
    }
    async function revalidate(value, limits, capture, signal) {
        if (value.policyRevision !== policy.revision)
            throw new RoutingError("STALE_DECISION", "Policy changed; start a new assignment or reselect explicitly");
        const requested = constraints(limits);
        const capacity = mergeCapacity(value.capacity, requested.capacity);
        const c = { ...requested, ...(capacity ? { capacity } : {}) };
        validateConstraints(c);
        capture.capacity(capacity);
        const target = await check(value.choice, c, capture, signal);
        if (target.provider !== value.target.provider || target.model !== value.target.model || target.thinking !== value.target.thinking) {
            throw new RoutingError("STALE_DECISION", "Assignment target no longer matches the policy");
        }
        const parsed = parseSelection(value.selection);
        if (parsed.mode === "auto") {
            const scope = policy.automatic[value.selection.split(":")[0]].namespace;
            if (scope && !value.choice.startsWith(`${scope}/`))
                throw new RoutingError("STALE_DECISION", "Assignment violates namespace scope");
            if (parsed.effort && !value.choice.endsWith(`:${parsed.effort}`))
                throw new RoutingError("STALE_DECISION", "Assignment violates fixed effort");
        }
        else {
            const expected = `${parsed.role}:${parsed.effort ?? policy.config.models[parsed.role]?.defaultEffort}`;
            if (value.choice !== expected)
                throw new RoutingError("STALE_DECISION", "Assignment differs from explicit selection");
        }
        return assignment(value.selection, value.choice, target, capture, value.decisionId, capacity);
    }
    async function select(selection, state, selector, limits, capture, signal) {
        if (parseSelection(selection).mode === "explicit")
            return { assignment: await resolve(selection, limits, capture, signal) };
        if (!selector)
            throw new RoutingError("SELECTOR_UNAVAILABLE", "Configure a classifier or provide a selector for automatic routing");
        const decision = await prepare(selection, state, limits, capture, signal);
        try {
            capture.invoking(selector);
            const result = await selector.select(decision.request, signal);
            capture.returned(result.metadata);
            return { assignment: await accept(decision, result.answer, capture, signal), metadata: result.metadata };
        }
        finally {
            pending.delete(decision);
        }
    }
    return Object.freeze({ policy,
        resolve: (selection, limits = {}, signal) => run("resolve", selection, c => resolve(selection, limits, c, signal)),
        prepare: (selection, state, limits = {}, signal) => run("prepare", selection, c => prepare(selection, state, limits, c, signal)),
        accept: (decision, answer, signal) => run("accept", decision?.selection, c => accept(decision, answer, c, signal)),
        revalidate: (value, limits = {}, signal) => run("revalidate", value?.selection, c => revalidate(value, limits, c, signal)),
        select: (selection, state, selector, limits = {}, signal) => run("select", selection, c => select(selection, state, selector, limits, c, signal)),
    });
}
//# sourceMappingURL=index.js.map