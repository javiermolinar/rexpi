import test from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { quotedWorktreeText } from "../lib/worktree-review-overlay.ts";
import { WorktreeResultsOverlay, removalCount } from "../lib/worktree-results-overlay.ts";

function report() {
  return { error: "Git removal failed", results: ["removed", "cleaned", "blocked", "failed", "unknown", "not-attempted"].map((outcome, i) => ({
    key: String(i), outcome, row: { path: "/projects/worktree-" + i, branch: "refs/heads/feature-" + i },
    message: outcome === "removed" ? "Directory and registration removed (verified)" : outcome === "cleaned" ? "Git registration removed (verified)"
      : outcome === "not-attempted" ? "Stopped before this worktree was processed" : "Inspect Git before retrying",
  })) };
}
function setup(input = report(), extra = {}) {
  let closed = 0;
  const overlay = new WorktreeResultsOverlay(input, { keybindings: new KeybindingsManager(TUI_KEYBINDINGS), terminalRows: () => 40,
    requestRender() {}, done: () => { closed++; }, ...extra });
  return { overlay, get closed() { return closed; } };
}
const text = overlay => overlay.render(90).join("\n").replaceAll(CURSOR_MARKER, "");
test("results distinguish verified deletion/cleanup, blocked, failed, unknown and unattempted paths", () => {
  const input = report(), a = setup(input), output = text(a.overlay);
  assert.equal(removalCount(input), 2);
  for (const word of ["Deletion results", "2/6 removed", "Batch stopped", "branches retained", "Deleted", "Cleaned", "Blocked", "Failed", "Unknown", "Not attempted", "enter close"])
    assert.ok(output.includes(word), word);
  assert.ok(!output.includes("enter open") && !output.includes("CTRL-D delete"));
  assert.equal(a.closed, 0);
  a.overlay.handleInput("\x04"); a.overlay.handleInput("\x12");
  assert.equal(a.closed, 0);
});
test("Enter acknowledges results even with an empty filter result or tiny terminal", () => {
  const a = setup();
  for (const char of "nomatch") a.overlay.handleInput(char);
  assert.equal(a.overlay.selectedRow(), undefined);
  a.overlay.handleInput("\r"); a.overlay.handleInput("\r");
  assert.equal(a.closed, 1);
  const b = setup(report(), { terminalRows: () => 4 });
  b.overlay.render(10); b.overlay.handleInput("\r"); assert.equal(b.closed, 1);
});
test("result acknowledgement respects injected keys and Escape closes exactly once", () => {
  const a = setup(report(), { keybindings: new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.confirm": ["ctrl+y"] }) });
  a.overlay.handleInput("\x19"); a.overlay.handleInput("\x1b"); assert.equal(a.closed, 1);
  const b = setup(); b.overlay.handleInput("\x1b"); b.overlay.handleInput("\r"); assert.equal(b.closed, 1);
});
test("Tab exposes full unknown target and reason, and returns to the same filtered result", () => {
  const input = report();
  const path = '/projects/' + 'long parent/'.repeat(35) + 'unique-suffix/repeated-name';
  const message = 'Git returned success but removal could not be verified. '.repeat(12) + 'Inspect Git before retrying. REASON-END';
  input.results[4].row.path = path; input.results[4].message = message;
  input.results[5].row.path = '/another/parent/repeated-name';
  const a = setup(input);
  for (const char of 'unique-suffix') a.overlay.handleInput(char);
  assert.equal(a.overlay.selectedRow().outcome, 'unknown');
  assert.match(text(a.overlay), /tab details/);
  a.overlay.handleInput('\t');
  let seen = '';
  const expected = [quotedWorktreeText(path), quotedWorktreeText(message)].flatMap(value => wrapTextWithAnsi(value, 76));
  for (let n = 0; n < 100; n++) {
    const lines = a.overlay.render(80);
    assert.ok(lines.length <= 28);
    for (const line of lines) assert.ok(visibleWidth(line) <= 80);
    seen += lines.join('\n'); a.overlay.handleInput('\x1b[B');
  }
  for (const line of expected) assert.ok(seen.includes(line), line);
  assert.equal(a.closed, 0);
  a.overlay.handleInput('\x1b');
  assert.equal(a.closed, 0); assert.equal(a.overlay.selectedRow().row.path, path);
  assert.equal(a.overlay.input.getValue(), 'unique-suffix');
  a.overlay.handleInput('\r'); assert.equal(a.closed, 1);
});
test("paths and reasons remain searchable, with safe Unicode/narrow rendering", () => {
  const input = report(), a = setup(input);
  for (const char of "worktree-4") a.overlay.handleInput(char);
  assert.equal(a.overlay.selectedRow().outcome, "unknown");
  input.results[4].row.path = "/tmp/タスク🚀\x1b[31m".repeat(15);
  input.results[4].message = "bad\nreason\x1b]8;;bad\x07";
  const b = setup(input);
  for (const width of [1, 10, 24, 38, 72, 100]) for (const line of b.overlay.render(width)) {
    assert.ok(visibleWidth(line.replaceAll(CURSOR_MARKER, "")) <= width);
    assert.ok(!line.includes("\x1b[31m") && !line.includes("\x1b]8"));
  }
});
