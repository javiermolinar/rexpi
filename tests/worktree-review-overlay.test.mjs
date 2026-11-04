import test from "node:test";
import assert from "node:assert/strict";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { WorktreeConfirmationOverlay, WorktreeTextOverlay, quotedWorktreeText } from "../lib/worktree-review-overlay.ts";

const rows = count => Array.from({ length: count }, (_, i) => ({ path: `/projects/marked-target-${i}`, state: i % 2 ? "missing" : "clean" }));
function setup(input = rows(1), extra = {}) {
  const done = [];
  const overlay = new WorktreeConfirmationOverlay(input, { keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    terminalRows: () => 30, requestRender() {}, done: value => done.push(value), ...extra });
  return { overlay, done };
}
const text = (overlay, width = 80) => overlay.render(width).join("\n");
test("confirmation defaults to Cancel and requires an explicit Remove choice", () => {
  const a = setup(); assert.match(text(a.overlay), /\[Cancel\]/);
  a.overlay.handleInput("\r"); a.overlay.handleInput("\t"); a.overlay.handleInput("\r");
  assert.deepEqual(a.done, [false]);
  const b = setup(); text(b.overlay); b.overlay.handleInput("\t");
  assert.match(text(b.overlay), /\[Remove\]/);
  b.overlay.handleInput("\r"); b.overlay.handleInput("\r"); assert.deepEqual(b.done, [true]);
});
test("every target in a 256-item batch is reachable inside a 30-row viewport", () => {
  const input = rows(256), a = setup(input);
  let seen = "";
  for (let n = 0; n < 85; n++) {
    const lines = a.overlay.render(80);
    assert.ok(lines.length <= 21);
    for (const line of lines) assert.ok(visibleWidth(line) <= 80);
    seen += lines.join("\n") + "\n";
    a.overlay.handleInput("\x1b[6~");
  }
  for (const row of input) assert.ok(seen.includes(quotedWorktreeText(row.path)), row.path);
  assert.match(seen, /Registration only/); assert.match(seen, /Directory/);
  a.overlay.handleInput("\x1b[H"); assert.match(text(a.overlay), /Branches are retained/);
  a.overlay.handleInput("\x1b[F"); assert.match(text(a.overlay), /marked-target-255/);
  assert.deepEqual(a.done, []);
});
test("full literal long paths wrap without dropping suffixes or terminal controls", () => {
  const path = '/projects/' + 'long project/'.repeat(40) + 'タスク🚀\n\x1b[31m\u202e-final';
  const a = setup([{ path, state: "clean" }]), quoted = quotedWorktreeText(path);
  const expected = wrapTextWithAnsi(quoted, 76);
  let seen = "";
  for (let n = 0; n < expected.length + 12; n++) { seen += text(a.overlay); a.overlay.handleInput("\x1b[B"); }
  for (const line of expected) assert.ok(seen.includes(line), line);
  assert.ok(!seen.includes("\x1b") && !seen.includes("\u202e"));
  assert.ok(seen.includes("\\n") && seen.includes("\\u001b") && seen.includes("\\u202e"));
});
test("tiny terminals cannot authorize deletion; cancellation always works", () => {
  let height = 30;
  const a = setup(rows(1), { terminalRows: () => height });
  text(a.overlay); a.overlay.handleInput("\t");
  height = 4;
  for (const width of [1, 10, 24, 80]) {
    assert.ok(a.overlay.render(width).length <= 2);
    a.overlay.handleInput("\r"); assert.deepEqual(a.done, []);
  }
  a.overlay.handleInput("\x1b"); assert.deepEqual(a.done, [false]);
});
test("scrolling and confirmation honor injected selection keys and reflow on resize", () => {
  let height = 30;
  const a = setup(rows(40), { terminalRows: () => height, keybindings: new KeybindingsManager(TUI_KEYBINDINGS,
    { "tui.select.confirm": ["ctrl+y"], "tui.select.pageDown": ["ctrl+n"] }) });
  text(a.overlay); a.overlay.handleInput("\x0e"); assert.ok(!text(a.overlay).includes("Branches are retained"));
  height = 12;
  for (const width of [24, 38, 80]) {
    const lines = a.overlay.render(width); assert.ok(lines.length <= 8);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  a.overlay.handleInput("\t"); a.overlay.handleInput("\x19"); assert.deepEqual(a.done, [true]);
});
test("read-only text details close without authorizing anything", () => {
  const done = [], overlay = new WorktreeTextOverlay("Result", "full path\nfull reason", {
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS), terminalRows: () => 30, requestRender() {}, done: value => done.push(value),
  });
  text(overlay); overlay.handleInput("\x04"); overlay.handleInput("\x12"); assert.deepEqual(done, []);
  overlay.handleInput("\r"); overlay.handleInput("\x1b"); assert.deepEqual(done, [false]);
});
