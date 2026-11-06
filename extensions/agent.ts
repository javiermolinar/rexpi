import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AGENT_HANDLE_VERSION, type AgentHandle } from "../lib/agent.ts";
import { AgentRuntime, MAX_AGENT_COMPLETION_ARTIFACT_BYTES, MAX_AGENT_COMPLETION_ARTIFACTS,
  MAX_AGENT_COMPLETION_ERROR_CODE_BYTES, MAX_AGENT_COMPLETION_ERROR_DETAILS_BYTES,
  MAX_AGENT_COMPLETION_ERROR_MESSAGE_BYTES, MAX_AGENT_COMPLETION_SUMMARY_BYTES, MAX_AGENT_CURSOR_BYTES,
  MAX_AGENT_EVENT_PAGE_SIZE } from "../lib/agent-runtime.ts";
import type { PeerRuntime } from "../lib/peer.ts";
import { requireFeature, type Runtime } from "../lib/runtime.ts";

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const uuid = () => Type.String({ pattern: UUID_PATTERN });
const handle = Type.Object({
  version: Type.Literal(AGENT_HANDLE_VERSION),
  taskId: uuid(), conversationId: uuid(), runtimeId: uuid(), runId: uuid(),
  requestId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" }),
  messageId: uuid(), endpointGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });

export interface AgentToolState { runtime?: Runtime; peer?: PeerRuntime; agent?: AgentRuntime; localAgentHandle?: AgentHandle }

export function registerAgentTools(pi: ExtensionAPI, current: () => AgentToolState): void {
  const localAgentHandle = current().localAgentHandle;
  const active = (sessionId: string) => {
    const source = current();
    requireFeature(source.runtime, source.peer, sessionId);
    return requireFeature(source.runtime, source.agent, sessionId);
  };
  pi.registerTool({
    name: "rex_agent_complete", label: "Record local agent completion",
    description: "Done.",
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({
      ...(localAgentHandle ? {} : { handle,
        requestId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" }),
        runId: uuid(), runtimeId: uuid() }),
      outcome: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled")]),
      summary: Type.String({ minLength: 1, maxLength: MAX_AGENT_COMPLETION_SUMMARY_BYTES }),
      artifacts: Type.Optional(Type.Array(Type.String({ minLength: 1,
        maxLength: MAX_AGENT_COMPLETION_ARTIFACT_BYTES }), { maxItems: MAX_AGENT_COMPLETION_ARTIFACTS })),
      error: Type.Optional(Type.Object({
        code: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_AGENT_COMPLETION_ERROR_CODE_BYTES })),
        message: Type.String({ minLength: 1, maxLength: MAX_AGENT_COMPLETION_ERROR_MESSAGE_BYTES }),
        details: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_AGENT_COMPLETION_ERROR_DETAILS_BYTES })),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const sessionId = ctx.sessionManager.getSessionId(), source = current(), runtime = source.runtime;
      if (!runtime) throw new Error("No verified Rexpi conversation");
      const agent = requireFeature(runtime, source.agent, sessionId), own = runtime.snapshot();
      if (own.state.piSessionId !== sessionId) throw new Error("Pi source conversation changed");
      const completionHandle = localAgentHandle ?? params.handle;
      const correlation = localAgentHandle ?? params;
      const details = agent.complete(completionHandle, own.state, {
        requestId: correlation.requestId, runId: correlation.runId, runtimeId: correlation.runtimeId,
        outcome: params.outcome, summary: params.summary,
        ...(params.artifacts === undefined ? {} : { artifacts: params.artifacts }),
        ...(params.error === undefined ? {} : { error: params.error }),
      });
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
  pi.registerTool({
    name: "rex_agent_result", label: "Retrieve agent result",
    description: "Read.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({ handle }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const sessionId = ctx.sessionManager.getSessionId(), source = current();
      const agent = active(sessionId), own = source.runtime!.snapshot();
      const details = await agent.result(params.handle, own.state, signal);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
  pi.registerTool({
    name: "rex_agent_cancel", label: "Cancel a selected agent run",
    description: "Abort.",
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({ handle }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const sessionId = ctx.sessionManager.getSessionId(), source = current();
      const agent = active(sessionId), own = source.runtime!.snapshot();
      const details = await agent.cancel(params.handle, own.state, signal);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
  pi.registerTool({
    name: "rex_agent_stop", label: "Stop a cooperating agent endpoint",
    description: "Stop.",
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({ handle, authorize: Type.Literal(true) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const sessionId = ctx.sessionManager.getSessionId(), source = current();
      const agent = active(sessionId), own = source.runtime!.snapshot();
      const details = await agent.stop(params.handle, own.state, { authorize: params.authorize }, signal);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
  pi.registerTool({
    name: "rex_agent_status", label: "Read agent status",
    description: "State.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({ handle }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const details = await active(ctx.sessionManager.getSessionId()).status(params.handle, signal);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
  pi.registerTool({
    name: "rex_agent_events", label: "Read agent events",
    description: "Log.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({
      handle,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_AGENT_EVENT_PAGE_SIZE })),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_AGENT_CURSOR_BYTES })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const input: { limit?: number; cursor?: string } = {};
      if (params.limit !== undefined) input.limit = params.limit;
      if (params.cursor !== undefined) input.cursor = params.cursor;
      const details = active(ctx.sessionManager.getSessionId()).events(params.handle, input);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
}
