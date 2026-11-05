import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentText } from "../lib/agents.ts";
import type { Launcher } from "../lib/launch.ts";
import { WorktreeBrowser, WorktreeRemovalError } from "../lib/worktrees.ts";
import { WorktreeResultsOverlay, removalCount, type WorktreeRemovalReport } from "../lib/worktree-results-overlay.ts";
import { WorktreeConfirmationOverlay } from "../lib/worktree-review-overlay.ts";
import { launchText } from "./launch.ts";
import { pickerStyle } from "../lib/picker-overlay.ts";
import { WorktreesOverlay, type WorktreeAction } from "../lib/worktrees-overlay.ts";
import type { Runtime } from "../lib/runtime.ts";

/** Register once inside Rex. Reads and refresh timers exist only while open. */
export function registerWorktreesCommand(pi: ExtensionAPI, current: () => { runtime?: Runtime; launcher?: Launcher }): {
  cancel: () => void; open: (ctx: ExtensionContext) => Promise<void>;
} {
  let active: { controller: AbortController; close?: () => void } | undefined;
  const cancel = () => { active?.controller.abort(); active?.close?.(); };
  const open = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") { ctx.ui.notify("/rxw requires interactive Pi in Rex", "warning"); return; }
    if (active) return;
    const { runtime, launcher } = current();
    if (!runtime || !launcher) { ctx.ui.notify("No verified Rexpi conversation", "warning"); return; }
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
      const browser = new WorktreeBrowser(runtime, launcher, (command, args, options) => pi.exec(command, args, options), ctx.cwd);
      const result = await ctx.ui.custom<WorktreeAction | undefined>((tui, theme, keybindings, done) => {
        let closed = false;
        const finish = (row: WorktreeAction | undefined) => {
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
              timer = setTimeout(refresh, 5000);
              timer.unref();
            }
          });
        };
        const overlay = new WorktreesOverlay({ style: pickerStyle(theme), keybindings,
          terminalRows: () => tui.terminal.rows, requestRender: () => tui.requestRender(), refresh, done: finish });
        run.close = () => finish(undefined);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) finish(undefined); else refresh();
        return overlay;
      }, { overlay: true, overlayOptions: { width: 72, maxHeight: "70%", anchor: "center", margin: 1 } });
      if (!result || signal.aborted || current().runtime !== runtime) return;
      runtime.assert(own);
      // Finish the picker and its read before confirmation or any native effect.
      await pending;
      const verify = () => {
        runtime.assert(own); signal.throwIfAborted();
        if (current().runtime !== runtime || ctx.sessionManager.getSessionId() !== own.state.piSessionId)
          throw new Error("Pi source conversation changed");
      };
      verify();
      if (result.kind === "remove") {
        const protectedRow = result.rows.find(row => row.deletionIssue);
        if (protectedRow) throw new Error("Cannot remove: " + protectedRow.deletionIssue);
        const total = result.rows.length;
        const confirmed = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
          let closed = false;
          const finish = (accepted = false) => {
            if (closed) return;
            closed = true; signal.removeEventListener("abort", onAbort); done(accepted);
          };
          const onAbort = () => finish();
          const overlay = new WorktreeConfirmationOverlay(result.rows, { style: pickerStyle(theme), keybindings,
            terminalRows: () => tui.terminal.rows, requestRender: () => tui.requestRender(), done: finish });
          run.close = onAbort;
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) finish();
          return overlay;
        }, { overlay: true, overlayOptions: { width: 80, maxHeight: "70%", anchor: "center", margin: 1 } });
        if (!confirmed) {
          if (!signal.aborted && current().runtime === runtime) ctx.ui.notify("Deletion cancelled; no worktrees removed", "info");
          return;
        }
        const report: WorktreeRemovalReport = { results: result.rows.map(row => ({
          key: row.key, row, outcome: "not-attempted", message: "Stopped before this worktree was processed",
        })) };
        let index = -1;
        try {
          verify();
          await browser.checkRemoval(result.rows, signal);
          for (index = 0; index < result.rows.length; index++) {
            const row = result.rows[index];
            verify();
            await browser.remove(row, signal);
            report.results[index].outcome = row.state === "missing" ? "cleaned" : "removed";
            report.results[index].message = row.state === "missing" ? "Git registration removed (verified)" : "Directory and Git registration removed (verified)";
          }
        } catch (error) {
          report.error = error instanceof Error ? error.message : String(error);
          const stopped = index >= 0 ? index : error instanceof WorktreeRemovalError
            ? report.results.findIndex(result => result.row.path === error.path) : -1;
          if (stopped >= 0 && stopped < total) {
            report.results[stopped].outcome = error instanceof WorktreeRemovalError ? error.outcome : "blocked";
            report.results[stopped].message = report.error;
          } else for (const result of report.results) result.message = "Preflight failed: " + report.error;
        }
        // The result screen remains until acknowledged. Never reopen it in a
        // replacement conversation or give it retry/delete actions.
        if (signal.aborted || current().runtime !== runtime || ctx.sessionManager.getSessionId() !== own.state.piSessionId) return;
        const removed = removalCount(report), registrations = report.results.filter(result => result.outcome === "cleaned").length;
        ctx.ui.notify(report.error ? `Removed ${removed}/${total}. ${agentText(report.error)}. No further worktrees attempted.`
          : `Removed ${removed} worktree${removed === 1 ? "" : "s"}`
            + (registrations ? ` (${registrations} missing registration${registrations === 1 ? "" : "s"})` : "") + "; branches retained",
          report.error ? "warning" : "info");
        await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true; signal.removeEventListener("abort", close); done();
          };
          const overlay = new WorktreeResultsOverlay(report, { style: pickerStyle(theme), keybindings,
            terminalRows: () => tui.terminal.rows, requestRender: () => tui.requestRender(), done: close });
          run.close = close;
          signal.addEventListener("abort", close, { once: true });
          if (signal.aborted) close();
          return overlay;
        }, { overlay: true, overlayOptions: { width: 80, maxHeight: "70%", anchor: "center", margin: 1 } });
      } else {
        const launch = await browser.open(randomUUID(), result.row, signal);
        ctx.ui.notify(launchText(launch),
          launch.creation === "confirmed" && launch.startup.state === "bound" ? "info" : "warning");
      }
    } catch (error) {
      if (!run.controller.signal.aborted && current().runtime === runtime)
        ctx.ui.notify("Worktrees: " + agentText(error instanceof Error ? error.message : error, "Navigation unavailable"), "warning");
    } finally {
      if (timer) clearTimeout(timer);
      reads.abort();
      run.close?.();
      await pending;
      if (active === run) active = undefined;
    }
  };
  for (const name of ["rxw", "rxworktrees"]) pi.registerCommand(name, {
    description: name === "rxw" ? "Browse Git worktrees: open fresh Pi tabs or safely remove a worktree" : "Alias for /rxw",
    handler: (_args, ctx) => open(ctx),
  });
  return { cancel, open };
}
