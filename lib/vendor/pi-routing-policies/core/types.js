export const EFFORTS = ["low", "medium", "high"];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const ABSTAIN = "__abstain__";
export const DEFAULT_AUTO_MODEL = "virt/auto";
export const EXECUTION_OUTCOMES = ["continueCurrent", "routeMainSession", "delegateThroughPolicy", "askForClarification"];
export class RoutingError extends Error {
    code;
    selectorObservation;
    constructor(code, message, selectorObservation) {
        super(message);
        this.name = "RoutingError";
        this.code = code;
        if (selectorObservation)
            this.selectorObservation = Object.freeze({ totalTokens: selectorObservation.totalTokens, cost: selectorObservation.cost });
    }
}
//# sourceMappingURL=types.js.map