import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { LlmSelectorConfig, Selector } from "./core/index.ts";
/** One bounded native Pi chat call, with reasoning independent of the chosen physical assignment. */
export declare function createLlmSelector(registry: Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "streamSimple">, input: LlmSelectorConfig, onResult?: (metadata: Readonly<Record<string, unknown>>) => void): Selector;
