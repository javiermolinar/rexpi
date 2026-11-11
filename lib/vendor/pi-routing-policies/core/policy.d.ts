import type { Policy, Selection, SelectorConfig } from "./types.ts";
export declare function record(value: unknown, label: string): Record<string, unknown>;
export declare function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void;
export declare function freeze<T>(value: T): T;
/** Reject lossy JSON (NaN, undefined, functions, cycles, class instances) rather than silently coercing it. */
export declare function snapshot(value: unknown, maxBytes: number, code?: "INVALID_CONFIG" | "INVALID_STATE"): unknown;
/** Pass Object.keys(policy.automatic) for scoped policies; a single global identity is also accepted. */
export declare function parseSelection(value: string, automatic?: string | readonly string[]): Selection;
export declare function parseSelectorConfig(input: unknown): SelectorConfig;
export declare function parsePolicy(input: unknown): Policy;
