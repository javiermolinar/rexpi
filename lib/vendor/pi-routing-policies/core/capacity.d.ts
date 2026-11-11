import type { CapacityAssessment, CapacityExclusionCode, CapacityLimits, CapacityRequirement } from "./types.ts";
export declare const MAX_CAPACITY_TOKENS = 1000000000;
export declare function capacityRequirement(input: unknown, code?: "INVALID_CONFIG" | "INVALID_SELECTION"): CapacityRequirement;
/** A fresh input estimate can replace the old one, but original mode/output requirements cannot be dropped. */
export declare function mergeCapacity(original?: CapacityRequirement, next?: CapacityRequirement): CapacityRequirement | undefined;
export declare function observedCapacity(limits?: CapacityLimits): Pick<CapacityAssessment, "contextWindow" | "maxOutputTokens">;
/** Numeric registry observations only. No policy state, text or provider prose can enter an assessment. */
export declare function assessCapacity(requirement: CapacityRequirement, limits?: CapacityLimits): {
    eligible: boolean;
    code?: CapacityExclusionCode;
    assessment: CapacityAssessment;
};
