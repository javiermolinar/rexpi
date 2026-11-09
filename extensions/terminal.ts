import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { configuredCommands, configuredInvocation } from "../lib/commands.ts";
import { OutcomeCache } from "../lib/outcome-cache.ts";
import { normalizeHostAlias } from "../lib/hosts.ts";
import type { HostSelection } from "../lib/host-selection.ts";
import type { RemoteTerminalOpener } from "../lib/remote-terminal.ts";
import { requireFeature, type Runtime } from "../lib/runtime.ts";
import { TerminalOpener, terminalText, type TerminalOptions, type TerminalResult } from "../lib/terminal.ts";
import { TERMINAL_PLACEMENTS, literalUnion } from "./schemas.ts";

const schema = Type.Object({
  command: Type.Union([
    Type.String({ minLength: 1, maxLength: 16384 }),
    Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 128 }),
  ], { description: "Literal argv preferred; strings use /bin/sh -c." }),
  placement: Type.Optional(literalUnion(["session", ...TERMINAL_PLACEMENTS] as const,
    "Default right. session=new workspace; floating uses the anchored tab.")),
  cwd: Type.Optional(Type.String({ description: "Existing working directory; absolute or relative." })),
  title: Type.Optional(Type.String({ maxLength: 120 })),
  focus: Type.Optional(Type.Boolean({ description: "Focus pane; default true." })),
  keepOpen: Type.Optional(Type.Boolean({ description: "Keep pane after exit; default false." })),
  bounds: Type.Optional(Type.Array(Type.Number(), { minItems: 4, maxItems: 4, description: "Floating [x,y,width,height] tab fractions; default [0.1,0.1,0.8,0.8]." })),
  host: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
}, { additionalProperties: false });

export interface TerminalState {
  runtime?: Runtime;
  terminal?: TerminalOpener;
  remoteTerminal?: RemoteTerminalOpener;
  hostSelection?: HostSelection;
}
export function registerTerminalFeatures(pi: ExtensionAPI, current: () => TerminalState, ctx: ExtensionContext): void {
  const calls = new OutcomeCache<TerminalResult>(4096,
    "Terminal request history is full (4096); reload explicitly before more opens");
  pi.registerTool({
    name: "rexpi_open_terminal", label: "Open terminal in Rex",
    description: "Open a terminal on the selected or named Rex host.",
    executionMode: "sequential", parameters: schema,
    async execute(id, params, signal, _update, toolCtx) {
      // Capture this incarnation before the outcome fence: tree replacement must not retarget an old ID.
      const { runtime, terminal, remoteTerminal, hostSelection } = current();
      const result = await calls.run(id, () => {
        const opener = requireFeature(runtime, terminal, toolCtx.sessionManager.getSessionId());
        const requested = params as TerminalOptions & { host?: string };
        const host = requested.host === undefined ? undefined : normalizeHostAlias(requested.host);
        const selected = hostSelection?.snapshot();
        if (host === "local" || (host === undefined && selected?.kind !== "remote"))
          return opener.open(id, requested, toolCtx.cwd, signal);
        if (!remoteTerminal || !hostSelection)
          throw new Error("Remote terminal execution is unavailable; no local fallback was attempted");
        // Remote cwd and PATH deliberately do not come from toolCtx.cwd or this Mac's environment.
        return remoteTerminal.open(id, requested, host, signal);
      });
      return { content: [{ type: "text", text: terminalText(result) }], details: result };
    },
  });
  try {
    const commands = configuredCommands(pi.getSettings(), pi.getCommands().map(command => command.name),
      message => ctx.ui.notify(message, "warning"));
    for (const [name, config] of commands) {
      pi.registerCommand(name, {
        description: config.description,
        handler: async (raw, commandCtx) => {
          try {
            const { runtime, terminal } = current();
            const opener = requireFeature(runtime, terminal, commandCtx.sessionManager.getSessionId());
            const options = configuredInvocation(name, config, raw);
            const result = await opener.open(randomUUID(), options, commandCtx.cwd);
            commandCtx.ui.notify(terminalText(result), result.creation === "confirmed" ? "info" : "warning");
          } catch (error) { commandCtx.ui.notify(error instanceof Error ? error.message : "Cannot open configured tool", "error"); }
        },
      });
    }
  } catch { ctx.ui.notify("Cannot read pi-rex.commands settings; rexpi_open_terminal remains available", "warning"); }
}
