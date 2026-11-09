import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LayoutsOverlay } from "../lib/layouts-overlay.ts";
import { builtInLayouts } from "../lib/layouts.ts";

function fixture(mode = "picker", rows = 40) {
  const finished = [];
  let refreshed = 0;
  const overlay = new LayoutsOverlay({ mode, terminalRows: () => rows,
    keybindings: { matches: (data, action) => data === action }, requestRender() {},
    refresh() { refreshed++; }, done(value) { finished.push(value); } });
  return { overlay, finished, refreshed: () => refreshed };
}
const key = action => `tui.select.${action}`;
test("built-in/user groups, search, selection and live Observe preview", () => {
  const { overlay, finished } = fixture();
  overlay.setList([...builtInLayouts(), { ...builtInLayouts()[0], name: "personal", origin: "user" }]);
  assert.match(overlay.render(110).join("\n"), /Built-in layouts/);
  assert.match(overlay.render(110).join("\n"), /User layouts/);
  overlay.handleInput(key("down")); overlay.handleInput(key("down"));
  const wide = overlay.render(110).join("\n");
  assert.match(wide, /observe/); assert.match(wide, /Monitor shell/); assert.match(wide, / │ /);
  overlay.handleInput("personal");
  assert.equal(overlay.selectedRow()?.name, "personal");
  overlay.handleInput(key("confirm"));
  assert.equal(finished[0]?.name, "personal");
  overlay.handleInput(key("confirm")); assert.equal(finished.length, 1);
});
test("cancel never returns a layout; propagated search focus", () => {
  const { overlay, finished } = fixture(); overlay.setList(builtInLayouts());
  overlay.focused = true; assert.equal(overlay.input.focused, true);
  overlay.handleInput(key("cancel")); assert.deepEqual(finished, [undefined]);
});
test("current preview is read only, Enter and Escape close without opening", () => {
  for (const action of ["confirm", "cancel"]) {
    const { overlay, finished } = fixture("preview");
    overlay.setList([{ ...builtInLayouts()[0], name: "current" }]);
    overlay.focused = true; assert.equal(overlay.input.focused, false);
    overlay.handleInput("changed"); assert.equal(overlay.selectedRow()?.name, "current");
    assert.match(overlay.render(70).join("\n"), /Layout: current/);
    overlay.handleInput(key(action)); assert.deepEqual(finished, [undefined]);
  }
});
test("narrow terminals stay width bounded and stack preview", () => {
  const { overlay } = fixture(); overlay.setList(builtInLayouts());
  overlay.handleInput(key("down")); overlay.handleInput(key("down"));
  assert.match(overlay.render(45).join("\n"), /Layout: observe/);
  for (const width of [1, 8, 25, 45, 80, 110])
    for (const line of overlay.render(width)) assert.ok(visibleWidth(line) <= width);
});
test("loading, empty, errors, no matches and manual refresh", () => {
  const { overlay, refreshed } = fixture();
  assert.match(overlay.render(100).join("\n"), /Loading/);
  overlay.setList([]); assert.match(overlay.render(100).join("\n"), /No layouts/);
  overlay.setError(new Error("Cannot read layouts")); assert.match(overlay.render(100).join("\n"), /Cannot read layouts/);
  overlay.setList(builtInLayouts()); overlay.handleInput("missing");
  assert.match(overlay.render(100).join("\n"), /No matching/);
  overlay.handleInput("\x12"); assert.equal(refreshed(), 1);
});
