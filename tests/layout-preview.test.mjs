import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { builtInLayout } from "../lib/layouts.ts";
import { renderLayoutPreview } from "../lib/layout-preview.ts";

const spec = (name = "observe") => {
  const layout = builtInLayout(name);
  return { version: layout.version, root: layout.root };
};
const lines = value => value.split("\n");

test("Observe preview shows Pi above a shell and a monitor shell on the right", () => {
  const output = renderLayoutPreview("observe", spec(), { width: 80, height: 20 });
  const rows = lines(output);
  assert.equal(rows[0], "Layout: observe");
  assert.equal(rows.length, 20);
  assert.ok(rows.every(row => row.length <= 80));
  const piRow = rows.findIndex(row => row.includes("current Pi"));
  const deployRow = rows.findIndex(row => row.includes("Shell"));
  const monitorRow = rows.findIndex(row => row.includes("Monitor shell"));
  assert.ok(piRow >= 0 && deployRow > piRow);
  assert.equal(piRow, monitorRow);
  assert.ok(rows[piRow].indexOf("Monitor shell") > rows[piRow].indexOf("current Pi"));
  assert.match(output, /● Pi · current Pi/);
});

test("a user-defined single-pane spec renders one current-Pi box", () => {
  const single = { version: 1, root: { type: "terminal", title: "Pi", role: "pi", source: "current" } };
  const output = renderLayoutPreview("single", single, { width: 40, height: 8 });
  assert.match(output, /Layout: single/);
  assert.match(output, /Pi · current Pi/);
  assert.equal(lines(output).length, 8);
});

test("narrow or ratio-constrained layouts degrade to a bounded structural tree", () => {
  const narrow = renderLayoutPreview("observe", spec(), { width: 20, height: 12 });
  assert.match(narrow, /Row 50%/);
  assert.match(narrow, /Column 65%/);
  assert.match(narrow, /Shell/);
  assert.ok(lines(narrow).length <= 12);
  assert.ok(lines(narrow).every(row => row.length <= 20));
  const constrained = renderLayoutPreview("observe", spec(), { width: 24, height: 6 });
  assert.match(constrained, /Row 50%/);
});

test("long titles are clipped and output dimensions are bounded", () => {
  const layout = { version: 1, root: { type: "terminal", title: "x".repeat(120), focus: true } };
  const output = renderLayoutPreview("a-name-that-is-too-long".repeat(10), layout, { width: 18, height: 4 });
  assert.ok(lines(output).length <= 4);
  assert.ok(lines(output).every(row => row.length <= 18));
  assert.ok(!output.includes("x".repeat(19)));
});

test("Unicode titles and combining characters stay within terminal columns", () => {
  const spec = { version: 1, root: { type: "terminal", title: "運用 🚀 é 確認 ".repeat(8) } };
  for (const width of [1, 10, 18, 40, 80]) {
    const output = renderLayoutPreview("unicode", spec, { width, height: 8 });
    assert.ok(output.split("\n").every(line => visibleWidth(line) <= width));
  }
});

test("preview validates input and supports very small dimensions", () => {
  assert.equal(renderLayoutPreview("x", spec("build"), { width: 1, height: 1 }), "…");
  assert.throws(() => renderLayoutPreview("bad", { version: 1, root: null }), /object/);
});
