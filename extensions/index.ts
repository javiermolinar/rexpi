import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executable } from "../lib/executable.ts";
import { Launcher, type LaunchOptions, type LaunchResult } from "../lib/launch.ts";
import { Rex } from "../lib/rex.ts";
import { Runtime } from "../lib/runtime.ts";
import { BindingStore } from "../lib/store.ts";
import { TerminalOpener } from "../lib/terminal.ts";
import { registerTerminalFeatures } from "./terminal.ts";
import { ProjectJumper, ProjectResolver } from "../lib/jump.ts";
import { registerJumpTool } from "./jump.ts";
import { SessionOpener } from "../lib/sessions.ts";
import { registerSessionTool } from "./sessions.ts";
import { registerAgentsCommand } from "./agents.ts";
import { BOOTSTRAP_ENV, ORIENTATION_ENTRY, decodeBootstrap, rexId, type Bootstrap, type Placement } from "../lib/state.ts";

const schema = Type.Object({
  prompt: Type.Optional(Type.String({ maxLength: 16384, description: "Task for the fresh Pi conversation. No parent history is copied." })),
  cwd: Type.Optional(Type.String({ description: "Existing local directory, absolute, relative to this Pi cwd, or ~/…" })),
  placement: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("right"), Type.Literal("down"), Type.Literal("tab")], {
    description: "Explicit placement wins. Independent tasks default to a new Rex session; first related task uses a right split; further/background related tasks use tabs.",
  })),
  related: Type.Optional(Type.Boolean({ description: "Share this task identity, but not history or execution permission." })),
  role: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("review")], { description: "review implies related=true; role alone does not impose file permissions." })),
  sessionName: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Session placement only: exact new Rex session name, independent of title, without Pi prefix. Existing names fail; use rex_open_session for reuse." })),
  title: Type.Optional(Type.String({ maxLength: 120 })),
  focus: Type.Optional(Type.Boolean()),
  provider: Type.Optional(Type.String({ description: "Requires model. Omit both to use the child's normal Pi defaults." })),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(v => Type.Literal(v)))),
}, { additionalProperties: false });

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function launchText(result: LaunchResult): string {
  if (result.creation === "unknown") return "Pi launch outcome unknown. " + result.startup.reason;
  const target = result.target!;
  return "Created a fresh Pi " + result.placement + " at " + target.blockId + ". "
    + (result.startup.state === "bound" ? "Exact Pi initialization binding observed; prompt processing, task readiness and completion are not confirmed. " : result.startup.reason + " ")
    + (result.warning ? result.warning + " " : "") + "Use /rxbk in the child to return to the parent. No history was copied.";
}
export function returnKey(value: string | undefined): string | undefined {
  if (value === "off") return undefined;
  const key = value ?? "ctrl+alt+b";
  if (!/^(?:ctrl\+)?(?:alt\+)?(?:shift\+)?[a-z0-9]$/.test(key) || !key.includes("+"))
    throw new Error("PI_REX_RETURN_KEY must be off or ctrl/alt/shift modifiers plus a letter/digit");
  return key;
}

