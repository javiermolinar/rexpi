import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requireFeature, type Runtime } from "../lib/runtime.ts";
import type { OpenSessionOptions, OpenSessionResult, SessionOpener } from "../lib/sessions.ts";
import { OutcomeCache } from "../lib/outcome-cache.ts";

export function sessionText(result: OpenSessionResult): string {
  if (result.outcome === "existing") return (result.focused ? "Selected" : "Found") + " existing Rex session "
    + JSON.stringify(result.session.name) + " (" + result.session.sessionId + "). No Pi was started, no prompt was sent, and no existing tab was renamed.";
  if (result.outcome === "unknown") return result.launch.startup.reason ?? "Session creation outcome is unknown; inspect Rex before retrying.";
  return "Created Rex session " + JSON.stringify(result.name) + " (" + result.launch.target!.sessionId + ") with a fresh, empty Pi at "
    + JSON.stringify(result.directory) + ". "
    + (result.launch.startup.state === "bound" ? "Exact Pi binding observed; readiness is not confirmed. " : result.launch.startup.reason + " ")
    + (result.launch.warning ? result.launch.warning + " " : "")
    + "No restart-persistence policy was changed. Exact-parent navigation is available in this newly created Pi conversation.";
}
export function registerSessionTool(pi: ExtensionAPI, current: () => { runtime?: Runtime; sessions?: SessionOpener }): void {
  const calls = new OutcomeCache<OpenSessionResult>(256,
    "Session request history is full; reload explicitly before more requests");
  pi.registerTool({
    name: "rex_open_session", label: "Open named Rex session",
    description: "Select a unique named workspace, or create empty Pi if absent. Ambiguous names fail. App switching needs Rex Remote Control; no restart restoration.",
    executionMode: "sequential",
    parameters: Type.Object({
      sessionName: Type.String({ minLength: 1, maxLength: 120, description: "Exact workspace name; case-insensitive matching." }),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Required if absent: path or zoxide query; . means cwd. Ignored on reuse." })),
      title: Type.Optional(Type.String({ maxLength: 120, description: "Initial tab title; ignored on reuse." })),
      focus: Type.Optional(Type.Boolean({ description: "Default true; false preserves focus." })),
    }, { additionalProperties: false }),
    async execute(id, params, signal, _update, ctx) {
      const { runtime, sessions } = current();
      const result = await calls.run(id, () => {
        const opener = requireFeature(runtime, sessions, ctx.sessionManager.getSessionId());
        return opener.open(id, params as OpenSessionOptions, ctx.cwd, signal);
      });
      return { content: [{ type: "text", text: sessionText(result) }], details: result };
    },
  });
}
