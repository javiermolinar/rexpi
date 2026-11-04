import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentBrowser, agentText, type AgentRow } from "../lib/agents.ts";
import { AgentsOverlay, agentsStyle } from "../lib/agents-overlay.ts";
import type { Runtime } from "../lib/runtime.ts";

/** Register once inside Rex. Reads and refresh timers exist only while open. */
export function registerAgentsCommand(pi: ExtensionAPI, getRuntime: () => Runtime | undefined): () => void {
  let active: { controller: AbortController; close?: () => void } | undefined;
  const cancel = () => { active?.controller.abort(); active?.close?.(); };
  pi.registerCommand("rxagents", {
    description: "Show agents in every Rex split/tab: filter statuses and jump to a live pane",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/rxagents requires interactive Pi in Rex", "warning"); return; }
      if (active) return;
      const runtime = getRuntime();
      if (!runtime) { ctx.ui.notify("No verified pi-rex conversation", "warning"); return; }
      const run = { controller: new AbortController(), close: undefined as (() => void) | undefined };
      active = run;
      const reads = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pending: Promise<void> | undefined;
      try {
        const own = runtime.snapshot();
        if (own.state.piSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Pi source conversation changed");
        const signal = AbortSignal.any([own.signal, run.controller.signal]);
        const readSignal = AbortSignal.any([signal, reads.signal]);
        const browser = new AgentBrowser(runtime, process.env.PI_REX_CLIENT);
        const result = await ctx.ui.custom<AgentRow | undefined>((tui, theme, keybindings, done) => {
          let closed = false;
          const finish = (row: AgentRow | undefined) => {
            if (closed) return;
            closed = true;
            if (timer) clearTimeout(timer);
            reads.abort();
            signal.removeEventListener("abort", onAbort);
            done(row);
          };
          const onAbort = () => finish(undefined);
          const refresh = () => {
            if (closed || readSignal.aborted || pending) return;
            if (timer) clearTimeout(timer);
            pending = browser.list(readSignal).then(result => {
              if (!closed && !readSignal.aborted) overlay.setList(result);
            }, error => {
              if (!closed && !readSignal.aborted) overlay.setError(error);
            }).finally(() => {
              pending = undefined;
              if (!closed && !readSignal.aborted) {
                timer = setTimeout(refresh, 2000);
                timer.unref();
              }
            });
          };
          const overlay = new AgentsOverlay({ style: agentsStyle(theme), keybindings,
            terminalRows: () => tui.terminal.rows, requestRender: () => tui.requestRender(), refresh, done: finish });
          run.close = () => finish(undefined);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) finish(undefined); else refresh();
          return overlay;
        }, { overlay: true, overlayOptions: { width: 72, maxHeight: "70%", anchor: "center", margin: 1 } });
        if (!result || signal.aborted || getRuntime() !== runtime) return;
        runtime.assert(own);
        await browser.focus(result, signal);
      } catch (error) {
        if (!run.controller.signal.aborted && getRuntime() === runtime)
          ctx.ui.notify("Agents: " + agentText(error instanceof Error ? error.message : error, "Navigation unavailable"), "warning");
      } finally {
        if (timer) clearTimeout(timer);
        reads.abort();
        run.close?.();
        await pending;
        if (active === run) active = undefined;
      }
    },
  });
  return cancel;
}
