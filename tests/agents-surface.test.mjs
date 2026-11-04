import test from "node:test";
import assert from "node:assert/strict";
import { compositeTuiLine, CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { AgentsOverlay, agentsStyle } from "../lib/agents-overlay.ts";

/** Track cell backgrounds through actual SGR output and native overlay composition. */
function backgrounds(line) {
  line = line.replaceAll(CURSOR_MARKER, "");
  let bg = "default", offset = 0;
  const cells = [];
  while (offset < line.length) {
    if (line.startsWith("\x1b]", offset)) {
      const end = line.indexOf("\x07", offset);
      if (end >= 0) { offset = end + 1; continue; }
    }
    const sequence = /^\x1b\[([0-9;:]*)m/.exec(line.slice(offset));
    if (sequence) {
      const fields = sequence[1].split(";");
      for (let i = 0; i < fields.length; i++) {
        const code = Number(fields[i]);
        if (code === 0 || code === 49) bg = "default";
        else if (code === 38 || code === 48 || code === 58) {
          const count = fields[i + 1] === "2" ? 4 : 2;
          if (code === 48) bg = fields.slice(i + 1, i + 1 + count).join(";");
          i += count;
        } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = "index:" + code;
      }
      offset += sequence[0].length; continue;
    }
    const char = String.fromCodePoint(line.codePointAt(offset));
    for (let column = 0; column < visibleWidth(char); column++) cells.push(bg);
    offset += char.length;
  }
  return cells;
}
function setup(themeName) {
  const theme = getThemeByName(themeName), style = agentsStyle(theme);
  let height = 40;
  const overlay = new AgentsOverlay({ style, keybindings: new KeybindingsManager(TUI_KEYBINDINGS), terminalRows: () => height,
    done() {}, refresh() {}, requestRender() {} });
  const rows = [
    { key: "pi", app: "Pi", state: "done", title: "pi-rex", message: "", cwd: "/project", current: true,
      sessionId: "project", sessionLabel: "pi-cmux", windowId: "tab", windowLabel: "Window 533ea343", blockId: "pi-pane", pid: 1 },
    { key: "claude", app: "Claude", state: "unknown", title: "Claude Code", message: "No native status", cwd: "/project",
      sessionId: "project", sessionLabel: "pi-cmux", windowId: "tab", windowLabel: "Window 533ea343", blockId: "claude-pane", pid: 2 },
  ];
  return { theme, style, overlay, rows, height: value => { height = value; } };
}
for (const themeName of ["light", "dark"]) test(`${themeName} overlay is opaque over green tool output in every view`, () => {
  const a = setup(themeName);
  const neutral = backgrounds(a.theme.bg("toolPendingBg", "x"))[0];
  const selected = backgrounds(a.theme.bg("selectedBg", "x"))[0];
  assert.notEqual(neutral, "default");
  const check = width => {
    for (const line of a.overlay.render(width)) {
      assert.equal(visibleWidth(line.replaceAll(CURSOR_MARKER, "")), width);
      const base = a.theme.bg("toolSuccessBg", "UNDERLAY ".repeat(30));
      const combined = compositeTuiLine(base, line, 3, width, width + 6);
      const cells = backgrounds(combined).slice(3, 3 + width);
      assert.equal(cells.length, width);
      assert.ok(cells.every(bg => bg === neutral || bg === selected), "inherited/default background leaked into overlay");
    }
  };
  check(72); // loading, frame, search and empty padding
  a.overlay.setList({ rows: a.rows, unavailable: 0 }); check(72);
  a.overlay.handleInput("\x1b[B"); check(72); // selected/unselected colors restore to the same neutral base
  a.overlay.setList({ rows: [], unavailable: 0 }); check(72);
  a.overlay.setError("Read failed"); check(72);
  a.overlay.setList({ rows: a.rows, unavailable: 0 });
  check(30); // unframed narrow view
  a.height(7); check(72); // compact breadcrumb view
  a.height(4); check(72); check(1); // resize placeholder
});
test("surface restores colors after resets without confusing zero RGB channels with a reset", () => {
  const { theme, style } = setup("light"), neutral = backgrounds(theme.bg("toolPendingBg", "x"))[0];
  const painted = style.surface("\x1b[48;2;0;64;0mX\x1b[49mY\x1b[0mZ");
  assert.deepEqual(backgrounds(painted), ["2;0;64;0", neutral, neutral]);
  assert.deepEqual(backgrounds(style.surface("\x1b[0;48;2;0;64;0mX\x1b[49mY")), ["2;0;64;0", neutral]);
});
