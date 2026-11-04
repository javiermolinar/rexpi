import test from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { WorktreesOverlay } from "../lib/worktrees-overlay.ts";

function row(index, extra = {}) {
  return { key: "tree-" + index, path: "/projects/rex-" + index, head: "a".repeat(40), branch: "refs/heads/feature-" + index,
    main: false, bare: false, repository: "/projects/rex", commonDir: "/projects/rex/.git", identity: "1:" + index,
    current: false, state: "clean", agents: 0,
    deletionIssue: extra.main ? "Main worktree" : extra.current ? "Current worktree" : extra.state === "dirty" ? "Uncommitted changes" : "", ...extra };
}
function setup(options = {}) {
  const done = [], refreshed = [];
  const overlay = new WorktreesOverlay({ keybindings: new KeybindingsManager(TUI_KEYBINDINGS), terminalRows: () => 35,
    done: value => done.push(value), refresh: () => refreshed.push(true), requestRender() {}, ...options });
  return { overlay, done, refreshed };
}
const text = (overlay, width = 72) => overlay.render(width).join("\n").replaceAll(CURSOR_MARKER, "");

test("worktree view copies the agents tree, status column, search and compact controls", () => {
  const a = setup();
  assert.match(text(a.overlay), /Reading Git worktrees/);
  a.overlay.setList({ unavailable: 0, rows: [row(0, { branch: "refs/heads/main", main: true, current: true }), row(1, { state: "dirty" })] });
  const output = text(a.overlay);
  for (const pattern of [/Worktrees/, /Search/, /▾ rex/, /├─ \[-\] main/, /└─ \[-\] feature-1/, /Main/, /Current/, /rex-0/, /✓ Clean/, /● Dirty/, /CTRL-D delete/]) assert.match(output, pattern);
  for (const char of "dirty") a.overlay.handleInput(char);
  assert.equal(a.overlay.selectedRow().key, "tree-1");
  a.overlay.handleInput("\r");
  assert.deepEqual(a.done, [{ kind: "open", row: a.overlay.selectedRow() }]);
  a.overlay.handleInput("\x04"); assert.equal(a.done.length, 1);
});
test("Ctrl+D requires marks and requests removal once, while Delete edits the filter", () => {
  const a = setup(), entry = row(0);
  a.overlay.setList({ rows: [entry], unavailable: 0 });
  a.overlay.handleInput("\x1b[3~"); assert.equal(a.done.length, 0);
  a.overlay.handleInput("\x04"); assert.equal(a.done.length, 0);
  a.overlay.handleInput(" "); assert.deepEqual(a.overlay.markedRows(), [entry]);
  a.overlay.handleInput("\x04"); a.overlay.handleInput("\x04");
  assert.deepEqual(a.done, [{ kind: "remove", rows: [entry] }]);
});
test("Space toggles multiple marks across filters without changing the search", () => {
  const a = setup(), rows = [row(0), row(1), row(2)];
  a.overlay.setList({ rows, unavailable: 0 });
  a.overlay.handleInput(" "); a.overlay.handleInput("\x1b[B"); a.overlay.handleInput(" ");
  assert.deepEqual(a.overlay.markedRows(), rows.slice(0, 2));
  assert.equal(a.overlay.input.getValue(), "");
  assert.match(text(a.overlay), /2 marked/); assert.match(text(a.overlay), /\[x\] feature-0/);
  a.overlay.handleInput(" "); assert.deepEqual(a.overlay.markedRows(), [rows[0]]);
  for (const char of "feature-2") a.overlay.handleInput(char);
  assert.equal(a.overlay.selectedRow().key, rows[2].key);
  assert.match(text(a.overlay), /1 marked/);
  a.overlay.handleInput("\x04");
  assert.deepEqual(a.done, [{ kind: "remove", rows: [rows[0]] }]);
});
test("protected worktrees cannot be marked; Enter still opens the focused row", () => {
  const a = setup(), rows = [row(0, { main: true }), row(1)];
  a.overlay.setList({ rows, unavailable: 0 });
  a.overlay.handleInput(" "); assert.deepEqual(a.overlay.markedRows(), []);
  assert.match(text(a.overlay), /Cannot mark: Main worktree/);
  assert.match(text(a.overlay), /\[-\] feature-0/);
  a.overlay.handleInput("\x1b[B"); a.overlay.handleInput(" ");
  a.overlay.handleInput("\x1b[A"); a.overlay.handleInput("\r");
  assert.deepEqual(a.done, [{ kind: "open", row: rows[0] }]);
});
test("refresh keeps unchanged marks and clears missing, replaced, changed or newly protected rows", () => {
  for (const kind of ["missing", "directory", "head", "branch", "protected", "state"]) {
    const a = setup(), rows = [row(0), row(1)];
    a.overlay.setList({ rows, unavailable: 0 });
    a.overlay.handleInput(" "); a.overlay.handleInput("\x1b[B"); a.overlay.handleInput(" ");
    const changed = kind === "directory" ? { identity: "replacement" } : kind === "head" ? { head: "b".repeat(40) }
      : kind === "branch" ? { branch: "refs/heads/other" } : kind === "state" ? { state: "missing" } : { deletionIssue: "Live Rex agents" };
    a.overlay.setList({ rows: [rows[0], ...(kind === "missing" ? [] : [{ ...rows[1], ...changed }])], unavailable: 0 });
    assert.deepEqual(a.overlay.markedRows(), [rows[0]], kind);
    assert.match(text(a.overlay), /1 marked/);
    a.overlay.setError("Read failed");
    assert.deepEqual(a.overlay.markedRows(), []);
    a.overlay.handleInput("\x04"); assert.equal(a.done.length, 0);
  }
});
test("Alt+Space inserts a filter separator and Escape never submits marked rows", () => {
  const a = setup(), entry = row(0);
  a.overlay.setList({ rows: [entry], unavailable: 0 });
  a.overlay.handleInput(" ");
  for (const char of "feature") a.overlay.handleInput(char);
  a.overlay.handleInput("\x1b ");
  for (const char of "clean") a.overlay.handleInput(char);
  assert.equal(a.overlay.input.getValue(), "feature clean");
  assert.equal(a.overlay.selectedRow().key, entry.key);
  a.overlay.handleInput("\x1b");
  assert.deepEqual(a.done, [undefined]);
});
test("detached, bare, locked, prunable and unknown status are explicit and searchable", () => {
  const a = setup();
  a.overlay.setList({ unavailable: 1, rows: [row(0, { branch: "", locked: "reason", agents: 2 }),
    row(1, { bare: true, state: "unavailable", prunable: "gone" })] });
  let output = text(a.overlay);
  for (const pattern of [/Detached aaaaaaaa/, /Locked/, /2 agents/, /Bare repository/, /Unavailable/, /Prunable/, /1 unavailable/]) assert.match(output, pattern);
  for (const char of "locked") a.overlay.handleInput(char);
  assert.equal(a.overlay.selectedRow().key, "tree-0");
  a.overlay.setError("Git read failed\x1b[31m");
  a.overlay.handleInput("\r"); a.overlay.handleInput("\x04");
  assert.equal(a.done.length, 0);
  assert.doesNotMatch(text(a.overlay), /\x1b\[31m/);
});
test("missing registrations are neutral, counted separately, and markable for targeted cleanup", () => {
  const a = setup(), main = row(0, { main: true, current: true, state: "dirty" }), live = row(1);
  const missing = Array.from({ length: 17 }, (_, index) => row(index + 2, {
    state: "missing", identity: "missing", prunable: "gitdir file points to non-existent location", deletionIssue: "",
  }));
  a.overlay.setList({ rows: [main, live, ...missing], unavailable: 0 });
  let output = text(a.overlay);
  assert.match(output, /17 missing/); assert.doesNotMatch(output, /17 unavailable|! Unavailable/);
  assert.match(output, /· Missing/); assert.match(output, /Registration only/);
  a.overlay.handleInput("\x1b[B"); a.overlay.handleInput("\x1b[B"); a.overlay.handleInput(" ");
  assert.deepEqual(a.overlay.markedRows(), [missing[0]]);
  a.overlay.handleInput("\x04");
  assert.deepEqual(a.done, [{ kind: "remove", rows: [missing[0]] }]);
});
test("refresh preserves path selection, and scrolling retains repository context", () => {
  let height = 35;
  const a = setup({ terminalRows: () => height }), rows = Array.from({ length: 25 }, (_, index) => row(index));
  a.overlay.setList({ rows, unavailable: 0 });
  for (let n = 0; n < 24; n++) a.overlay.handleInput("\x1b[B");
  for (const h of [35, 18, 10, 7]) {
    height = h; const output = text(a.overlay);
    assert.match(output, /feature-24/);
    assert.ok(a.overlay.render(72).length <= Math.floor(h * 0.7));
  }
  height = 35;
  a.overlay.setList({ rows: [...rows].reverse(), unavailable: 0 });
  assert.equal(a.overlay.selectedRow().key, "tree-24");
  a.overlay.handleInput("\x12"); assert.equal(a.refreshed.length, 1);
  assert.match(text(a.overlay), /▾ rex/);
});
test("narrow widths, Unicode, resize and untrusted Git display data stay inside the surface", () => {
  let height = 35;
  const a = setup({ terminalRows: () => height });
  a.overlay.setList({ rows: [row(0, { path: "/tmp/タスク🚀".repeat(20) + "\x1b]8;;bad\x07link\x1b]8;;\x07", branch: "refs/heads/\x1b[31munsafe\nbranch" })], unavailable: 0 });
  a.overlay.focused = true; assert.equal(a.overlay.input.focused, true);
  for (const width of [1, 2, 10, 24, 38, 72, 100]) {
    for (const line of a.overlay.render(width)) assert.ok(visibleWidth(line.replaceAll(CURSOR_MARKER, "")) <= width);
    assert.doesNotMatch(text(a.overlay, width), /\x1b\[31m|\x1b\]8/);
  }
  height = 4; assert.match(text(a.overlay), /Resize terminal/);
  a.overlay.handleInput("\x04"); assert.equal(a.done.length, 0);
  a.overlay.handleInput("\x1b"); assert.deepEqual(a.done, [undefined]);
});
