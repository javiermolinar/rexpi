import { RoutingError } from "./core/index.js";
/** Bounds even providers that ignore AbortSignal. No late result is applied after interruption. */
export async function selectorCall(timeoutMs, signal, call) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
        throw new RoutingError("INVALID_CONFIG", "Selector timeout must be 1–120000 ms");
    }
    if (signal?.aborted)
        throw new RoutingError("ABORTED", "Selection cancelled");
    const controller = new AbortController();
    let timer;
    let cancel;
    const interrupted = new Promise((_resolve, reject) => {
        cancel = () => { controller.abort(); reject(new RoutingError("ABORTED", "Selection cancelled")); };
        signal?.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(() => {
            controller.abort();
            reject(new RoutingError("SELECTOR_TIMEOUT", "Selector timed out; no model was substituted"));
        }, timeoutMs);
    });
    try {
        return await Promise.race([Promise.resolve().then(() => {
                if (controller.signal.aborted)
                    throw new RoutingError("ABORTED", "Selection cancelled");
                return call(controller.signal);
            }), interrupted]);
    }
    catch (error) {
        if (error instanceof RoutingError)
            throw error;
        throw new RoutingError("SELECTOR_ERROR", "Selector request failed (provider details withheld)");
    }
    finally {
        clearTimeout(timer);
        if (cancel)
            signal?.removeEventListener("abort", cancel);
        controller.abort();
    }
}
//# sourceMappingURL=selector-call.js.map