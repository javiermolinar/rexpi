import { createClassifierSelector } from "./classifier.js";
import { createLlmSelector } from "./llm.js";
export { createClassifierSelector } from "./classifier.js";
export { createLlmSelector } from "./llm.js";
/** Select exactly the configured backend. There is no implicit backend or provider fallback. */
export function createSelector(registry, config, onResult) {
    if (!config)
        return undefined;
    return config.kind === "classifier" ? createClassifierSelector(registry, config, onResult) : createLlmSelector(registry, config, onResult);
}
//# sourceMappingURL=selectors.js.map