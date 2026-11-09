import test from "node:test";
import assert from "node:assert/strict";
import { parseLayoutCommand, registerLayoutsCommand } from "../extensions/layouts.ts";
import { builtInLayouts } from "../lib/layouts.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const commands = new Map(), notices = [], opens = [];
  const controller = new AbortController();
  const own = { state: { piSessionId: "session" }, blockId: "block", signal: controller.signal };
  const runtime = { snapshot: () => own, assert: value => assert.equal(value, own), rex: {} };
  const state = { runtime, store: { list: () => builtInLayouts(), get: name => {
    const row = builtInLayouts().find(row => row.name === name);
    if (!row) throw new Error("Unknown exact layout name"); return row;
  } }, opener: { open: async (...args) => { opens.push(args); return { state: "confirmed", name: args[1], windowId: "window" }; } } };
  let restricted = false, overlay, done;
  const ctx = { mode: "tui", cwd: "/tmp", sessionManager: { getSessionId: () => "session" }, ui: {
    notify: (...args) => notices.push(args),
    custom: factory => new Promise(resolve => {
      done = resolve;
      const theme = { fg: (_color, text) => text, bold: text => text, bg: (_color, text) => text };
      overlay = factory({ terminal: { rows: 40 }, requestRender() {} }, theme,
        { matches: (data, action) => data === action }, resolve);
    }),
  } };
  const registration = registerLayoutsCommand({ registerCommand: (name, command) => commands.set(name, command) }, () => state, () => restricted);
  return { commands, notices, opens, state, ctx, registration, controller,
    restrict() { restricted = true; }, overlay: () => overlay, done: value => done(value) };
}
test("parse picker, direct open, save, explicit overwrite and preview", () => {
  assert.deepEqual(parseLayoutCommand(""), { kind: "picker" });
  assert.deepEqual(parseLayoutCommand(" observe "), { kind: "open", name: "observe" });
  assert.deepEqual(parseLayoutCommand("save mine"), { kind: "save", name: "mine", overwrite: false });
  assert.deepEqual(parseLayoutCommand("save mine --overwrite"), { kind: "save", name: "mine", overwrite: true });
  for (const name of ["observe", "current"]) assert.deepEqual(parseLayoutCommand(`preview ${name}`), { kind: "preview", name });
  for (const args of ["save", "preview", "observe extra", "save mine --force", "preview observe extra", "UPPER", "../bad"])
    assert.throws(() => parseLayoutCommand(args));
});
test("aliases route direct opens; prefixes do not resolve ambiguous names", async () => {
  const f = fixture();
  assert.deepEqual([...f.commands.keys()], ["rxl", "rxlayouts"]);
  for (const name of ["build", "inspect", "observe"]) {
    await f.commands.get("rxlayouts").handler(name, f.ctx);
    assert.equal(f.opens.at(-1)[1], name);
    assert.deepEqual(Object.keys(f.opens.at(-1)[2]).sort(), ["root", "version"]);
    assert.match(f.notices.at(-1)[0], /conversation preserved/);
  }
  assert.equal(f.opens.length, 3);
  await f.registration.open("obs", f.ctx); assert.equal(f.opens.length, 3);
  assert.match(f.notices.at(-1)[0], /Unknown exact/);
});
test("picker selection opens only after done; duplicate opens suppressed", async () => {
  const f = fixture(), pending = f.registration.open("", f.ctx);
  await tick(); await f.registration.open("observe", f.ctx); assert.equal(f.opens.length, 0);
  f.overlay().handleInput("tui.select.confirm"); await pending;
  assert.equal(f.opens.length, 1);
});
test("named preview confirm and cancel never open", async () => {
  for (const action of ["confirm", "cancel"]) {
    const f = fixture(), pending = f.registration.open("preview observe", f.ctx);
    await tick(); f.overlay().handleInput(`tui.select.${action}`); await pending;
    assert.equal(f.opens.length, 0);
  }
});
test("replacement, stop and session mismatch reject stale runtime", async () => {
  const f = fixture(), pending = f.registration.open("", f.ctx);
  await tick(); f.state.runtime = { ...f.state.runtime };
  f.done(builtInLayouts()[0]); await pending; assert.equal(f.opens.length, 0);
  const stopped = fixture(), waiting = stopped.registration.open("", stopped.ctx);
  await tick(); stopped.registration.cancel(); await waiting; assert.equal(stopped.opens.length, 0);
  const changed = fixture(); changed.ctx.sessionManager.getSessionId = () => "other";
  await changed.registration.open("observe", changed.ctx); assert.equal(changed.opens.length, 0);
});
test("current preview captures without opening and save forwards overwrite explicitly", async () => {
  const f = fixture();
  const block = "block:11111111-1111-4111-8111-111111111111";
  const window = "window:22222222-2222-4222-8222-222222222222";
  const own = f.state.runtime.snapshot(); own.blockId = block;
  let reads = 0;
  f.state.runtime.rex = {
    locate: async () => ({ sessionId: "session", blockId: block }),
    view: async () => { reads++; return { active_window_id: window, windows: [{ window_id: window,
      focused_block_id: block, layers: [{ kind: "tiled", blocks: [{ block_id: block,
        creator_name: "com.superlogical.terminal", flavor: "com.superlogical.terminal.shell", label: "Pi" }],
      layout: { block_id: block, rect: [0, 0, 1, 1] } }] }] }; },
  };
  const saves = [];
  f.state.store.save = (...args) => { saves.push(args); };
  const pending = f.registration.open("preview current", f.ctx);
  await tick(); assert.equal(f.overlay().selectedRow()?.name, "current");
  f.overlay().handleInput("tui.select.confirm"); await pending;
  assert.equal(f.opens.length, 0); assert.equal(reads, 1);
  await f.registration.open("save mine", f.ctx);
  await f.registration.open("save mine --overwrite", f.ctx);
  assert.equal(saves.length, 2);
  assert.deepEqual(saves.map(args => args[2]), [{ overwrite: false }, { overwrite: true }]);
  assert.equal(saves[0][1].root.source, "current");
});
test("restricted capabilities cannot invoke layout commands", async () => {
  const f = fixture(); f.restrict(); await f.registration.open("observe", f.ctx);
  assert.equal(f.opens.length, 0); assert.match(f.notices[0][0], /capability-granted/);
});
