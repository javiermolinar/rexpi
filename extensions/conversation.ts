import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requireFeature, type Runtime } from "../lib/runtime.ts";
import type { MessagingRuntime } from "../lib/messaging/runtime.ts";
import type { AgentRuntime, AgentStatus } from "../lib/agent-runtime.ts";
import { boundedJson, clippedText } from "./presentation.ts";
import type { HostSelection } from "../lib/host-selection.ts";

const MAX_AGENT_INSPECTION_BYTES = 128 * 1024;
function agentPresentation(status: AgentStatus) {
  return { handle: status.handle, lifecycle: status.lifecycle, resultAvailable: status.resultAvailable,
    evidence: status.evidence, ...(status.readError ? { readError: clippedText(status.readError) } : {}) };
}

export interface ConversationState { runtime?: Runtime; messaging?: MessagingRuntime;
  agent?: Pick<AgentRuntime, "cachedStatuses">; hostSelection?: HostSelection }

/** Register only after verified Rex activation. Identity remains evidence, never authority. */
export function registerConversationTools(pi: ExtensionAPI, current: () => ConversationState): void {
  pi.registerTool({
    name: "rexpi_return_to_parent", label: "Return to parent Pi conversation",
    description: "Focus the exact live parent Pi conversation.",
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
    name: "rexpi_inspect", label: "Inspect Rexpi state",
    description: "Inspect Rexpi state.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({ includeAgents: Type.Optional(Type.Boolean({
      description: "Include retained agent handles and lifecycle states; default false." })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const { runtime, messaging, agent, hostSelection } = current();
      const active = requireFeature(runtime, runtime, ctx.sessionManager.getSessionId());
      const own = active.snapshot();
      const agents = params.includeAgents ? agent?.cachedStatuses().map(agentPresentation) : undefined;
      if (agents) boundedJson(agents, MAX_AGENT_INSPECTION_BYTES, "Agent inspection");
      const details = { ...own.state, blockId: own.blockId,
        localOrigin: { serverHostId: own.server.hostId, serverInstanceId: own.server.instanceId },
        executionHost: hostSelection?.snapshot(),
        children: active.childStatus(), messaging: messaging?.snapshot(),
        ...(agents ? { agents } : {}) };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });
}
