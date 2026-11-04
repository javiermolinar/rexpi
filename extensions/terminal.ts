import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { configuredCommands, configuredInvocation } from "../lib/commands.ts";
import type { Runtime } from "../lib/runtime.ts";
import { TerminalOpener, terminalText, type TerminalOptions } from "../lib/terminal.ts";

const schema = Type.Object({
  command: Type.Union([
    Type.String({ minLength: 1, maxLength: 16384 }),
    Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 128 }),
  ], { description: "Shell text runs through /bin/sh -c. An executable/argument array runs directly with literal arguments; prefer arrays when shell syntax is not needed." }),
  placement: Type.Optional(Type.Union(["right", "down", "tab", "floating"].map(value => Type.Literal(value)), { description: "Defaults to a right split. Floating means a pane inside the current Rex tab, not a macOS window." })),
  cwd: Type.Optional(Type.String({ description: "Existing local directory, relative to the current Pi cwd, absolute, or ~/…" })),
  title: Type.Optional(Type.String({ maxLength: 120 })),
  focus: Type.Optional(Type.Boolean({ description: "Default true; false preserves the current focus." })),
  keepOpen: Type.Optional(Type.Boolean({ description: "Keep the terminal after its command exits; default false." })),
  bounds: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()], { description: "Floating only: [x, y, width, height] fractions fitting inside the window. Default [0.1, 0.1, 0.8, 0.8]." })),
}, { additionalProperties: false });

export interface TerminalState { runtime?: Runtime; terminal?: TerminalOpener }
export function registerTerminalFeatures(pi: ExtensionAPI, current: () => TerminalState, ctx: ExtensionContext): void {
  pi.registerTool({
    name: "rex_open_terminal", label: "Open terminal in Rex",
    description: "Open an explicitly requested terminal command in a right/lower split, tab, or floating pane in this local Rex session. Shell strings execute with /bin/sh -c; arrays execute directly. Creation does not prove command readiness, success, or completion. No remote execution, automatic retry, or implicit cleanup.",
    promptSnippet: "Run requested tools or commands in Rex splits, tabs, or floating panes",
    promptGuidelines: [
      "Use rex_open_terminal when the user asks to open a tool or run a command in a split, tab, or floating pane. Use rex_start_pi for Pi conversations instead.",
      "rex_open_terminal executes commands with the user's local account permissions; it is not a read-only viewer or sandbox. Configuration entries do not authorize agent-initiated execution.",
      "Prefer executable/argument arrays with rex_open_terminal unless shell syntax is explicitly needed. Preserve focus with focus=false when requested.",
      "If rex_open_terminal reports unknown creation, inspect Rex before any deliberate retry. Do not automatically relaunch, cancel, or clean up a possibly running command.",
    ],
    executionMode: "sequential", parameters: schema,
    async execute(id, params, signal, _update, toolCtx) {
      const { runtime, terminal } = current();
      if (!runtime || !terminal) throw new Error("No verified pi-rex conversation");
      if (runtime.snapshot().state.piSessionId !== toolCtx.sessionManager.getSessionId()) throw new Error("Pi source conversation changed");
      const result = await terminal.open(id, params as TerminalOptions, toolCtx.cwd, signal);
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
            if (!runtime || !terminal || runtime.snapshot().state.piSessionId !== commandCtx.sessionManager.getSessionId())
              throw new Error("No verified pi-rex conversation");
            const options = configuredInvocation(name, config, raw);
            const result = await terminal.open(randomUUID(), options, commandCtx.cwd);
            commandCtx.ui.notify(terminalText(result), result.creation === "confirmed" ? "info" : "warning");
          } catch (error) { commandCtx.ui.notify(error instanceof Error ? error.message : "Cannot open configured tool", "error"); }
        },
      });
    }
  } catch { ctx.ui.notify("Cannot read pi-rex.commands settings; rex_open_terminal remains available", "warning"); }
}
