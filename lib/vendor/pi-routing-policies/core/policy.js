import { createHash } from "node:crypto";
import { ABSTAIN, DEFAULT_AUTO_MODEL, EFFORTS, EXECUTION_OUTCOMES, THINKING_LEVELS, RoutingError } from "./types.js";
import { capacityRequirement } from "./capacity.js";
export function record(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new RoutingError("INVALID_CONFIG", `${label} must be an object`);
    }
    return value;
}
export function keys(value, allowed, label) {
    for (const key of Object.keys(value))
        if (!allowed.includes(key)) {
            throw new RoutingError("INVALID_CONFIG", `${label}: unknown field ${key}`);
        }
}
function text(value, label, max = 4096) {
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
        throw new RoutingError("INVALID_CONFIG", `${label} must be a nonempty bounded string without control characters`);
    }
}
export function freeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            freeze(child);
        Object.freeze(value);
    }
    return value;
}
/** Reject lossy JSON (NaN, undefined, functions, cycles, class instances) rather than silently coercing it. */
export function snapshot(value, maxBytes, code = "INVALID_CONFIG") {
    let nodes = 0;
    const ancestors = new Set();
    function visit(v, depth) {
        if (++nodes > 20_000 || depth > 32)
            throw new RoutingError(code, "JSON exceeds structural limits");
        if (v === null || typeof v === "boolean" || typeof v === "string")
            return v;
        if (typeof v === "number" && Number.isFinite(v))
            return v;
        if (!v || typeof v !== "object" || ancestors.has(v))
            throw new RoutingError(code, "Expected finite, acyclic JSON data");
        if (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) {
            throw new RoutingError(code, "Expected plain JSON data");
        }
        ancestors.add(v);
        const result = Array.isArray(v) ? v.map(item => visit(item, depth + 1)) :
            Object.fromEntries(Object.keys(v).sort().map(key => [key, visit(v[key], depth + 1)]));
        ancestors.delete(v);
        return result;
    }
    const result = visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes)
        throw new RoutingError(code, "JSON exceeds byte limit");
    return freeze(result);
}
const ROLE = /^[a-z][a-z0-9-]{0,47}\/[a-z][a-z0-9-]{0,47}$/;
function validRole(role) { return ROLE.test(role) && role.split("/")[1] !== "auto"; }
function validateAutoModel(value) {
    if (typeof value !== "string" || !ROLE.test(value) || !value.endsWith("/auto")) {
        throw new RoutingError("INVALID_CONFIG", "autoModel must be namespace/auto without an effort suffix");
    }
}
/** Pass Object.keys(policy.automatic) for scoped policies; a single global identity is also accepted. */
export function parseSelection(value, automatic = DEFAULT_AUTO_MODEL) {
    const autoModels = typeof automatic === "string" ? [automatic] : automatic;
    for (const entry of autoModels)
        validateAutoModel(entry);
    if (typeof value !== "string")
        throw new RoutingError("INVALID_SELECTION", "Selection must be a string");
    const parts = value.split(":");
    const role = parts[0];
    const effort = parts[1];
    if (parts.length > 2 || (effort !== undefined && !EFFORTS.includes(effort))) {
        throw new RoutingError("INVALID_SELECTION", `Invalid effort in selection: ${value}`);
    }
    if (autoModels.includes(role))
        return { mode: "auto", ...(effort ? { effort: effort } : {}) };
    if (!validRole(role))
        throw new RoutingError("INVALID_SELECTION", `Expected namespace/role[:low|medium|high]: ${value}`);
    return { mode: "explicit", role, ...(effort ? { effort: effort } : {}) };
}
function target(value, label) {
    const t = record(value, label);
    keys(t, ["provider", "model", "thinking"], label);
    text(t.provider, `${label}.provider`, 128);
    text(t.model, `${label}.model`, 512);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(t.provider))
        throw new RoutingError("INVALID_CONFIG", `${label}: invalid provider`);
    if (!THINKING_LEVELS.includes(t.thinking))
        throw new RoutingError("INVALID_CONFIG", `${label}: invalid thinking level`);
}
export function parseSelectorConfig(input) {
    const selector = record(snapshot(input, 16_384), "selector");
    if (selector.kind !== "classifier" && selector.kind !== "llm")
        throw new RoutingError("INVALID_CONFIG", "selector.kind must be classifier or llm");
    keys(selector, selector.kind === "llm" ? ["kind", "provider", "model", "thinking", "timeoutMs", "maxTokens"] : ["kind", "provider", "model", "timeoutMs"], "selector");
    if (selector.kind === "llm") {
        target({ provider: selector.provider, model: selector.model, thinking: selector.thinking }, "selector");
        if (selector.maxTokens !== undefined && (!Number.isSafeInteger(selector.maxTokens) || Number(selector.maxTokens) < 128 || Number(selector.maxTokens) > 8192)) {
            throw new RoutingError("INVALID_CONFIG", "selector.maxTokens must be 128–8192");
        }
    }
    text(selector.provider, "selector.provider", 128);
    text(selector.model, "selector.model", 512);
    if (selector.timeoutMs !== undefined && (!Number.isSafeInteger(selector.timeoutMs) || Number(selector.timeoutMs) < 1 || Number(selector.timeoutMs) > 120_000)) {
        throw new RoutingError("INVALID_CONFIG", "selector.timeoutMs must be 1–120000");
    }
    return selector;
}
function executionGuidance(value, label) {
    const guidance = record(value, label);
    keys(guidance, EXECUTION_OUTCOMES, label);
    for (const [key, criterion] of Object.entries(guidance)) {
        if (typeof criterion !== "string" || !criterion.trim() || criterion.length > 2048 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(criterion)) {
            throw new RoutingError("INVALID_CONFIG", `${label}.${key} must be nonempty guidance up to 2048 characters without terminal controls`);
        }
    }
}
export function parsePolicy(input) {
    const config = record(snapshot(input, 262_144), "config");
    keys(config, ["version", "autoModel", "namespaces", "models", "questions", "selector", "routingContext", "nativeRouting", "direct", "executionGuidance"], "config");
    if (config.executionGuidance !== undefined)
        executionGuidance(config.executionGuidance, "executionGuidance");
    if (config.version !== 1)
        throw new RoutingError("INVALID_CONFIG", "Only policy version 1 is supported");
    const autoModel = config.autoModel === false ? undefined : config.autoModel === undefined ? DEFAULT_AUTO_MODEL : config.autoModel;
    if (autoModel !== undefined)
        validateAutoModel(autoModel);
    const models = record(config.models, "models");
    if (Object.keys(models).length === 0 || Object.keys(models).length > 64)
        throw new RoutingError("INVALID_CONFIG", "Configure 1–64 roles");
    const variants = {};
    for (const [name, value] of Object.entries(models)) {
        if (!validRole(name))
            throw new RoutingError("INVALID_CONFIG", `Invalid or reserved role: ${name}`);
        const role = record(value, name);
        keys(role, ["defaultEffort", "efforts", "instructions"], name);
        if (role.instructions !== undefined && (typeof role.instructions !== "string" || !role.instructions.trim() || role.instructions.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(role.instructions))) {
            throw new RoutingError("INVALID_CONFIG", `${name}.instructions must be nonempty guidance up to 4096 characters without terminal controls`);
        }
        const efforts = record(role.efforts, `${name}.efforts`);
        keys(efforts, EFFORTS, `${name}.efforts`);
        if (!EFFORTS.includes(role.defaultEffort) || !Object.hasOwn(efforts, String(role.defaultEffort))) {
            throw new RoutingError("INVALID_CONFIG", `${name}: defaultEffort must name a configured variant`);
        }
        for (const [effort, value] of Object.entries(efforts)) {
            target(value, `${name}:${effort}`);
            variants[`${name}:${effort}`] = value;
        }
    }
    const questions = record(config.questions, "questions");
    keys(questions, ["route"], "questions");
    const route = record(questions.route, "questions.route");
    keys(route, ["type", "instructions", "criteria"], "questions.route");
    if (route.type !== "choice")
        throw new RoutingError("INVALID_CONFIG", "route must be a choice question");
    text(route.instructions, "route.instructions", 8192);
    const criteria = record(route.criteria, "route.criteria");
    const expected = [...Object.keys(variants), ABSTAIN];
    keys(criteria, expected, "route.criteria");
    for (const id of expected)
        text(criteria[id], `criteria.${id}`);
    if (config.routingContext !== undefined && config.routingContext !== "off" && config.routingContext !== "assignment") {
        throw new RoutingError("INVALID_CONFIG", "routingContext must be off or assignment");
    }
    if (config.nativeRouting !== undefined) {
        const native = record(config.nativeRouting, "nativeRouting");
        keys(native, ["context", "affinity", "capacity"], "nativeRouting");
        if (native.affinity !== undefined && native.affinity !== "turn" && native.affinity !== "session") {
            throw new RoutingError("INVALID_CONFIG", "nativeRouting.affinity must be turn or session");
        }
        if (native.capacity !== undefined) {
            const capacity = record(native.capacity, "nativeRouting.capacity");
            keys(capacity, ["mode", "outputReserveTokens", "inputEstimate"], "nativeRouting.capacity");
            capacityRequirement({ mode: capacity.mode, outputReserveTokens: capacity.outputReserveTokens, inputTokens: null, estimateSource: "unknown" }, "INVALID_CONFIG");
            if (capacity.inputEstimate !== undefined && capacity.inputEstimate !== "unknown" && capacity.inputEstimate !== "pi-heuristic") {
                throw new RoutingError("INVALID_CONFIG", "nativeRouting.capacity.inputEstimate must be unknown or pi-heuristic");
            }
        }
        if (native.context !== undefined) {
            const context = record(native.context, "nativeRouting.context");
            keys(context, ["previousMessages", "maxHistoryChars", "maxMessageChars", "includeAssistant", "truncation"], "nativeRouting.context");
            for (const [key, min, max] of [["previousMessages", 0, 8], ["maxHistoryChars", 0, 8000], ["maxMessageChars", 128, 3000]]) {
                if (context[key] !== undefined && (!Number.isSafeInteger(context[key]) || Number(context[key]) < min || Number(context[key]) > max)) {
                    throw new RoutingError("INVALID_CONFIG", `nativeRouting.context.${key} must be ${min}–${max}`);
                }
            }
            if (context.includeAssistant !== undefined && typeof context.includeAssistant !== "boolean") {
                throw new RoutingError("INVALID_CONFIG", "nativeRouting.context.includeAssistant must be boolean");
            }
            if (context.truncation !== undefined && (typeof context.truncation !== "string" || !["prefix", "head-tail", "error"].includes(context.truncation))) {
                throw new RoutingError("INVALID_CONFIG", "nativeRouting.context.truncation must be prefix, head-tail or error");
            }
        }
    }
    const selector = config.selector === undefined ? undefined : parseSelectorConfig(config.selector);
    const automatic = {};
    if (autoModel !== undefined)
        automatic[autoModel] = { ...(selector ? { selector } : {}) };
    if (config.namespaces !== undefined) {
        const namespaces = record(config.namespaces, "namespaces");
        for (const [namespace, value] of Object.entries(namespaces)) {
            const identity = `${namespace}/auto`;
            validateAutoModel(identity);
            if (!Object.keys(models).some(role => role.startsWith(`${namespace}/`)))
                throw new RoutingError("INVALID_CONFIG", `Namespace has no configured roles: ${namespace}`);
            if (identity === autoModel)
                throw new RoutingError("INVALID_CONFIG", `Global and scoped automatic entries collide: ${identity}`);
            const options = record(value, `namespaces.${namespace}`);
            keys(options, ["selector", "executionGuidance"], `namespaces.${namespace}`);
            if (options.executionGuidance !== undefined)
                executionGuidance(options.executionGuidance, `namespaces.${namespace}.executionGuidance`);
            const selected = options.selector === undefined ? selector : parseSelectorConfig(options.selector);
            automatic[identity] = { namespace, ...(selected ? { selector: selected } : {}) };
        }
    }
    if (config.direct !== undefined)
        target(config.direct, "direct");
    // Reject references to this package's own native entries before touching the inventory.
    const nativeRefs = new Set(Object.keys(automatic).flatMap(id => [id, ...EFFORTS.flatMap(e => [`${id}/${e}`, `${id}:${e}`])]));
    for (const name of Object.keys(models)) {
        nativeRefs.add(name);
        for (const effort of EFFORTS)
            nativeRefs.add(`${name}/${effort}`);
    }
    const selectors = [selector, ...Object.values(automatic).map(route => route.selector)].filter(s => s?.kind === "llm");
    for (const t of [...Object.values(variants), ...(config.direct ? [config.direct] : []), ...selectors]) {
        if (nativeRefs.has(`${t.provider}/${t.model}`) || Object.hasOwn(variants, `${t.provider}/${t.model}`)) {
            throw new RoutingError("INVALID_CONFIG", "Targets must be physical, not this catalog's virtual entries");
        }
    }
    const revision = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    return freeze({ config: config, autoModel, automatic, variants, revision });
}
//# sourceMappingURL=policy.js.map