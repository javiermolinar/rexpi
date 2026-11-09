import test from "node:test";
import assert from "node:assert/strict";
import { builtInLayout, builtInLayouts, layoutTerminals, parseLayoutName, parseLayoutSpec,
  MAX_LAYOUT_DEPTH, MAX_LAYOUT_PANES } from "../lib/layouts.ts";

const pi = { type: "terminal", title: "Pi", role: "pi", source: "current", focus: true };
const shell = { type: "terminal", title: "Shell" };
const monitor = { type: "terminal", title: "Monitor shell" };
const observe = { version: 1, root: {
  type: "split", direction: "row", ratio: 0.5,
  before: { type: "split", direction: "column", ratio: 0.65, before: pi, after: shell },
  after: monitor,
} };

test("built-ins are workflow layouts, without redundant focus or legacy sre", () => {
  assert.deepEqual(builtInLayouts().map(layout => layout.name), ["build", "inspect", "observe"]);
  for (const name of ["focus", "sre", "agent-swarm"]) assert.equal(builtInLayout(name), undefined);
  for (const layout of builtInLayouts()) {
    const parsed = parseLayoutSpec({ version: layout.version, root: layout.root });
    const terminals = layoutTerminals(parsed.root);
    assert.equal(terminals.filter(leaf => leaf.role === "pi").length, 1);
    assert.deepEqual(terminals.find(leaf => leaf.role === "pi"), pi);
    for (const terminal of terminals) {
      assert.equal(terminal.command, undefined);
      assert.equal(terminal.shell, undefined);
      assert.equal(terminal.cwd, undefined);
    }
  }
});

test("build puts current Pi left and an editor shell above a shell on the right", () => {
  assert.deepEqual(builtInLayout("build").root, {
    type: "split", direction: "row", ratio: 0.5, before: pi,
    after: { type: "split", direction: "column", ratio: 0.65,
      before: { type: "terminal", title: "Editor shell" }, after: shell },
  });
});

test("inspect puts a review shell next to the current Pi", () => {
  assert.deepEqual(builtInLayout("inspect").root, {
    type: "split", direction: "row", ratio: 0.5, before: pi,
    after: { type: "terminal", title: "Review shell" },
  });
});

test("observe puts Pi above a shell on the left and a monitor shell full height right", () => {
  const layout = builtInLayout("observe");
  assert.deepEqual({ version: layout.version, root: layout.root }, observe);
});

test("built-ins and parsed layouts are independent validated values", () => {
  const first = builtInLayout("observe"), second = builtInLayout("observe");
  assert.notEqual(first, second);
  assert.notEqual(first.root, second.root);
  first.root.ratio = 0.9;
  assert.equal(second.root.ratio, 0.5);
  assert.equal(builtInLayout("observe").root.ratio, 0.5);
  for (const name of ["build", "inspect"]) {
    const copy = builtInLayout(name);
    const terminal = layoutTerminals(copy.root).find(leaf => !leaf.role);
    terminal.title = "changed";
    terminal.command = ["custom-editor"];
    assert.ok(!JSON.stringify(builtInLayout(name)).includes("changed"));
  }
  assert.deepEqual(parseLayoutSpec(observe), observe);
  assert.notEqual(parseLayoutSpec(observe).root, observe.root);
});

test("split ratios default to one half and terminals preserve literal commands", () => {
  const parsed = parseLayoutSpec({ version: 1, root: {
    type: "split", direction: "row", before: shell,
    after: { type: "terminal", title: "Tool", command: ["printf", "", "a b"], cwd: "/tmp", keepOpen: true },
  } });
  assert.equal(parsed.root.ratio, 0.5);
  assert.deepEqual(parsed.root.after.command, ["printf", "", "a b"]);
  assert.equal(parsed.root.after.keepOpen, true);
  assert.equal(layoutTerminals(parsed.root).length, 2);
});

test("layout names are lowercase, bounded, and never path syntax", () => {
  for (const name of ["a", "observe", "release-2", "a".repeat(64)]) assert.equal(parseLayoutName(name), name);
  for (const name of ["", "OBSERVE", "1observe", "-observe", "observe-", "../observe", "a/b", "a b", "a".repeat(65), null])
    assert.throws(() => parseLayoutName(name));
});

test("layout specs reject unsupported fields and transient identities", () => {
  for (const value of [
    { ...observe, blockId: "block:123" },
    { ...observe, conversationId: "conversation" },
    { version: 2, root: pi },
    { version: 1, root: { ...pi, blockId: "block:123" } },
    { version: 1, root: { ...pi, sessionId: "session:123" } },
    { version: 1, root: { type: "split", direction: "row", before: shell, after: monitor, processId: 1 } },
  ]) assert.throws(() => parseLayoutSpec(value));
});

test("terminal leaves reject invalid commands, controls, and Pi launch overrides", () => {
  for (const terminal of [
    { type: "terminal" },
    { ...shell, title: "" },
    { ...shell, title: "bad\nname" },
    { ...shell, command: [] },
    { ...shell, command: "printf" },
    { ...shell, command: ["printf"], shell: "exec printf" },
    { ...shell, keepOpen: "yes" },
    { ...shell, focus: 1 },
    { ...shell, role: "agent", source: "current" },
    { ...shell, role: "pi" },
    { ...shell, source: "current" },
    { ...pi, command: ["pi"] },
    { ...pi, cwd: "/tmp" },
    { ...pi, keepOpen: true },
  ]) assert.throws(() => parseLayoutSpec({ version: 1, root: terminal }));
});

test("splits reject malformed ratios, directions, and children", () => {
  for (const root of [
    { type: "split", direction: "horizontal", before: shell, after: monitor },
    { type: "split", direction: "row", ratio: 0, before: shell, after: monitor },
    { type: "split", direction: "row", ratio: 1, before: shell, after: monitor },
    { type: "split", direction: "row", ratio: NaN, before: shell, after: monitor },
    { type: "split", direction: "row", before: shell },
    { type: "other", before: shell, after: monitor },
    null, [],
  ]) assert.throws(() => parseLayoutSpec({ version: 1, root }));
});

test("a layout permits at most one current Pi and one focused terminal", () => {
  assert.throws(() => parseLayoutSpec({ version: 1, root: {
    type: "split", direction: "row", before: pi, after: { ...pi, focus: false },
  } }), /at most one current-Pi/);
  assert.throws(() => parseLayoutSpec({ version: 1, root: {
    type: "split", direction: "row", before: { ...shell, focus: true }, after: { ...monitor, focus: true },
  } }), /at most one focused/);
});

test("depth and pane bounds fail closed", () => {
  let deep = shell;
  for (let index = 0; index < MAX_LAYOUT_DEPTH; index++)
    deep = { type: "split", direction: "row", before: deep, after: shell };
  assert.throws(() => parseLayoutSpec({ version: 1, root: deep }), /maximum depth/);
  let panes = Array.from({ length: MAX_LAYOUT_PANES + 1 }, () => shell);
  while (panes.length > 1) {
    const parents = [];
    for (let index = 0; index < panes.length; index += 2)
      parents.push(index + 1 < panes.length
        ? { type: "split", direction: "row", before: panes[index], after: panes[index + 1] }
        : panes[index]);
    panes = parents;
  }
  assert.throws(() => parseLayoutSpec({ version: 1, root: panes[0] }), /maximum pane count/);
});
