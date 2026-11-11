import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  createRouter,
  parseSelection,
  type Assignment,
  type DecisionReceipt,
  type Input,
  type Inventory,
  type Selector,
} from "./vendor/pi-routing-policies/core/index.js";
import { createSelector } from "./vendor/pi-routing-policies/selectors.js";

const MAX_TASK_LENGTH = 16_384;
const MAX_AUTOMATIC_TASK_LENGTH = 3000;
const REQUIRED_INPUTS: readonly Input[] = ["text"];

export type SelectorMetadata = Readonly<Record<string, unknown>>;
export interface PolicyResolution {
  assignment: Assignment;
  receipt: DecisionReceipt;
  selectorMetadata?: SelectorMetadata;
}
export interface PolicyResolverOptions {
  /** Automatic selection can add provider latency and cost. Explicit roles never invoke it. */
  allowAutomatic?: boolean;
  /** Deterministic selector override for embedding hosts and fake-provider tests. */
  selector?: Selector;
  /** Terminal routing records only; task text and raw selector answers are not included. */
  onReceipt?: (receipt: DecisionReceipt) => void;
}
export interface PolicyResolver {
  select(selection: string, task: string, signal?: AbortSignal): Promise<PolicyResolution>;
  revalidate(previous: PolicyResolution, signal?: AbortSignal): Promise<PolicyResolution>;
}
export interface PolicySelectionRuntime {
  select(selection: string, task: string, allowAutomatic: boolean, signal?: AbortSignal): Promise<PolicyResolution>;
  revalidate(previous: PolicyResolution, signal?: AbortSignal): Promise<PolicyResolution>;
}

export class PolicyAdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PolicyAdapterError";
    this.code = code;
  }
}

function automaticState(task: string): { task: string; taskTruncated: boolean } {
  return { task: task.slice(0, MAX_AUTOMATIC_TASK_LENGTH), taskTruncated: task.length > MAX_AUTOMATIC_TASK_LENGTH };
}
function validateSelection(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || value.includes("\0"))
    throw new PolicyAdapterError("invalid_selection", "Selection must be a non-empty bounded string");
}
function validateTask(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TASK_LENGTH || value.includes("\0"))
    throw new PolicyAdapterError("invalid_task", "Task must be a non-empty string of at most 16,384 characters");
}

/**
 * Resolve physical assignments without registration, session changes, delegation, or launch side effects.
 * Automatic selectors receive only the current task prefix and taskTruncated, never conversation history.
 */
export function createPolicyResolver(config: unknown, registry: ModelRegistry,
    options: PolicyResolverOptions = {}): PolicyResolver {
  const inventory: Inventory = (target, requiredInputs) => {
    const model = registry.find(target.provider, target.model);
    if (!model) return { eligible: false, code: "model_missing" };
    if (model.api === "pi-virtual") return { eligible: false, code: "not_physical" };
    if (!registry.hasConfiguredAuth(model)) return { eligible: false, code: "auth_missing" };
    if (!requiredInputs.every(input => model.input.includes(input))) return { eligible: false, code: "input_unsupported" };
    return { eligible: true, capacity: { contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens } };
  };
  const routerFor = (receipts: DecisionReceipt[]) => createRouter(config, inventory, {
    onReceipt(value) { receipts.push(value); options.onReceipt?.(value); },
  });
  const terminalReceipt = (receipts: DecisionReceipt[]): DecisionReceipt => {
    const receipt = receipts.at(-1);
    if (!receipt) throw new PolicyAdapterError("receipt_missing", "The policy router emitted no terminal receipt");
    return receipt;
  };
  return {
    async select(selection, task, signal) {
      validateSelection(selection); validateTask(task);
      const normalized = selection.trim();
      const receipts: DecisionReceipt[] = [], router = routerFor(receipts);
      const parsed = parseSelection(normalized, Object.keys(router.policy.automatic));
      const automatic = parsed.mode === "auto";
      if (automatic && options.allowAutomatic !== true)
        throw new PolicyAdapterError("automatic_disabled", "Automatic policy selection requires allowAutomatic: true");
      signal?.throwIfAborted();
      const selector = automatic
        ? options.selector ?? createSelector(registry, router.policy.automatic[normalized.split(":")[0]!]?.selector)
        : undefined;
      const resolved = await router.select(normalized, automatic ? automaticState(task) : { task }, selector,
        { requiredInputs: REQUIRED_INPUTS }, signal);
      return { assignment: resolved.assignment, receipt: terminalReceipt(receipts),
        ...(resolved.metadata === undefined ? {} : { selectorMetadata: resolved.metadata }) };
    },
    async revalidate(previous, signal) {
      if (!previous || typeof previous !== "object" || !previous.assignment || typeof previous.assignment !== "object")
        throw new PolicyAdapterError("invalid_previous_result", "A previous policy resolution is required");
      signal?.throwIfAborted();
      const receipts: DecisionReceipt[] = [], router = routerFor(receipts);
      const assignment = await router.revalidate(previous.assignment, { requiredInputs: REQUIRED_INPUTS }, signal);
      return { assignment, receipt: terminalReceipt(receipts),
        ...(previous.selectorMetadata === undefined ? {} : { selectorMetadata: previous.selectorMetadata }) };
    },
  };
}

/** Lazy policy loading: callers without a selection never read configuration. Revalidation rereads it. */
export function createFilePolicySelectionRuntime(agentDirectory: string, registry: ModelRegistry,
    environment: { PI_VIRTUAL_MODELS_CONFIG?: string } = process.env): PolicySelectionRuntime {
  const policyPath = resolve(environment.PI_VIRTUAL_MODELS_CONFIG ?? join(agentDirectory, "virtual-models.json"));
  const load = async (): Promise<unknown> => JSON.parse(await readFile(policyPath, "utf8"));
  return {
    async select(selection, task, allowAutomatic, signal) {
      return createPolicyResolver(await load(), registry, { allowAutomatic }).select(selection, task, signal);
    },
    async revalidate(previous, signal) {
      return createPolicyResolver(await load(), registry).revalidate(previous, signal);
    },
  };
}
