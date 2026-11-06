import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CapabilityRuntime } from "../lib/capability-runtime.ts";
import type { FanoutExecution, FanoutRegistry, FanoutRuntime } from "../lib/fanout.ts";
import type { JoinRuntime } from "../lib/join.ts";
import type { MessagingRuntime } from "../lib/messaging/runtime.ts";
import { requireFeature, type Runtime } from "../lib/runtime.ts";
import type { Identity } from "../lib/state.ts";
import { capabilityGrant } from "./grants.ts";

export interface FanoutToolState {
  runtime?: Runtime;
  fanout?: FanoutRuntime;
  join?: JoinRuntime;
  registry?: FanoutRegistry;
  messaging?: MessagingRuntime;
  capability?: CapabilityRuntime;
}
const child = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" }),
  task: Type.String({ minLength: 1, maxLength: 16384 }), grant: capabilityGrant,
  notifyParentOnSettlement: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
function origin(execution: FanoutExecution, runtime?: Runtime): Identity {
  if (runtime) return runtime.snapshot().state;
  for (const child of execution.snapshot().children)
    if (child.delegation) return child.delegation.launch.origin;
  throw new Error("Original fan-out source evidence is unavailable");
}
export function registerFanoutTools(pi: ExtensionAPI, current: () => FanoutToolState): void {
  pi.registerTool({
    name: "rexpi_fanout", label: "Delegate bounded child tasks",
    description: "Launch a bounded batch of supervised subagents with per-child tasks and grants.",
    executionMode: "sequential",
    parameters: Type.Object({
      children: Type.Array(child, { minItems: 1, maxItems: 64 }),
      concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }, { additionalProperties: false }),
    async execute(id, params, signal, _update, ctx) {
      const source = current(), registry = source.registry, join = source.join;
      if (!registry || !join) throw new Error("Fan-out evidence is unavailable");
      const concurrency = params.concurrency ?? 2, inputs = params.children.map(child => ({
        id: child.id, task: child.task, options: { grant: child.grant,
          ...(child.notifyParentOnSettlement === undefined ? {}
            : { notifyParentOnSettlement: child.notifyParentOnSettlement }) },
      }));
      let execution = registry.match(id, inputs, { concurrency, cwd: ctx.cwd });
      if (!execution) {
        const runtime = source.runtime, fanout = source.fanout;
        if (!runtime || !fanout) throw new Error("Rexpi fan-out is not active in a verified Rex terminal");
        if (runtime.snapshot().state.piSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Pi source conversation changed");
        requireFeature(runtime, fanout, ctx.sessionManager.getSessionId());
        const admitted = inputs.map(child => ({ ...child, options: { ...child.options,
          grant: source.capability ? source.capability.deriveChildGrant(child.options.grant) : child.options.grant } }));
        source.messaging?.observeRun(ctx);
        execution = fanout.start(id, admitted, { concurrency, cwd: ctx.cwd,
          ...(source.capability || signal ? { signal: source.capability?.toolSignal(signal) ?? signal } : {}) }, inputs);
      }
      const details = await join.join(execution, origin(execution, source.runtime), signal);
      return { content: [{ type: "text", text: `Fan-out ${id}: ${details.state}; ${details.children.length} child outcomes.` }],
        details: { fanoutId: id, ...details } };
    },
  });
  pi.registerTool({
    name: "rexpi_join", label: "Inspect fan-out outcomes",
    description: "Read preserved outcomes for one fan-out without launching work.",
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({ fanoutId: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const source = current();
      if (!source.registry || !source.join) throw new Error("Join evidence is unavailable");
      const execution = source.registry.get(params.fanoutId);
      const own = source.runtime;
      if (own && own.snapshot().state.piSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Pi source conversation changed");
      const details = await source.join.join(execution, origin(execution, own), signal);
      return { content: [{ type: "text", text: `Join ${params.fanoutId}: ${details.state}; ${details.children.length} child outcomes.` }],
        details: { fanoutId: params.fanoutId, ...details } };
    },
  });
}
