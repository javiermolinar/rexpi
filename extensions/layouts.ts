import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureActiveLayout } from "../lib/layout-capture.ts";
import { LayoutOpener, layoutOpenText, type LayoutOpenResult } from "../lib/layout-open.ts";
import type { LayoutStore } from "../lib/layout-store.ts";
import { LayoutsOverlay } from "../lib/layouts-overlay.ts";
import { parseLayoutName, type Layout } from "../lib/layouts.ts";
import { OutcomeCache } from "../lib/outcome-cache.ts";
import { pickerStyle } from "../lib/picker-overlay.ts";
import type { Runtime } from "../lib/runtime.ts";

export interface LayoutState { runtime?: Runtime; store?: LayoutStore; opener?: LayoutOpener }
export type LayoutCommand = { kind: "picker" } | { kind: "open"; name: string } |
  { kind: "preview"; name: string } | { kind: "save"; name: string; overwrite: boolean };
const usage = "Usage: /rxl [NAME | save NAME [--overwrite] | preview NAME/current]";
export function parseLayoutCommand(args: string): LayoutCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { kind: "picker" };
  if (tokens[0] === "save") {
    if ((tokens.length !== 2 && tokens.length !== 3) || (tokens.length === 3 && tokens[2] !== "--overwrite")) throw new Error(usage);
    return { kind: "save", name: parseLayoutName(tokens[1]), overwrite: tokens.length === 3 };
  }
  if (tokens[0] === "preview") {
    if (tokens.length !== 2) throw new Error(usage);
    return { kind: "preview", name: parseLayoutName(tokens[1]) };
  }
  if (tokens.length !== 1) throw new Error(usage);
  return { kind: "open", name: parseLayoutName(tokens[0]) };
}

/** Register once; all callbacks retain their source runtime, never acquire a replacement. */
export function registerLayoutsCommand(pi: ExtensionAPI, current: () => LayoutState, restricted: () => boolean = () => false) {
  let active: { controller: AbortController; close?: () => void } | undefined;
  // Extension-lifetime evidence fences, independent of replaceable materializers.
  const outcomes = new OutcomeCache<LayoutOpenResult>(1024, "Layout outcome history is full; inspect prior outcomes");
  const cancel = () => { active?.controller.abort(); active?.close?.(); };
  const open = async (args: string, ctx: ExtensionContext): Promise<void> => {
    if (restricted()) { ctx.ui.notify("Layout commands are unavailable in a capability-granted runtime", "warning"); return; }
    if (active) return;
    const run = { controller: new AbortController(), close: undefined as (() => void) | undefined };
    active = run;
    const { runtime, store, opener } = current();
    let pending: Promise<void> | undefined;
    const reads = new AbortController();
    try {
      if (ctx.mode !== "tui" || !runtime || !store || !opener) throw new Error("No verified interactive Rexpi conversation");
      const command = parseLayoutCommand(args), own = runtime.snapshot();
      const signal = AbortSignal.any([own.signal, run.controller.signal]);
      const verify = () => {
        signal.throwIfAborted(); runtime.assert(own);
        if (restricted() || current().runtime !== runtime || ctx.sessionManager.getSessionId() !== own.state.piSessionId)
          throw new Error("Pi source conversation changed or layout authority unavailable");
      };
      verify();
      if (command.kind === "save") {
        const captured = await captureActiveLayout(runtime.rex, own.blockId, signal);
        verify(); store.save(command.name, captured.spec, { overwrite: command.overwrite });
        ctx.ui.notify(`Saved layout ${command.name}` + (captured.shellFallbacks.length ? `; shell fallbacks: ${captured.shellFallbacks.join(", ")}` : ""), "info");
        return;
      }
      let selected: Layout | undefined;
      if (command.kind === "open") selected = store.get(command.name);
      else {
        const readSignal = AbortSignal.any([signal, reads.signal]);
        selected = await ctx.ui.custom<Layout | undefined>((tui, theme, keybindings, done) => {
          let closed = false;
          const finish = (row?: Layout) => {
            if (closed) return;
            closed = true; reads.abort(); signal.removeEventListener("abort", abort); done(row);
          };
          const abort = () => finish();
          const refresh = () => {
            if (closed || pending || readSignal.aborted) return;
            pending = (async () => {
              verify();
              let rows: Layout[];
              if (command.kind === "preview" && command.name === "current") {
                const captured = await captureActiveLayout(runtime.rex, own.blockId, readSignal);
                rows = [{ name: "current", origin: "user", ...captured.spec }];
              } else rows = command.kind === "preview" ? [store.get(command.name)] : store.list();
              verify(); if (!closed && !readSignal.aborted) overlay.setList(rows);
            })().catch(error => { if (!closed && !readSignal.aborted) overlay.setError(error); }).finally(() => { pending = undefined; });
          };
          const overlay = new LayoutsOverlay({ mode: command.kind === "preview" ? "preview" : "picker", keybindings,
            style: pickerStyle(theme), terminalRows: () => tui.terminal.rows, requestRender: () => tui.requestRender(), refresh, done: finish });
          run.close = abort;
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort(); else refresh();
          return overlay;
        }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "70%", anchor: "center", margin: 1 } });
        // Close and drain every overlay read before a native mutation.
        reads.abort(); await pending;
      }
      if (!selected) return;
      verify();
      const id = randomUUID();
      const result = await outcomes.run(id, () => opener.open(id, selected!.name,
        { version: selected!.version, root: selected!.root }, ctx.cwd, signal));
      verify(); ctx.ui.notify(layoutOpenText(result), result.state === "confirmed" ? "info" : "warning");
    } catch (error) {
      if (!run.controller.signal.aborted && current().runtime === runtime)
        ctx.ui.notify("Layouts: " + (error instanceof Error ? error.message : String(error)), "warning");
    } finally {
      reads.abort(); run.close?.(); await pending;
      if (active === run) active = undefined;
    }
  };
  for (const name of ["rxl", "rxlayouts"]) pi.registerCommand(name, {
    description: name === "rxl" ? "Read-only layout picker; open, save, or preview a layout" : "Alias for /rxl",
    handler: (args, ctx) => open(args, ctx),
  });
  return { cancel, open, outcomes };
}
