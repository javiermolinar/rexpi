/** Bounds even providers that ignore AbortSignal. No late result is applied after interruption. */
export declare function selectorCall<T>(timeoutMs: number, signal: AbortSignal | undefined, call: (signal: AbortSignal) => Promise<T>): Promise<T>;
