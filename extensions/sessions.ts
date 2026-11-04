import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Runtime } from "../lib/runtime.ts";
import type { OpenSessionOptions, OpenSessionResult, SessionOpener } from "../lib/sessions.ts";

export function sessionText(result: OpenSessionResult): string {
  if (result.outcome === "existing") return (result.focused ? "Selected" : "Found") + " existing Rex session "
    + JSON.stringify(result.session.name) + " (" + result.session.sessionId + "). No Pi was started, no prompt was sent, and no existing tab was renamed.";
  if (result.outcome === "unknown") return result.launch.startup.reason ?? "Session creation outcome is unknown; inspect Rex before retrying.";
  return "Created Rex session " + JSON.stringify(result.name) + " (" + result.launch.target!.sessionId + ") with a fresh, empty Pi at "
    + JSON.stringify(result.directory) + ". "
    + (result.launch.startup.state === "bound" ? "Exact Pi binding observed; readiness is not confirmed. " : result.launch.startup.reason + " ")
    + (result.launch.warning ? result.launch.warning + " " : "")
    + "No restart-persistence policy was changed. /rxbk is available in this newly created Pi conversation.";
}
export function registerSessionTool(pi: ExtensionAPI, current: () => { runtime?: Runtime; sessions?: SessionOpener }): void {
  pi.registerTool({
    name: "rex_open_session", label: "Open named Rex session",
    description: "Open a reusable named Rex workspace. Select a unique existing session without starting Pi, sending prompts or changing its tabs; create a fresh empty Pi session only if absent and query specifies its directory. Names match case-insensitively; ambiguous names fail. No automatic restart restoration, task execution, retries, cleanup or existing-session renaming. App switching needs Rex Remote Control.",
    promptSnippet: "Reuse named Rex workspaces, creating an empty Pi workspace only when absent",
    promptGuidelines: [
      "Use rex_open_session for an explicit request to open a named, reusable workspace. Supply query for its creation directory (e.g. sessionName=Tempo, query=tempo); query and title are used only if absent.",
      "rex_open_session never sends a prompt or changes models in an existing session. A saved name is not permission for work; use rex_start_pi for an explicitly requested fresh conversation/task.",
      "Ambiguous names and pending/uncertain creation reservations must be inspected, not automatically removed or retried. Do not rename or close sessions to make a name available.",
      "Named Rex sessions follow Rex's own lifecycle. Do not promise that a label makes a session survive a Rex server restart.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      sessionName: Type.String({ minLength: 1, maxLength: 120, description: "Exact name for a new session (no Pi prefix). Existing names match case-insensitively; duplicates are rejected." }),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Creation only: existing path or zoxide query. Required if absent; use . for the current directory. Not resolved when reusing an existing session." })),
      title: Type.Optional(Type.String({ maxLength: 120, description: "Creation only: first tab/Pi title, independent of sessionName." })),
      focus: Type.Optional(Type.Boolean({ description: "Default true. false looks up or creates without switching the app." })),
    }, { additionalProperties: false }),
    async execute(id, params, signal, _update, ctx) {
      const { runtime, sessions } = current();
      if (!runtime || !sessions) throw new Error("No verified pi-rex conversation");
      if (runtime.snapshot().state.piSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Pi source conversation changed");
      const result = await sessions.open(id, params as OpenSessionOptions, ctx.cwd, signal);
      return { content: [{ type: "text", text: sessionText(result) }], details: result };
    },
  });
}
