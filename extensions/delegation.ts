import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CapabilityRuntime } from "../lib/capability-runtime.ts";
import type { DelegationCache, DelegationRuntime } from "../lib/delegation.ts";
import type { MessagingRuntime } from "../lib/messaging/runtime.ts";
import { requireFeature, type Runtime } from "../lib/runtime.ts";
import { capabilityGrant } from "./grants.ts";
import { boundedJson } from "./presentation.ts";
import { LAUNCH_PLACEMENTS, THINKING, literalUnion } from "./schemas.ts";

export interface DelegationToolState {
  runtime?: Runtime;
  delegation?: DelegationRuntime;
  messaging?: MessagingRuntime;
  capability?: CapabilityRuntime;
  cache?: DelegationCache;
}
export function registerDelegationTool(pi: ExtensionAPI, current: () => DelegationToolState): void {
  pi.registerTool({
    name: "rexpi_delegate", label: "Delegate a scoped agent task",
    description: "Launch one supervised subagent with an explicit task and capability grant.",
    executionMode: "sequential",
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 16384 }),
      grant: capabilityGrant,
      cwd: Type.Optional(Type.String()),
      project: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      placement: Type.Optional(literalUnion(LAUNCH_PLACEMENTS)),
      sessionName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      title: Type.Optional(Type.String({ maxLength: 120 })),
      focus: Type.Optional(Type.Boolean()),
      provider: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
      thinking: Type.Optional(literalUnion(THINKING)),
      selection: Type.Optional(Type.String()),
      allowAutomatic: Type.Optional(Type.Boolean()),
      notifyParentOnSettlement: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(id, params, signal, _update, ctx) {
      const source = current(), cache = source.cache;
      if (!cache) throw new Error("Delegation evidence is unavailable");
      const options = { grant: params.grant,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        ...(params.project === undefined ? {} : { project: params.project }),
        ...(params.placement === undefined ? {} : { placement: params.placement }),
        ...(params.sessionName === undefined ? {} : { sessionName: params.sessionName }),
        ...(params.title === undefined ? {} : { title: params.title }),
        ...(params.focus === undefined ? {} : { focus: params.focus }),
        ...(params.provider === undefined ? {} : { provider: params.provider }),
        ...(params.model === undefined ? {} : { model: params.model }),
        ...(params.thinking === undefined ? {} : { thinking: params.thinking }),
        ...(params.selection === undefined ? {} : { selection: params.selection }),
        ...(params.allowAutomatic === undefined ? {} : { allowAutomatic: params.allowAutomatic }),
        ...(params.notifyParentOnSettlement === undefined ? {}
          : { notifyParentOnSettlement: params.notifyParentOnSettlement }) };
      // Admission precedes every runtime/capability check. Exact historical calls inspect
      // their original outcome without acquiring replacement authority or a new launcher.
      const details = await cache.run(id, params.task, options, ctx.cwd, (task, admitted) => {
        const runtime = source.runtime, delegation = source.delegation;
        if (!runtime || !delegation) throw new Error("Rexpi delegation is not active in a verified Rex terminal");
        if (runtime.snapshot().state.piSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Pi source conversation changed");
        requireFeature(runtime, delegation, ctx.sessionManager.getSessionId());
        const grant = source.capability ? source.capability.deriveChildGrant(admitted.grant) : admitted.grant;
        source.messaging?.observeRun(ctx);
        return delegation.compose(id, task, { ...admitted, grant }, ctx.cwd,
          source.capability?.toolSignal(signal) ?? signal);
      });
      const text = `Delegation ${details.creation}/${details.binding}; activity unknown; result pending.\n`
        + boundedJson({ handle: details.handle, ...(details.routing ? { routing: details.routing } : {}) }, 4096, "Delegation");
      return { content: [{ type: "text", text }], details };
    },
  });
}
