import test from "node:test";
import assert from "node:assert/strict";
import { captureActiveLayout, captureRexWindow } from "../lib/layout-capture.ts";

const id = (kind, n) => kind + ":00000000-0000-0000-0000-" + String(n).padStart(12, "0");
const pi = id("block", 1), deploy = id("block", 2), k9s = id("block", 3);
const rect = [0, 0, 1, 1];
const leaf = block => ({ rect, block_id: block });
const split = (n, direction, ratio, before, after) => ({ rect, split: {
  split_id: id("split", n), direction, ratio, before, after,
} });
const block = (id, label, extra = {}) => ({ block_id: id, label,
  creator_name: "com.superlogical.terminal", flavor: "com.superlogical.terminal.shell", ...extra });
function view(overrides = {}) {
  return {
    active_window_id: id("window", 1),
    windows: [{
      window_id: id("window", 1), label: "Operations", focused_block_id: pi,
      layers: [{ kind: "tiled", layout: split(1, "horizontal", 0.5,
        split(2, "vertical", 0.65, leaf(pi), leaf(deploy)), leaf(k9s)),
        blocks: [block(pi, "Pi"), block(deploy, "Shell"), block(k9s, "k9s")] }],
    }], ...overrides,
  };
}

test("capture maps nested Rex geometry, focus, and the verified current Pi", () => {
  const captured = captureRexWindow(view(), pi);
  assert.equal(captured.windowLabel, "Operations");
  assert.deepEqual(captured.shellFallbacks, ["Shell", "k9s"]);
  assert.deepEqual(captured.spec, { version: 1, root: {
    type: "split", direction: "row", ratio: 0.5,
    before: { type: "split", direction: "column", ratio: 0.65,
      before: { type: "terminal", title: "Pi", role: "pi", source: "current", focus: true },
      after: { type: "terminal", title: "Shell" } },
    after: { type: "terminal", title: "k9s" },
  } });
  assert.equal(JSON.stringify(captured.spec).includes(pi), false);
});

test("capture uses only declared direct argv and cwd when Rex supplies them", () => {
  const value = view();
  value.windows[0].layers[0].blocks[2] = block(k9s, "k9s", { options: {
    shell: "none", command: ["k9s", "--context", "dev"], cwd: "/tmp", exit: { on_completion: false },
  } });
  const captured = captureRexWindow(value, pi);
  assert.deepEqual(captured.spec.root.after, { type: "terminal", title: "k9s",
    command: ["k9s", "--context", "dev"], cwd: "/tmp", keepOpen: true });
  assert.deepEqual(captured.shellFallbacks, ["Shell"]);
});

test("a current Pi outside the active window is not invented in the captured spec", () => {
  const captured = captureRexWindow(view(), id("block", 99));
  assert.equal(captured.spec.root.before.before.role, undefined);
  assert.deepEqual(captured.shellFallbacks, ["Pi", "Shell", "k9s"]);
});

test("captureActiveLayout performs only exact locate and session view reads", async () => {
  const calls = [];
  const rex = {
    async locate(block, signal) { calls.push(["locate", block, signal]); return { sessionId: id("session", 1), windowId: id("window", 1), blockId: block }; },
    async view(session, signal) { calls.push(["view", session, signal]); return view(); },
  };
  const signal = AbortSignal.timeout(1000);
  const captured = await captureActiveLayout(rex, pi, signal);
  assert.equal(captured.spec.root.before.before.role, "pi");
  assert.deepEqual(calls.map(call => call[0]), ["locate", "view"]);
});

test("capture rejects floating or multiple layers instead of silently dropping content", () => {
  const floating = view();
  floating.windows[0].layers.push({ kind: "floating", layout: leaf(deploy), blocks: [block(deploy, "Other")] });
  assert.throws(() => captureRexWindow(floating, pi), /floating, missing, or multiple/);
  const missing = view();
  missing.windows[0].layers = [];
  assert.throws(() => captureRexWindow(missing, pi), /floating, missing, or multiple/);
});

test("capture rejects nonterminal blocks and duplicate or unknown references", () => {
  const nonterminal = view();
  nonterminal.windows[0].layers[0].blocks[1].flavor = "com.example.editor";
  assert.throws(() => captureRexWindow(nonterminal, pi), /nonterminal/);
  const duplicate = view();
  duplicate.windows[0].layers[0].layout = split(1, "horizontal", 0.5, leaf(pi), leaf(pi));
  assert.throws(() => captureRexWindow(duplicate, pi), /duplicate block reference/);
  const unknown = view();
  unknown.windows[0].layers[0].layout = leaf(id("block", 99));
  assert.throws(() => captureRexWindow(unknown, pi), /unknown block/);
});

test("capture rejects malformed geometry, ratios, directions, and active windows", () => {
  const geometry = view();
  geometry.windows[0].layers[0].layout.rect = [0, 0, 0, 1];
  assert.throws(() => captureRexWindow(geometry, pi), /geometry/);
  const ratio = view();
  ratio.windows[0].layers[0].layout.split.ratio = 1;
  assert.throws(() => captureRexWindow(ratio, pi), /ratio/);
  const direction = view();
  direction.windows[0].layers[0].layout.split.direction = "diagonal";
  assert.throws(() => captureRexWindow(direction, pi), /direction/);
  assert.throws(() => captureRexWindow(view({ active_window_id: id("window", 99) }), pi), /missing or ambiguous/);
});

test("capture rejects duplicate block records and blocks outside the tree", () => {
  const duplicate = view();
  duplicate.windows[0].layers[0].blocks.push(block(pi, "Duplicate"));
  assert.throws(() => captureRexWindow(duplicate, pi), /duplicate blocks/);
  const outside = view();
  outside.windows[0].layers[0].layout = split(1, "horizontal", 0.5, leaf(pi), leaf(deploy));
  assert.throws(() => captureRexWindow(outside, pi), /outside its layout/);
});
