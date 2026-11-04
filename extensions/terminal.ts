import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { configuredCommands, configuredInvocation } from "../lib/commands.ts";
import { OutcomeCache } from "../lib/outcome-cache.ts";
import { requireFeature, type Runtime } from "../lib/runtime.ts";
import { TerminalOpener, terminalText, type TerminalOptions, type TerminalResult } from "../lib/terminal.ts";
import { TERMINAL_PLACEMENTS, literalUnion } from "./schemas.ts";

const schema = Type.Object({
  command: Type.Union([
    Type.String({ minLength: 1, maxLength: 16384 }),
    Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 128 }),
  ], { description: "Prefer literal argv arrays. Strings run via /bin/sh -c." }),
  placement: Type.Optional(literalUnion(TERMINAL_PLACEMENTS, "Default right. Floating is inside this Rex tab.")),
  cwd: Type.Optional(Type.String({ description: "Existing local path; absolute, relative to cwd or ~/…" })),
  title: Type.Optional(Type.String({ maxLength: 120 })),
  focus: Type.Optional(Type.Boolean({ description: "Default true; false preserves focus." })),
  keepOpen: Type.Optional(Type.Boolean({ description: "Retain terminal after exit. Default false." })),
  bounds: Type.Optional(Type.Array(Type.Number(), { minItems: 4, maxItems: 4, description: "Floating [x,y,width,height], fractions inside tab. Default [0.1,0.1,0.8,0.8]." })),
}, { additionalProperties: false });

export interface TerminalState { runtime?: Runtime; terminal?: TerminalOpener }
export function registerTerminalFeatures(pi: ExtensionAPI, current: () => TerminalState, ctx: ExtensionContext): void {
  const calls = new OutcomeCache<TerminalResult>(4096,
    "Terminal request history is full (4096); reload explicitly before more opens");
  pi.registerTool({
    name: "rex_open_terminal", label: "Open terminal in Rex",
    description: "Run a local command in a split, tab or floating pane, with your account permissions.",
    executionMode: "sequential", parameters: schema,
    async execute(id, params, signal, _update, toolCtx) {
      const { runtime, terminal } = current();
      const result = await calls.run(id, () => {
        const opener = requireFeature(runtime, terminal, toolCtx.sessionManager.getSessionId());
        return opener.open(id, params as TerminalOptions, toolCtx.cwd, signal);
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
  } catch { ctx.ui.notify("Cannot read pi-rex.commands settings; rex_open_terminal remains available", "warning"); }
}
