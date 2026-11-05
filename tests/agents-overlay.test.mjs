import test from "node:test";
import assert from "node:assert/strict";
import { KeybindingsManager, TUI_KEYBINDINGS, CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { AgentsOverlay, agentsStyle, agentName } from "../lib/agents-overlay.ts";
import { rid, uuid } from "./fixtures.mjs";

function row(index, extra = {}) {
  return { key: "agent-" + index, sessionId: rid("session"), windowId: rid("window"), blockId: rid("block"), serverInstance: uuid(),
    app: "Pi", pid: 1000 + index, processName: "node", state: "working", title: "Task " + index, message: "", cwd: "/project",
    label: "Task " + index, sessionLabel: "Project", windowLabel: "Main", current: false, native: true, ...extra };
}
function setup(options = {}) {
  const done = [], refreshed = [], renders = [];
  const overlay = new AgentsOverlay({ keybindings: new KeybindingsManager(TUI_KEYBINDINGS), terminalRows: () => 30,
    done: value => done.push(value), refresh: () => refreshed.push(true), requestRender: () => renders.push(true), ...options });
  return { overlay, done, refreshed, renders };
}
const plainLines = overlay => overlay.render(88).map(line => line.replaceAll(CURSOR_MARKER, ""));

test("loading, empty, failed, partial and no-match states are explicit and nonselectable", () => {
  const a = setup();
  assert.match(plainLines(a.overlay).join("\n"), /Reading Rex/);
  a.overlay.handleInput("\r"); assert.equal(a.done.length, 0);
  a.overlay.setList({ rows: [], unavailable: 0 });
  assert.match(plainLines(a.overlay).join("\n"), /No live/);
  a.overlay.setError(new Error("\x1b[31mRex unavailable\nnow"));
  assert.match(plainLines(a.overlay).join("\n"), /Rex unavailable now/);
  a.overlay.handleInput("\r"); assert.equal(a.done.length, 0);
  a.overlay.setList({ rows: [row(1)], unavailable: 2 });
  assert.match(plainLines(a.overlay).join("\n"), /2 unavailable/);
  for (const char of "nomatch") a.overlay.handleInput(char);
  assert.match(plainLines(a.overlay).join("\n"), /No matching/);
  a.overlay.handleInput("\r"); assert.equal(a.done.length, 0);
});
test("type-to-filter, injected keys and exactly-once selection/cancellation", () => {
  const a = setup({ keybindings: new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": ["ctrl+j"], "tui.select.confirm": ["ctrl+y"] }) });
  const rows = [row(1), row(2, { app: "Claude", state: "blocked" }), row(3, { app: "Claude", state: "idle" })];
  a.overlay.setList({ rows, unavailable: 0 });
  a.overlay.focused = true;
  assert.equal(a.overlay.input.focused, true);
  for (const char of "claude") a.overlay.handleInput(char);
  assert.equal(a.overlay.selectedRow().key, rows[1].key);
  a.overlay.handleInput("\n"); // Ctrl+J, not the default Enter binding.
  assert.equal(a.overlay.selectedRow().key, rows[2].key);
  a.overlay.handleInput("\x19");
  a.overlay.handleInput("\x1b");
  assert.deepEqual(a.done, [rows[2]]);
  const b = setup(); b.overlay.handleInput("\x1b"); b.overlay.handleInput("\x03");
  assert.deepEqual(b.done, [undefined]);
});
test("refresh preserves the selected agent by key and errors discard stale targets", () => {
  const a = setup(), rows = [row(1), row(2), row(3)];
  a.overlay.setList({ rows, unavailable: 0 });
  a.overlay.handleInput("\x1b[B");
  assert.equal(a.overlay.selectedRow().key, rows[1].key);
  a.overlay.setList({ rows: [rows[2], { ...rows[1], state: "done" }, rows[0]], unavailable: 0 });
  assert.equal(a.overlay.selectedRow().key, rows[1].key);
  assert.equal(a.overlay.selectedRow().state, "done");
  a.overlay.handleInput("\x12"); assert.equal(a.refreshed.length, 1);
  a.overlay.setError("lost connection");
  a.overlay.handleInput("\r"); assert.equal(a.done.length, 0);
});
test("scrolling and resizing keep the selected split visible within the overlay budget", () => {
  let height = 35;
  const a = setup({ terminalRows: () => height }), rows = Array.from({ length: 30 }, (_, index) => row(index));
  a.overlay.setList({ rows, unavailable: 0 });
  for (let n = 0; n < 29; n++) a.overlay.handleInput("\x1b[B");
  for (const h of [35, 18, 10, 7]) {
    height = h;
    const lines = plainLines(a.overlay);
    assert.ok(lines.length <= Math.floor(height * 0.7), "height " + height);
    assert.match(lines.join("\n"), /Task 29/);
  }
  height = 4;
  assert.match(plainLines(a.overlay).join("\n"), /Resize terminal/);
  a.overlay.handleInput("\r"); assert.equal(a.done.length, 0);
  a.overlay.handleInput("\x1b"); assert.equal(a.done.length, 1);
});
test("wide Unicode, ANSI-like metadata, query cursor and narrow widths never overflow", () => {
  const a = setup();
  a.overlay.setList({ rows: [row(1, { title: "\x1b[31mタスク🚀".repeat(30), message: "\nunsafe\x1b]8;;https://evil\x07label\x1b]8;;\x07", sessionLabel: "日本語" })], unavailable: 0 });
  for (const width of [1, 2, 10, 24, 28, 40, 88]) {
    for (const line of a.overlay.render(width)) assert.ok(visibleWidth(line.replaceAll(CURSOR_MARKER, "")) <= width, `overflow at ${width}: ${line}`);
  }
  assert.ok(!plainLines(a.overlay).join("\n").includes("\x1b[31m"));
  a.overlay.input.setValue("日本語");
  a.overlay.focused = true;
  assert.ok(a.overlay.render(88).some(line => line.includes(CURSOR_MARKER)));
  a.overlay.invalidate();
});
test("real screenshot metadata renders conversation names, not shell labels or internal identifiers", () => {
  const a = setup();
  a.overlay.setList({ unavailable: 0, rows: [
    row(1, { title: "shell", label: "shell", conversationTitle: "π - rexpi", cwd: "/Users/javimolina/rexpi",
      sessionLabel: "pi-cmux", windowLabel: "Window 533ea343", current: true, state: "done", pid: 20933 }),
    row(2, { title: "shell", label: "shell", conversationTitle: "π - tempo.fork - tempo.fork",
      cwd: "/Users/javimolina/grafana/tempo.fork", sessionLabel: "Tempo", windowLabel: "tempo.fork", state: "idle", pid: 20447 }),
  ] });
  const text = a.overlay.render(72).join("\n");
  assert.match(text, /rexpi/); assert.match(text, /tempo.fork/);
  assert.match(text, /pi-cmux/); assert.match(text, /Tempo/);
  assert.match(text, /Current/); assert.match(text, /Done/); assert.match(text, /Idle/);
  for (const noise of ["shell", "Window 533ea343", "20933", "20447", "/Users", "PID", "main", "chat"]) assert.ok(!text.includes(noise), noise);
});
test("generic labels fall back to the project directory and duplicate names get stable pane labels", () => {
  const sessionId = rid("session"), first = row(1, { title: "shell", label: "shell", windowLabel: "Window 123abc", cwd: "/projects/rex", sessionId });
  const second = row(2, { ...first, key: "second", blockId: rid("block") });
  assert.equal(agentName(first), "rex");
  const a = setup(); a.overlay.setList({ unavailable: 0, rows: [first, second] });
  const before = plainLines(a.overlay).join("\n");
  assert.match(before, /Pane 1/); assert.match(before, /Pane 2/);
  a.overlay.setList({ unavailable: 0, rows: [second, first] });
  assert.equal(a.overlay.selectedRow().key, first.key);
  assert.match(plainLines(a.overlay).join("\n"), /Pane 1/);
});
test("selected rows use the theme's soft background rather than inverse video", () => {
  const colors = [];
  const style = agentsStyle({ fg: (_color, text) => text, bg: (color, text) => { colors.push(color); return text; }, bold: text => text });
  style.selected("agent");
  assert.deepEqual(colors, ["selectedBg"]);
});
test("workspace headings are never orphaned and review context is not repeated", () => {
  const a = setup({ terminalRows: () => 20 });
  a.overlay.setList({ unavailable: 0, rows: [
    row(1, { sessionId: "first", sessionLabel: "First", windowLabel: "Review", binding: { role: "review" } }),
    row(2, { sessionId: "second", sessionLabel: "Second" }),
  ] });
  const text = plainLines(a.overlay).join("\n");
  assert.ok(!text.includes("Review · Review"));
  if (text.includes("Second")) assert.ok(text.includes("Task 2"));
});
test("agents nest directly under workspaces without tab headings and navigation follows visible order", () => {
  const a = setup({ terminalRows: () => 60 });
  const base = { sessionId: "workspace", sessionLabel: "Work", windowId: "window:1", windowLabel: "Window 1111" };
  const pi = row(1, { ...base, title: "Pi current" });
  const claude = row(2, { ...base, title: "Claude split", app: "Claude" });
  const reviewer = row(3, { ...base, windowId: "window:2", windowLabel: "Window 2222", title: "Reviewer" });
  a.overlay.setList({ unavailable: 0, rows: [pi, reviewer, claude] });
  const text = plainLines(a.overlay).join("\n");
  assert.match(text, /▾ Work/);
  assert.match(text, /├─ Pi current/);
  assert.match(text, /├─ Reviewer/);
  assert.match(text, /└─ Claude split/);
  assert.doesNotMatch(text, /Tab [12]|2 panes|Window [12]+/);
  a.overlay.handleInput("\x1b[B"); assert.equal(a.overlay.selectedRow().key, reviewer.key);
  a.overlay.handleInput("\x1b[B"); assert.equal(a.overlay.selectedRow().key, claude.key);
  assert.match(plainLines(a.overlay).join("\n"), /Reviewer/);
});
test("selected agent retains its workspace heading while scrolling and filtering", () => {
  const a = setup({ terminalRows: () => 18 });
  const rows = Array.from({ length: 12 }, (_, index) => row(index, {
    sessionId: "workspace", sessionLabel: "Work", windowId: "window:1", windowLabel: "Main",
  }));
  a.overlay.setList({ unavailable: 0, rows });
  for (let n = 0; n < 11; n++) a.overlay.handleInput("\x1b[B");
  let text = plainLines(a.overlay).join("\n");
  assert.match(text, /▾ Work/); assert.doesNotMatch(text, /Tab · Main/); assert.match(text, /Task 11/);
  for (const char of "Task 11") a.overlay.handleInput(char);
  text = plainLines(a.overlay).join("\n");
  assert.match(text, /▾ Work/); assert.doesNotMatch(text, /Tab · Main/); assert.match(text, /Task 11/);
});
test("state colors are semantic and derive from the active theme at render time", () => {
  const colors = [];
  const style = agentsStyle({ fg: (color, text) => { colors.push(color); return text; }, bg: (_color, text) => text, bold: text => text });
  for (const state of ["working", "blocked", "error", "done", "idle", "unknown"]) style.status(state, state);
  assert.deepEqual(colors, ["accent", "warning", "error", "success", "muted", "muted"]);
});
