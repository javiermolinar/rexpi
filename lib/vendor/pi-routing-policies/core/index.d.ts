import type { Assignment, Constraints, Decision, Input, Inventory, RouterOptions, Selector } from "./types.ts";
export * from "./types.ts";
export { parsePolicy, parseSelection } from "./policy.ts";
export { assessCapacity } from "./capacity.ts";
/** Imports do no I/O. Each router owns immutable policy and decision handles; callers own workflow state. */
export declare function createRouter(config: unknown, inventory: Inventory, options?: RouterOptions): Readonly<{
    policy: import("./types.ts").Policy;
    resolve: (selection: string, limits?: Constraints, signal?: AbortSignal) => Promise<Assignment>;
    prepare: (selection: string, state: Record<string, unknown>, limits?: Constraints, signal?: AbortSignal) => Promise<Decision>;
    accept: (decision: Decision, answer: unknown, signal?: AbortSignal) => Promise<Assignment>;
    revalidate: (value: Assignment, limits?: Constraints, signal?: AbortSignal) => Promise<Assignment>;
    select: (selection: string, state: Record<string, unknown>, selector?: Selector, limits?: Constraints, signal?: AbortSignal) => Promise<{
        assignment: Assignment;
        metadata?: undefined;
    } | {
        assignment: Assignment;
        metadata: Readonly<Record<string, unknown>> | undefined;
    }>;
}>;
export type Router = ReturnType<typeof createRouter>;
export type { Input };
