import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProjectJumper, JumpOptions, JumpResult } from "../lib/jump.ts";
import { OutcomeCache } from "../lib/outcome-cache.ts";
import { requireFeature, type Runtime } from "../lib/runtime.ts";
import { LAUNCH_ROLES, THINKING, literalUnion } from "./schemas.ts";

const schema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 4096, description: "Existing path or best-ranked zoxide keywords. Missing explicit paths fail." }),
  prompt: Type.Optional(Type.String({ maxLength: 16384, description: "Task only if also delegated; otherwise omit." })),
  title: Type.Optional(Type.String({ maxLength: 120 })),
  focus: Type.Optional(Type.Boolean({ description: "Default true; false preserves focus." })),
  related: Type.Optional(Type.Boolean({ description: "Share task identity. Default false." })),
  role: Type.Optional(literalUnion(LAUNCH_ROLES)),
  provider: Type.Optional(Type.String({ description: "Requires model; omit both for child's defaults." })),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(literalUnion(THINKING)),
}, { additionalProperties: false });

export function jumpText(result: JumpResult): string {
  const heading = "Resolved " + JSON.stringify(result.directory) + " via " + result.matchedBy + ". ";
  if (result.launch.creation === "unknown") return heading + result.launch.startup.reason;
  return heading + "Created a fresh Pi tab at " + result.launch.target!.blockId + ". "
    + (result.launch.startup.state === "bound" ? "Exact child Pi binding observed; task readiness and completion are not confirmed. " : result.launch.startup.reason + " ")
    + "The source conversation is unchanged. Ask to return to the parent in the new tab; no history was copied.";
}
export function registerJumpTool(pi: ExtensionAPI, current: () => { runtime?: Runtime; jumper?: ProjectJumper }): void {
  const calls = new OutcomeCache<JumpResult>(256, "Jump request history is full; reload explicitly before more jumps");
  pi.registerTool({
    name: "rex_jump", label: "Open project in a Rex tab",
    description: "Open a project path or zoxide match in a fresh Pi tab; source cwd unchanged.",
    executionMode: "sequential", parameters: schema,
    async execute(id, params, signal, _update, ctx) {
      const { runtime, jumper } = current();
      const result = await calls.run(id, () => {
        const opener = requireFeature(runtime, jumper, ctx.sessionManager.getSessionId());
        return opener.jump(id, params as JumpOptions, ctx.cwd, signal);
      });
      return { content: [{ type: "text", text: jumpText(result) }], details: result };
    },
  });
}
