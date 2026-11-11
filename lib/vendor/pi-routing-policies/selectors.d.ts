import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Selector, SelectorConfig } from "./core/index.ts";
export { createClassifierSelector } from "./classifier.ts";
export { createLlmSelector } from "./llm.ts";
/** Select exactly the configured backend. There is no implicit backend or provider fallback. */
export declare function createSelector(registry: ModelRegistry, config?: SelectorConfig, onResult?: (metadata: Readonly<Record<string, unknown>>) => void): Selector | undefined;
