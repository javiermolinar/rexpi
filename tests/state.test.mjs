import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOOTSTRAP_ENV, LEASE_MS, childBootstrap, decodeBootstrap, encodeBootstrap, isLive, parseBinding,
  parseOrientation, restoreOrientation, rootOrientation, sameIdentity } from "../lib/state.ts";
import { BindingStore } from "../lib/store.ts";
import { binding, identity, rid, sandbox, server, uuid } from "./fixtures.mjs";

test("bootstrap round-trips exact child and parent identity", () => {
  const parent = rootOrientation("custom-session-1");
  const related = childBootstrap(parent, true, "review", server);
  assert.equal(related.taskId, parent.taskId);
  assert.notEqual(related.conversationId, parent.conversationId);
  assert.notEqual(related.piSessionId, parent.piSessionId);
  assert.deepEqual(decodeBootstrap(encodeBootstrap(related)), related);
  assert.ok(sameIdentity(related.origin, parent));
  assert.notEqual(childBootstrap(parent, false, "chat", server).taskId, parent.taskId);
  assert.equal(BOOTSTRAP_ENV, "PI_REX_BOOTSTRAP");
});
test("malformed, oversized, and traversal-shaped identities are rejected", () => {
  for (const input of ["!", "a".repeat(5000), Buffer.from("{}").toString("base64url")]) assert.throws(() => decodeBootstrap(input));
  assert.throws(() => parseBinding({ ...binding(), token: "../escape" }));
  assert.throws(() => parseOrientation({ ...rootOrientation("root"), role: "continue" }));
});
test("only the latest owner-matching entry on the supplied active branch is restored", () => {
  const first = rootOrientation("owner"), second = rootOrientation("owner");
  const entry = data => ({ type: "custom", customType: "pi-rex.orientation", data });
  assert.deepEqual(restoreOrientation([entry(first), entry(second)], "owner"), second);
  assert.equal(restoreOrientation([entry(first)], "forked-owner"), undefined);
  assert.throws(() => restoreOrientation([entry({ ...first, taskId: "broken" })], "owner"));
});
test("leases reject expiration, future timestamps, server restart and dead PID", () => {
  const b = binding();
  assert.ok(isLive(b, server));
  assert.equal(isLive({ ...b, expiresAt: Date.now() - 1 }, server), false);
  assert.equal(isLive({ ...b, expiresAt: Date.now() + LEASE_MS + 2000 }, server), false);
  assert.equal(isLive(b, { ...server, instanceId: uuid() }), false);
  assert.equal(isLive(b, server, Date.now(), () => false), false);
});
test("store writes private files and removes only the owning token", t => {
  const store = new BindingStore(join(sandbox(t), "bindings")), b = binding();
  store.write(b);
  assert.equal(statSync(store.directory).mode & 0o777, 0o700);
  const file = join(store.directory, readdirSync(store.directory)[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(store.find(b, server), b);
  store.remove(b.conversationId, uuid());
  assert.equal(existsSync(file), true);
  store.remove(b.conversationId, b.token);
  assert.equal(existsSync(file), false);
});
test("duplicate live conversations are ambiguous; expired copies do not win", t => {
  const store = new BindingStore(join(sandbox(t), "bindings")), b = binding();
  store.write(b); store.write({ ...b, token: uuid(), blockId: rid("block") });
  assert.throws(() => store.find(b, server), /multiple/);
});
test("different conversations competing for one pane fail closed immediately", t => {
  const store = new BindingStore(join(sandbox(t), "bindings")), b = binding();
  store.write(b);
  store.write(binding(identity(), { blockId: b.blockId }));
  assert.throws(() => store.find(b, server), /competing/);
});
test("shutdown cleanup never recreates a deleted state directory", t => {
  const root = sandbox(t), store = new BindingStore(join(root, "bindings")), b = binding();
  store.write(b);
  rmSync(store.directory, { recursive: true });
  store.remove(b.conversationId, b.token);
  assert.equal(existsSync(store.directory), false);
});
test("store refuses permissive directories and symlink ancestors before writing outside", t => {
  const root = sandbox(t), loose = join(root, "loose");
  mkdirSync(loose, { mode: 0o755 }); chmodSync(loose, 0o755);
  assert.throws(() => new BindingStore(loose).all(), /private/);
  const destination = join(root, "outside"); mkdirSync(destination);
  symlinkSync(destination, join(root, "linked"));
  assert.throws(() => new BindingStore(join(root, "linked", "new")).write(binding()), /symlink/);
  assert.equal(existsSync(join(destination, "new")), false);
});
test("store does not follow binding-file symlinks or accept oversized/corrupt files", t => {
  const root = sandbox(t), store = new BindingStore(join(root, "bindings")), b = binding();
  store.write(b);
  const file = join(store.directory, b.conversationId + "." + b.token + ".json");
  writeFileSync(file, "{broken");
  assert.equal(store.find(b, server), undefined);
  writeFileSync(file, "x".repeat(5000));
  assert.equal(store.find(b, server), undefined);
  const outside = join(root, "secret");
  writeFileSync(outside, JSON.stringify(b), { mode: 0o600 });
  const other = { ...b, token: uuid() };
  symlinkSync(outside, join(store.directory, other.conversationId + "." + other.token + ".json"));
  assert.equal(store.find(b, server), undefined);
  assert.equal(readFileSync(outside, "utf8"), JSON.stringify(b));
});
