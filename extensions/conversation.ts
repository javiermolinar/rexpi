import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requireFeature, type Runtime } from "../lib/runtime.ts";
import type { MessagingRuntime } from "../lib/messaging/runtime.ts";

export interface ConversationState { runtime?: Runtime; messaging?: MessagingRuntime }

/** Register only after verified Rex activation. Identity remains evidence, never authority. */
export function registerConversationTools(pi: ExtensionAPI, current: () => ConversationState): void {
  pi.registerTool({
    name: "rex_return_to_parent", label: "Return to parent Pi conversation",
    description: "Focus the exact live parent; fail if unavailable. Cross-session focus needs Rex Remote Control.",
    executionMode: "sequential",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const { runtime } = current();
      const active = requireFeature(runtime, runtime, ctx.sessionManager.getSessionId());
      const target = await active.returnToOrigin(process.env.PI_REX_CLIENT, signal);
      return { content: [{ type: "text", text: "Returned to the exact parent Pi conversation at " + target.blockId + ". No task was sent or started." }],
        details: { target } };
    },
  });
  pi.registerTool({
    name: "rex_inspect", label: "Inspect pi-rex state",
    description: "Read identity, parent, up to 64 remembered children and body-free messaging status. Local evidence, not a process-health probe.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const { runtime, messaging } = current();
      const active = requireFeature(runtime, runtime, ctx.sessionManager.getSessionId());
      const own = active.snapshot();
      const details = { ...own.state, blockId: own.blockId, children: active.childStatus(), messaging: messaging?.snapshot() };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });
}
