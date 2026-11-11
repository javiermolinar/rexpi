export declare const EFFORTS: readonly ["low", "medium", "high"];
export declare const THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export declare const ABSTAIN = "__abstain__";
export declare const DEFAULT_AUTO_MODEL = "virt/auto";
export type Effort = (typeof EFFORTS)[number];
export type Thinking = (typeof THINKING_LEVELS)[number];
export type Input = "text" | "image";
export interface Target {
    readonly provider: string;
    readonly model: string;
    readonly thinking: Thinking;
}
export interface Role {
    readonly defaultEffort: Effort;
    readonly efforts: Readonly<Partial<Record<Effort, Target>>>;
    /** Soft guidance for the executing model, not selector instructions or tool permissions. */
    readonly instructions?: string;
}
export interface ChoiceQuestion {
    readonly type: "choice";
    readonly instructions: string;
    readonly criteria: Readonly<Record<string, string>>;
}
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export interface ClassifierRequest {
    readonly state: Readonly<Record<string, JsonValue>>;
    readonly questions: {
        readonly route: ChoiceQuestion;
    };
}
interface SelectorBaseConfig {
    readonly provider: string;
    readonly model: string;
    readonly timeoutMs?: number;
}
export interface ClassifierSelectorConfig extends SelectorBaseConfig {
    readonly kind: "classifier";
}
export interface LlmSelectorConfig extends SelectorBaseConfig {
    readonly kind: "llm";
    /** Reasoning for the routing call, independent of the chosen execution target. */
    readonly thinking: Thinking;
    readonly maxTokens?: number;
}
export type SelectorConfig = ClassifierSelectorConfig | LlmSelectorConfig;
export interface NativeContextConfig {
    /** Prior user messages, or user/assistant messages when includeAssistant is true. Default 3; 0–8. */
    readonly previousMessages?: number;
    /** Total prior-text budget, in UTF-16 code units. Default 8000; 0–8000. */
    readonly maxHistoryChars?: number;
    /** Per-message text limit, including the current task. Default 3000; 128–3000. */
    readonly maxMessageChars?: number;
    readonly includeAssistant?: boolean;
    /** Default head-tail when context is explicitly enabled. */
    readonly truncation?: "prefix" | "head-tail" | "error";
}
export type CapacityMode = "require-estimated-fit" | "allow-compaction";
export interface CapacityRequirement {
    readonly mode: CapacityMode;
    /** Estimated execution input, not selector-state tokens; null is unknown. */
    readonly inputTokens: number | null;
    readonly outputReserveTokens: number;
    readonly estimateSource: "caller" | "pi-heuristic" | "unknown";
}
export interface CapacityLimits {
    readonly contextWindow?: number | null;
    readonly maxOutputTokens?: number | null;
}
export interface CapacityAssessment {
    readonly contextWindow: number | null;
    readonly maxOutputTokens: number | null;
    readonly status: "estimated_fit" | "context_exceeded" | "output_exceeded" | "unknown";
}
export type CapacityExclusionCode = "capacity_unknown" | "capacity_context" | "capacity_output";
export interface NativeCapacityConfig {
    readonly mode: CapacityMode;
    readonly outputReserveTokens: number;
    /** No guessed input by default. Pi's heuristic is explicit, local and pre-transform only. */
    readonly inputEstimate?: "unknown" | "pi-heuristic";
}
export interface NativeRoutingConfig {
    /** Absent: latest-user prefix only. Present: explicitly admit bounded dialogue. */
    readonly context?: NativeContextConfig;
    /** turn (default): select per user turn; session: reuse until manual change/reselection. */
    readonly affinity?: "turn" | "session";
    readonly capacity?: NativeCapacityConfig;
}
export declare const EXECUTION_OUTCOMES: readonly ["continueCurrent", "routeMainSession", "delegateThroughPolicy", "askForClarification"];
/** Advisory criteria only: never permissions, model pins, or executable actions. */
export type ExecutionGuidance = Readonly<Partial<Record<(typeof EXECUTION_OUTCOMES)[number], string>>>;
export interface PolicyConfig {
    readonly version: 1;
    /** Global automatic entry. Defaults to virt/auto; false disables it. */
    readonly autoModel?: string | false;
    /** Opt-in namespace/auto entries; an omitted selector inherits the root selector. */
    readonly namespaces?: Readonly<Record<string, {
        readonly selector?: SelectorConfig;
        readonly executionGuidance?: ExecutionGuidance;
    }>>;
    /** Optional root execution preferences, consumed only by the enabled subagent integration. */
    readonly executionGuidance?: ExecutionGuidance;
    readonly models: Readonly<Record<string, Role>>;
    readonly questions: {
        readonly route: ChoiceQuestion;
    };
    readonly selector?: SelectorConfig;
    /** Optional transient current-assignment note in execution context. UI notices are always separate. */
    readonly routingContext?: "off" | "assignment";
    /** Native adapter only; never discovers history for library/tool/preview requests. */
    readonly nativeRouting?: NativeRoutingConfig;
    /** Explicit physical target for compaction/direct requests without a current assignment. */
    readonly direct?: Target;
}
export interface Policy {
    readonly config: PolicyConfig;
    readonly autoModel?: string;
    readonly automatic: Readonly<Record<string, {
        readonly namespace?: string;
        readonly selector?: SelectorConfig;
    }>>;
    readonly revision: string;
    readonly variants: Readonly<Record<string, Target>>;
}
export type Selection = {
    readonly mode: "auto";
    readonly effort?: Effort;
} | {
    readonly mode: "explicit";
    readonly role: string;
    readonly effort?: Effort;
};
export interface Constraints {
    readonly allowedChoices?: readonly string[];
    readonly requiredInputs?: readonly Input[];
    readonly capacity?: CapacityRequirement;
}
export type InventoryExclusionCode = "model_missing" | "not_physical" | "auth_missing" | "input_unsupported" | "restricted" | "inventory_rejected";
export interface Eligibility {
    readonly eligible: boolean;
    /** Stable diagnostic code. Arbitrary reason prose is never copied into receipts. */
    readonly code?: InventoryExclusionCode;
    readonly reason?: string;
    /** Current observed physical-model limits; absent/unusable fields are unknown. */
    readonly capacity?: CapacityLimits;
}
/** Must check physical identity/type, current auth, input support, and consumer restrictions. */
export type Inventory = (target: Target, requiredInputs: readonly Input[], signal?: AbortSignal) => Eligibility | Promise<Eligibility>;
export interface Decision {
    readonly id: string;
    readonly revision: string;
    readonly selection: string;
    readonly request: ClassifierRequest;
}
export interface Assignment {
    readonly decisionId: string;
    readonly policyRevision: string;
    readonly selection: string;
    readonly choice: string;
    readonly target: Target;
    readonly instructions?: string;
    /** Retained requirements, not token counts guaranteed by a provider or authority. */
    readonly capacity?: CapacityRequirement;
}
export interface SelectionResult {
    readonly answer: unknown;
    readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface Selector {
    /** Optional public identity only; never credentials or request data. */
    readonly identity?: {
        readonly kind: "classifier" | "llm" | "custom";
        readonly provider?: string;
        readonly model?: string;
    };
    select(request: ClassifierRequest, signal?: AbortSignal): Promise<SelectionResult>;
}
export type CandidateExclusionCode = InventoryExclusionCode | CapacityExclusionCode | "namespace" | "effort" | "not_allowed";
export interface CandidateAssessment {
    readonly choice: string;
    readonly eligible: boolean;
    readonly stage: "filter" | "inventory" | "recheck";
    readonly reason?: CandidateExclusionCode;
    readonly capacity?: CapacityAssessment;
}
export interface SelectorObservation {
    /** null means unreported, never an inferred zero. */
    readonly totalTokens: number | null;
    readonly cost: number | null;
}
export interface DecisionReceipt {
    readonly version: 1;
    readonly id: string;
    readonly policyRevision: string;
    /** null for unrecognized/malformed selections, rather than retaining arbitrary input. */
    readonly selection: string | null;
    readonly operation: "resolve" | "prepare" | "accept" | "select" | "revalidate" | "route";
    readonly startedAt: number;
    readonly durationMs: number;
    readonly outcome: "assigned" | "prepared" | "abstained" | "aborted" | "error";
    readonly errorCode?: ErrorCode | "INTERNAL_ERROR";
    readonly decisionId?: string;
    readonly candidates: readonly CandidateAssessment[];
    readonly capacity?: CapacityRequirement;
    readonly assignment?: {
        readonly choice: string;
        readonly target: Target;
    };
    readonly selector: {
        /** Method invocation, not proof of an HTTP request or billable execution. */
        readonly invoked: boolean;
        readonly outcome: "not_invoked" | "returned" | "unavailable" | "timeout" | "aborted" | "error";
        readonly identity?: NonNullable<Selector["identity"]>;
        readonly durationMs?: number;
        readonly usage: SelectorObservation;
    };
}
export interface RouterOptions {
    /** Invoked synchronously, not awaited. Observer throws/rejections are isolated from routing. */
    readonly onReceipt?: (receipt: DecisionReceipt) => void;
}
export type ErrorCode = "INVALID_CONFIG" | "INVALID_SELECTION" | "INELIGIBLE" | "NO_CANDIDATES" | "INVALID_STATE" | "INVALID_ANSWER" | "STALE_DECISION" | "ABSTAINED" | "ABORTED" | "SELECTOR_UNAVAILABLE" | "SELECTOR_ERROR" | "SELECTOR_TIMEOUT" | "NO_ASSIGNMENT";
export declare class RoutingError extends Error {
    readonly code: ErrorCode;
    readonly selectorObservation?: SelectorObservation;
    constructor(code: ErrorCode, message: string, selectorObservation?: SelectorObservation);
}
export {};
