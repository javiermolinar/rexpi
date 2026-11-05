import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { registerAgentsCommand } from "../extensions/agents.ts";
import { active } from "./fixtures.mjs";

async function setup(t, evidence = () => ({ relations: [], statuses: [] })) {
  const a = await active(t), commands = new Map(), notices = [];
  let runtime = a.runtime, overlay, opened = 0;
  const { cancel, open } = registerAgentsCommand({ registerCommand: (name, command) => commands.set(name, command) }, () => runtime, evidence);
  const ctx = { ...a.ctx, ui: { ...a.ctx.ui, notify: (...args) => notices.push(args),
    custom: async (factory, options) => {
      assert.equal(options.overlay, true); opened++;
      return new Promise(resolve => {
        overlay = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_c, s) => s, bg: (_c, s) => s, bold: s => s },
          new KeybindingsManager(TUI_KEYBINDINGS), value => { overlay?.dispose(); resolve(value); });
      });
    } } };
  return { ...a, ctx, cancel, commands, notices, get overlay() { return overlay; }, get opened() { return opened; },
    disable: () => { runtime = undefined; }, open: () => open(ctx) };
}
async function until(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await tick(); }
  assert.fail("overlay did not reach expected state");
}
test("opening only reads, double open is ignored, Escape cancels and reopening works", async t => {
  const a = await setup(t), initial = a.w.calls.length;
  assert.equal(a.w.calls.length, initial);
  const running = a.open();
  await until(() => a.overlay?.selectedRow());
  assert.equal(a.w.focusCalls ?? 0, 0);
  await a.open(); assert.equal(a.opened, 1);
  a.overlay.handleInput("\x1b"); await running;
  assert.equal(a.w.focusCalls ?? 0, 0);
  const again = a.open(); await until(() => a.opened === 2 && a.overlay?.selectedRow());
  a.overlay.handleInput("\x1b"); await again;
});
test("the open overlay snapshots supplied launch and cached-status evidence", async t => {
  let calls = 0;
  const a = await setup(t, () => { calls++; return { relations: [], statuses: [] }; });
  const running = a.open();
  await until(() => a.overlay?.selectedRow() && calls > 0);
  assert.equal(calls, 1);
  a.overlay.handleInput("\x1b"); await running;
});
test("canonical agents command and labeled alias share the same overlay and reentry guard", async t => {
  const a = await setup(t);
  assert.deepEqual([...a.commands.keys()], ["rxa", "rxagents"]);
  assert.match(a.commands.get("rxa").description, /Show agents/);
  assert.equal(a.commands.get("rxagents").description, "Alias for /rxa");
  const running = a.commands.get("rxa").handler("", a.ctx);
  await until(() => a.overlay?.selectedRow());
  await a.commands.get("rxagents").handler("", a.ctx);
  assert.equal(a.opened, 1);
  a.overlay.handleInput("\x1b"); await running;
  const again = a.commands.get("rxagents").handler("", a.ctx);
  await until(() => a.opened === 2 && a.overlay?.selectedRow());
  a.overlay.handleInput("\x1b"); await again;
});
test("Enter dismisses the overlay before exact-pane focus", async t => {
  const a = await setup(t), running = a.open();
  await until(() => a.overlay?.selectedRow());
  let afterClose = false;
  const selected = a.overlay.selectedRow();
  const original = a.rex.focus.bind(a.rex);
  a.rex.focus = async (...args) => { afterClose = true; assert.equal(a.overlay.selectedRow().key, selected.key); return original(...args); };
  a.overlay.handleInput("\r"); await running;
  assert.equal(afterClose, true);
  assert.equal(a.w.focusCalls, 1);
  assert.equal(a.notices.length, 0);
});
test("shutdown cancels a pending read, suppresses late data and never navigates", async t => {
  const a = await setup(t);
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  a.w.onTerminalData = async () => { entered = true; await gate; };
  const running = a.open(); await until(() => entered);
  a.cancel(); a.runtime.stop(); release();
  await running;
  assert.equal(a.w.focusCalls ?? 0, 0);
  assert.equal(a.overlay.selectedRow(), undefined);
  assert.equal(a.notices.length, 0);
});
test("a replaced runtime cannot focus a result from the previous overlay", async t => {
  const a = await setup(t), running = a.open();
  await until(() => a.overlay?.selectedRow());
  a.disable(); a.overlay.handleInput("\r"); await running;
  assert.equal(a.w.focusCalls ?? 0, 0);
});
test("noninteractive and inactive invocations do not open or perform native reads", async t => {
  const a = await setup(t), before = a.w.calls.length;
  await a.commands.get("rxagents").handler("", { ...a.ctx, mode: "rpc" });
  a.disable(); await a.open();
  assert.equal(a.opened, 0);
  assert.equal(a.w.calls.length, before);
  assert.equal(a.notices.length, 2);
});