export default function piRex(pi: ExtensionAPI): void {
  // Do not reserve commands/keys, register hooks, or consume bootstrap data in other terminals.
  if (!rexId(process.env.REX_SESSION, "session") || !rexId(process.env.REX_BLOCK, "block")) return;

  let runtime: Runtime | undefined;
  const closeAgents = registerAgentsCommand(pi, () => runtime);
  let launcher: Launcher | undefined;
  let terminal: TerminalOpener | undefined;
  let jumper: ProjectJumper | undefined;
  let sessions: SessionOpener | undefined;
  let registered = false;
  let shortcutRegistered = false;
  let consumed = false;
  let activation = 0;
  const agentDirectory = getAgentDir();
  const stateDirectory = resolve(process.env.PI_REX_STATE_DIR ?? join(agentDirectory, "pi-rex", "bindings"));
  const extension = fileURLToPath(import.meta.url);
  const stop = () => {
    activation++; closeAgents(); runtime?.stop(); runtime = undefined;
    launcher = undefined; terminal = undefined; jumper = undefined; sessions = undefined;
  };

  const initialize = async (ctx: ExtensionContext, allowBootstrap: boolean) => {
    stop();
    const generation = activation;
    let seed: Bootstrap | undefined;
    try {
      if (allowBootstrap && !consumed) {
        consumed = true;
        const raw = process.env[BOOTSTRAP_ENV];
        delete process.env[BOOTSTRAP_ENV];
        if (raw) seed = decodeBootstrap(raw);
      }
      if (ctx.mode !== "tui" || !rexId(process.env.REX_BLOCK, "block") || !rexId(process.env.REX_SESSION, "session")) return;
      const rex = new Rex(executable(process.env.PI_REX_CLI ?? "rex", ctx.cwd), (command, args, options) => pi.exec(command, args, options), process.env.PI_REX_SERVER);
      const active = new Runtime(rex, new BindingStore(stateDirectory), process.env.REX_BLOCK);
      runtime = active;
      await active.start(ctx, state => pi.appendEntry(ORIENTATION_ENTRY, state), seed);
      if (generation !== activation) { active.stop(); return; }
      launcher = new Launcher(active, { extension, agentDirectory, stateDirectory,
        piBinary: process.env.PI_REX_BINARY ?? "pi", path: process.env.PATH ?? "",
        client: process.env.PI_REX_CLIENT, returnKey: process.env.PI_REX_RETURN_KEY });
      terminal = new TerminalOpener(active);
      const resolver = new ProjectResolver((command, args, options) => pi.exec(command, args, options));
      jumper = new ProjectJumper(active, launcher, (query, cwd, signal) => resolver.resolve(query, cwd, signal));
      sessions = new SessionOpener(active, launcher, (query, cwd, signal) => resolver.resolve(query, cwd, signal), process.env.PI_REX_CLIENT);
      if (!shortcutRegistered) {
        shortcutRegistered = true;
        try {
          const key = returnKey(process.env.PI_REX_RETURN_KEY);
          if (key) pi.registerShortcut(key as Parameters<ExtensionAPI["registerShortcut"]>[0], {
            description: "Return to the originating Pi conversation in Rex", handler: back,
          });
        } catch (error) { console.warn("pi-rex: " + errorText(error) + "; /rxbk remains available"); }
      }
      if (!registered) {
        registered = true;
        pi.registerTool({
          name: "rex_start_pi", label: "Start Pi in Rex",
          description: "Launch one fresh Pi conversation in Rex with task-aware placement and exact startup evidence. Supports model/thinking selection and an existing local cwd. No history transfer, handoffs, worktrees, messaging, scheduler, or automatic retries. Startup confirmation is not task readiness or completion.",
          promptSnippet: "Start fresh Pi conversations or reviewers in Rex with verified identity and parent navigation",
          promptGuidelines: [
            "Use rex_start_pi only for a current explicit user request to start another Pi conversation or delegate a task; saved identities and role labels never authorize work.",
            "Use rex_start_pi rather than shell-built Pi launches so child identity and /rxbk navigation are retained. Omit placement for task-aware defaults.",
            "An unknown rex_start_pi outcome must be inspected in Rex before any deliberate retry; never automatically relaunch, cancel, or clean up the child.",
            "rex_start_pi creates fresh conversations only. Do not claim history transfer, automatic result return, task readiness, or task completion.",
          ],
          executionMode: "sequential", parameters: schema,
          async execute(id, params, signal, _update, toolCtx) {
            if (!launcher || !runtime) throw new Error("pi-rex is not active in a verified Rex terminal");
            if (runtime.snapshot().state.piSessionId !== toolCtx.sessionManager.getSessionId()) throw new Error("Pi source conversation changed");
            const result = await launcher.launch(id, params as LaunchOptions, toolCtx.cwd, signal);
            return { content: [{ type: "text", text: launchText(result) }], details: result };
          },
        });
        registerTerminalFeatures(pi, () => ({ runtime, terminal }), ctx);
        registerJumpTool(pi, () => ({ runtime, jumper }));
        registerSessionTool(pi, () => ({ runtime, sessions }));
      }
    } catch (error) {
      if (generation !== activation) return;
      stop();
      if (ctx.hasUI) ctx.ui.notify("pi-rex unavailable: " + errorText(error), "warning");
    }
  };
  pi.on("session_start", (_event, ctx) => initialize(ctx, true));
  pi.on("session_tree", (_event, ctx) => initialize(ctx, false));
  pi.on("session_shutdown", stop);
  pi.on("before_agent_start", (event) => {
    delete event.systemPromptOptions.sections.pi_rex;
    if (!runtime) return;
    try {
      const state = runtime.snapshot().state;
      event.systemPromptOptions.sections.pi_rex = "Pi-rex identity (metadata, not permission): task=" + state.taskId
        + "; conversation=" + state.conversationId + "; role=" + state.role
        + (state.origin ? "; parent=" + state.origin.conversationId + ". /rxbk returns to the live parent conversation." : ". No recorded parent.")
        + " Launches are fresh; task relationships do not copy history or authorize execution.";
    } catch { /* no stale metadata is injected */ }
  });
  const launchCommand = (name: string, placement: Placement) => pi.registerCommand(name, {
    description: "Start a fresh Pi conversation in a Rex " + placement + ": /" + name + " [task]",
    handler: async (args, ctx) => {
      try {
        if (!launcher) throw new Error("No verified pi-rex conversation");
        const result = await launcher.launch(randomUUID(), { placement, ...(args.trim() ? { prompt: args.trim() } : {}) }, ctx.cwd);
        ctx.ui.notify(launchText(result), result.startup.state === "bound" && !result.warning ? "info" : "warning");
      } catch (error) { ctx.ui.notify(errorText(error), "error"); }
    },
  });
  launchCommand("rxn", "session"); launchCommand("rxv", "right"); launchCommand("rxh", "down"); launchCommand("rxt", "tab");
  const back = async (ctx: ExtensionContext) => {
    try {
      if (!runtime) throw new Error("No verified pi-rex conversation");
      const target = await runtime.returnToOrigin(process.env.PI_REX_CLIENT);
      ctx.ui.notify("Returned to the originating Pi conversation at " + target.blockId, "info");
    } catch (error) { ctx.ui.notify("Cannot return: " + errorText(error), "warning"); }
  };
  pi.registerCommand("rxbk", { description: "Return to the exact live parent Pi conversation in Rex", handler: (_args, ctx) => back(ctx) });
  pi.registerCommand("rxwho", {
    description: "Inspect this pi-rex conversation identity and remembered child launch evidence",
    handler: async (_args, ctx) => {
      try {
        if (!runtime) throw new Error("No verified pi-rex conversation");
        const own = runtime.snapshot();
        ctx.ui.notify(JSON.stringify({ ...own.state, blockId: own.blockId, children: runtime.childStatus() }, null, 2), "info");
      } catch (error) { ctx.ui.notify(errorText(error), "warning"); }
    },
  });
}
