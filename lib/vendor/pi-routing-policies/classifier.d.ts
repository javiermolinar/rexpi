import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Selector, ClassifierSelectorConfig } from "./core/index.ts";
/** Native Pi classifier execution; no pi-typesafe extension or chat-prompt proxy. */
export declare function createClassifierSelector(registry: Pick<ModelRegistry, "findOfType" | "classify">, input: ClassifierSelectorConfig, onResult?: (metadata: Readonly<Record<string, unknown>>) => void): Selector;
