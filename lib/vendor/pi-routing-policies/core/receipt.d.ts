import type { Assignment, CandidateAssessment, CapacityRequirement, DecisionReceipt, InventoryExclusionCode, Policy, RouterOptions, Selector, SelectorObservation } from "./types.ts";
export declare function inventoryCode(value: unknown): InventoryExclusionCode;
/** Only reported numeric usage survives. No raw provider fields, prose or task state. */
export declare function selectorObservation(metadata: unknown): SelectorObservation;
/** Keep known usage when a completed provider response subsequently fails validation. */
export declare function observedSelectorResult<T>(metadata: unknown, finish: () => T): T;
/** Per-operation state: never shared between concurrent decisions, and never contains the task. */
export declare function createReceipt(policy: Policy, operation: DecisionReceipt["operation"], selection: unknown, options: RouterOptions): {
    capacity(value?: CapacityRequirement): void;
    candidate(value: CandidateAssessment): void;
    candidates(values: readonly CandidateAssessment[]): void;
    assessments(): readonly CandidateAssessment[];
    prepared(value: string): void;
    assigned(value: Assignment): void;
    invoking(selector: Selector): void;
    returned(metadata: unknown): void;
    finish(failure?: {
        error: unknown;
    }): void;
};
export type ReceiptCapture = ReturnType<typeof createReceipt>;
