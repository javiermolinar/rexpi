import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProjectJumper, JumpOptions, JumpResult } from "../lib/jump.ts";
import type { Runtime } from "../lib/runtime.ts";

const schema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 4096, description: "An existing local directory (absolute, relative or ~/…), or zoxide keywords such as tempo or grafana tempo. Existing paths take priority; fuzzy queries use zoxide's best-ranked result." }),
  prompt: Type.Optional(Type.String({ maxLength: 16384, description: "Optional explicitly requested initial task for the fresh Pi conversation. Omit when only opening a project." })),
  title: Type.Optional(Type.String({ maxLength: 120 })),
  focus: Type.Optional(Type.Boolean({ description: "Default true; false opens the new tab without taking focus." })),
  related: Type.Optional(Type.Boolean({ description: "Default false; share the task identity only when the user requested related work." })),
  role: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("review")])),
  provider: Type.Optional(Type.String({ description: "Requires model; omit both for the child's normal Pi defaults." })),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => Type.Literal(value)))),
}, { additionalProperties: false });

export function jumpText(result: JumpResult): string {
  const heading = "Resolved " + JSON.stringify(result.directory) + " via " + result.matchedBy + ". ";
  if (result.launch.creation === "unknown") return heading + result.launch.startup.reason;
  return heading + "Created a fresh Pi tab at " + result.launch.target!.blockId + ". "
    + (result.launch.startup.state === "bound" ? "Exact child Pi binding observed; task readiness and completion are not confirmed. " : result.launch.startup.reason + " ")
    + "The source conversation is unchanged. Use /rxbk in the new tab to return; no history was copied.";
}
export function registerJumpTool(pi: ExtensionAPI, current: () => { runtime?: Runtime; jumper?: ProjectJumper }): void {
  pi.registerTool({
    name: "rex_jump", label: "Open project in a Rex tab",
    description: "Resolve an existing local directory or zoxide query and open one fresh Pi conversation there in a new Rex tab. Existing paths need no zoxide; missing explicit paths fail without fuzzy fallback. Optional initial task, model/thinking and focus. Reuses verified Pi launching and parent navigation. No current-cwd change, history transfer, automatic retries, remote execution, or zoxide database updates.",
    promptSnippet: "Open projects by path or zoxide keywords in fresh Pi tabs",
    promptGuidelines: [
      "Use rex_jump for a current explicit request such as 'open Tempo in a new tab'. It creates a fresh Pi conversation, not a shell-only tab or an in-place directory change.",
      "Pass a prompt to rex_jump only when the user also delegated a task; opening a project alone needs no initial model prompt.",
      "rex_jump reports the resolved directory and startup evidence. A zoxide match or live binding is not execution permission, task readiness or completion.",
      "Never automatically retry an unknown rex_jump creation outcome; inspect Rex first. No history or automatic result return is provided.",
    ],
    executionMode: "sequential", parameters: schema,
    async execute(id, params, signal, _update, ctx) {
      const { runtime, jumper } = current();
      if (!runtime || !jumper) throw new Error("No verified pi-rex conversation");
      if (runtime.snapshot().state.piSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Pi source conversation changed");
      const result = await jumper.jump(id, params as JumpOptions, ctx.cwd, signal);
      return { content: [{ type: "text", text: jumpText(result) }], details: result };
    },
  });
}
