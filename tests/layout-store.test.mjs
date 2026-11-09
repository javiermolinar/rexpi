import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LayoutStore } from "../lib/layout-store.ts";

const pi = { type: "terminal", title: "Pi", role: "pi", source: "current", focus: true };
const shell = { type: "terminal", title: "Shell" };
const spec = { version: 1, root: {
  type: "split", direction: "row", ratio: 0.6, before: pi, after: shell,
} };
function harness(t) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), "rexpi-layout-store-"));
  chmodSync(parent, 0o700);
  t.after(() => { chmodSync(parent, 0o700); });
  const directory = join(parent, "layouts");
  return { parent, directory, store: new LayoutStore(directory) };
}

test("the catalog includes built-ins and persists user layouts across store instances", t => {
  const h = harness(t), store = h.store;
  assert.deepEqual(store.list().map(layout => layout.name), ["build", "inspect", "observe"]);
  const saved = store.save("ops", spec);
  assert.equal(saved.origin, "user");
  assert.equal(saved.name, "ops");
  assert.deepEqual(store.get("ops"), saved);
  assert.deepEqual(new LayoutStore(h.directory).get("ops"), saved);
  assert.deepEqual(store.list().map(layout => layout.name), ["build", "inspect", "observe", "ops"]);
  assert.equal(readdirSync(h.directory).filter(name => name.endsWith(".tmp")).length, 0);
  assert.equal(JSON.parse(readFileSync(join(h.directory, "ops.json"), "utf8")).origin, undefined);
});

test("save validates before writing and never executes layout commands", t => {
  const h = harness(t), marker = join(h.parent, "executed");
  assert.throws(() => h.store.save("ops", { version: 1, root: {
    ...shell, command: ["touch", marker], unknown: true,
  } }));
  assert.throws(() => h.store.save("../ops", spec));
  assert.equal(existsSync(marker), false);
  assert.deepEqual(h.store.list().map(layout => layout.name), ["build", "inspect", "observe"]);
});

test("overwrites and deletion are explicit and built-ins are protected", t => {
  const h = harness(t), store = h.store;
  store.save("ops", spec);
  assert.throws(() => store.save("ops", spec), /already exists/);
  assert.throws(() => store.save("ops", spec, { overwrite: false }), /already exists/);
  const replacement = { version: 1, root: { ...shell, title: "Replacement" } };
  assert.equal(store.save("ops", replacement, { overwrite: true }).root.title, "Replacement");
  assert.equal(store.get("ops").root.title, "Replacement");
  for (const name of ["build", "inspect", "observe"]) {
    assert.throws(() => store.save(name, spec), /built-in/);
    assert.throws(() => store.save(name, spec, { overwrite: true }), /built-in/);
    assert.throws(() => store.remove(name), /built-in/);
  }
  assert.equal(store.remove("ops").name, "ops");
  assert.throws(() => store.get("ops"));
});

test("removed built-in names are available for explicit user layouts", t => {
  const { store } = harness(t);
  for (const name of ["focus", "sre"]) {
    assert.throws(() => store.get(name), { code: "ENOENT" });
    assert.equal(store.save(name, spec).origin, "user");
    assert.equal(store.remove(name).name, name);
  }
});

test("layout filenames and stored names must agree", t => {
  const h = harness(t);
  mkdirSync(h.directory, { mode: 0o700 });
  writeFileSync(join(h.directory, "ops.json"), JSON.stringify({ name: "other", ...spec }), { mode: 0o600 });
  assert.throws(() => h.store.get("ops"), /filename and stored name differ/);
  assert.throws(() => h.store.list(), /filename and stored name differ/);
});

test("corrupt, oversized, and non-private layout files fail closed", t => {
  const h = harness(t);
  mkdirSync(h.directory, { mode: 0o700 });
  const path = join(h.directory, "ops.json");
  writeFileSync(path, "not json", { mode: 0o600 });
  assert.throws(() => h.store.get("ops"), SyntaxError);
  writeFileSync(path, JSON.stringify({ name: "ops", ...spec }), { mode: 0o600 });
  chmodSync(path, 0o644);
  assert.throws(() => h.store.get("ops"), /private regular files/);
  chmodSync(path, 0o600);
  writeFileSync(path, "x".repeat(257 * 1024), { mode: 0o600 });
  assert.throws(() => h.store.get("ops"), /private regular files/);
});

test("symlinked directories and files are rejected", t => {
  const h = harness(t);
  mkdirSync(h.directory, { mode: 0o700 });
  h.store.save("ops", spec);
  const file = join(h.directory, "ops.json"), link = join(h.directory, "linked.json");
  symlinkSync(file, link);
  assert.throws(() => h.store.get("linked"));
  const other = join(h.parent, "other");
  mkdirSync(other, { mode: 0o700 });
  const linkedDirectory = join(h.parent, "linked-layouts");
  symlinkSync(h.directory, linkedDirectory);
  assert.throws(() => new LayoutStore(linkedDirectory).list(), /symlink/);
});

test("oversized serialized definitions are rejected before publication", t => {
  const h = harness(t);
  let nodes = Array.from({ length: 16 }, () => ({ type: "terminal", title: "Large", command: ["/bin/echo", ...Array(7).fill("x".repeat(4096))] }));
  while (nodes.length > 1) {
    const parents = [];
    for (let i = 0; i < nodes.length; i += 2)
      parents.push({ type: "split", direction: "row", ratio: 0.5, before: nodes[i], after: nodes[i + 1] });
    nodes = parents;
  }
  assert.throws(() => h.store.save("large", { version: 1, root: nodes[0] }), /storage byte limit/);
  assert.equal(existsSync(join(h.directory, "large.json")), false);
});

test("user layout ordering is deterministic", t => {
  const h = harness(t);
  for (const name of ["zeta", "alpha", "middle"]) h.store.save(name, spec);
  assert.deepEqual(h.store.list().map(layout => layout.name), ["build", "inspect", "observe", "alpha", "middle", "zeta"]);
});
