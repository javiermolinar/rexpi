import test from "node:test";
import assert from "node:assert/strict";
import { Rex } from "../lib/rex.ts";
import { Runtime } from "../lib/runtime.ts";
import { childBootstrap, rootOrientation } from "../lib/state.ts";
import { active, binding, rid, uuid } from "./fixtures.mjs";

test("runtime publishes exact identity, restores it on reload, and releases its lease", async t => {
  const a = await active(t);
  const first = a.runtime.snapshot();
  assert.equal(a.store.find(first.state, first.server).blockId, a.w.source.blockId);
  a.runtime.stop();
  assert.equal(a.store.find(first.state, first.server), undefined);
  await a.runtime.start(a.ctx, () => assert.fail("restored metadata must not be appended again"));
  assert.deepEqual(a.runtime.snapshot().state, first.state);
});
test("fork/new owners get fresh identity rather than inheriting the parent's origin", async t => {
  const parent = rootOrientation("other-session");
  const a = await active(t, { entries: [{ type: "custom", customType: "pi-rex.orientation", data: parent }] });
  assert.notEqual(a.runtime.snapshot().state.conversationId, parent.conversationId);
  assert.equal(a.runtime.snapshot().state.origin, undefined);
});
test("bootstrap must match the precise Pi session and server instance", async t => {
  const a = await active(t), own = a.runtime.snapshot();
  a.runtime.stop();
  const seed = childBootstrap(own.state, true, "review", own.server);
  await assert.rejects(a.runtime.start(a.ctx, () => {}, seed), /does not match/);
  const rightOwner = { ...a.ctx, sessionManager: { getSessionId: () => seed.piSessionId, getBranch: () => [] } };
  await assert.rejects(a.runtime.start(rightOwner, () => {}, { ...seed, serverInstance: uuid() }), /does not match/);
});
test("headless initialization performs no Rex calls and creates no binding", async t => {
  const a = await active(t);
  a.runtime.stop();
  const before = a.w.calls.length;
  await a.runtime.start({ ...a.ctx, mode: "print" }, () => assert.fail("must not persist"));
  assert.equal(a.w.calls.length, before);
  assert.throws(() => a.runtime.snapshot(), /No verified/);
});
test("a second runtime cannot overwrite an existing live pane claim", async t => {
  const a = await active(t), rival = new Runtime(new Rex("/bin/echo", a.w.exec), a.store, a.w.source.blockId);
  t.after(() => rival.stop());
  await assert.rejects(rival.start(a.ctx, () => {}), /already claims/);
  assert.ok(a.runtime.snapshot());
});
test("shutdown during asynchronous startup cannot publish a late lease", async t => {
  const a = await active(t);
  a.runtime.stop();
  const original = a.rex.initialize.bind(a.rex);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  a.rex.initialize = async (...args) => { const value = await original(...args); await gate; return value; };
  const starting = a.runtime.start(a.ctx, () => assert.fail("stopped initialization persisted"));
  await new Promise(resolve => setImmediate(resolve));
  a.runtime.stop(); release();
  await assert.rejects(starting);
  assert.equal(a.store.all().length, 0);
});
async function family(t, sameSession = false) {
  const a = await active(t);
  const parent = a.runtime.snapshot();
  const seed = childBootstrap(parent.state, true, "review", parent.server);
  const childTarget = { sessionId: sameSession ? a.w.source.sessionId : rid("session"), windowId: rid("window"), blockId: rid("block"), owner: a.w.source.owner };
  a.w.blocks.set(childTarget.blockId, childTarget); a.w.callerBlock = childTarget.blockId;
  const child = new Runtime(new Rex("/bin/echo", a.w.exec), a.store, childTarget.blockId);
  t.after(() => child.stop());
  const ctx = { ...a.ctx, sessionManager: { getSessionId: () => seed.piSessionId, getBranch: () => [] } };
  await child.start(ctx, () => {}, seed);
  return { ...a, child, parent, seed, childTarget };
}
test("return focuses the exact live parent conversation", async t => {
  const a = await family(t);
  const target = await a.child.returnToOrigin();
  assert.equal(target.blockId, a.w.source.blockId);
  assert.equal(a.w.selected.blockId, target.blockId);
  assert.equal(a.w.focusCalls, 1);
});
test("same-session return uses only server focus, even with Remote Control off and no app client", async t => {
  const a = await family(t, true);
  a.w.remoteControl = false; a.w.apps = [];
  const target = await a.child.returnToOrigin();
  assert.equal(target.blockId, a.w.source.blockId);
  assert.equal(a.w.focusCalls, 1);
  assert.equal(a.w.selectCalls ?? 0, 0);
  assert.equal(a.w.calls.some(c => c.includes("actions") || c.includes("client")), false);
});
test("cross-session return requires app Remote Control and never falls back after rejection", async t => {
  const a = await family(t);
  a.w.remoteControl = false;
  await assert.rejects(a.child.returnToOrigin(), /Remote Control is disabled/);
  assert.equal(a.w.selectCalls, 1);
  assert.equal(a.w.focusCalls ?? 0, 0);
});
test("return resolves a parent's current block/window rather than saved coordinates", async t => {
  const a = await family(t);
  const lease = a.store.find(a.parent.state, a.parent.server);
  const moved = { ...a.w.source, blockId: rid("block"), windowId: rid("window") };
  a.w.blocks.delete(a.w.source.blockId); a.w.blocks.set(moved.blockId, moved);
  a.store.write({ ...lease, blockId: moved.blockId });
  assert.equal((await a.child.returnToOrigin()).blockId, moved.blockId);
});
test("a reused pane cannot impersonate the parent conversation", async t => {
  const a = await family(t), lease = a.store.find(a.parent.state, a.parent.server);
  a.store.remove(lease.conversationId, lease.token);
  a.store.write(binding(rootOrientation("replacement"), { blockId: a.w.source.blockId }));
  await assert.rejects(a.child.returnToOrigin(), /closed, stale, or unavailable/);
  assert.equal(a.w.focusCalls ?? 0, 0);
  assert.equal(a.w.selectCalls ?? 0, 0);
});
test("expired parent evidence never causes a focus fallback", async t => {
  const a = await family(t), lease = a.store.find(a.parent.state, a.parent.server);
  a.store.write({ ...lease, expiresAt: Date.now() - 1 });
  await assert.rejects(a.child.returnToOrigin(), /closed, stale, or unavailable/);
  assert.equal(a.w.selectCalls ?? 0, 0);
});
test("ambiguous parents never cause a focus fallback", async t => {
  const a = await family(t), lease = a.store.find(a.parent.state, a.parent.server);
  a.store.write({ ...lease, token: uuid(), blockId: rid("block") });
  await assert.rejects(a.child.returnToOrigin(), /multiple/);
  assert.equal(a.w.selectCalls ?? 0, 0);
});
test("parent replacement during preflight is caught before UI mutation", async t => {
  const a = await family(t), lease = a.store.find(a.parent.state, a.parent.server);
  a.w.onActions = () => {
    a.store.remove(lease.conversationId, lease.token);
    a.store.write({ ...lease, token: uuid() });
  };
  await assert.rejects(a.child.returnToOrigin(), /changed during return/);
  assert.equal(a.w.selectCalls ?? 0, 0);
});
test("stopped source snapshots cannot authorize navigation or launches", async t => {
  const a = await active(t), snapshot = a.runtime.snapshot();
  a.runtime.stop();
  assert.throws(() => a.runtime.assert(snapshot));
  await assert.rejects(a.runtime.source(snapshot));
});
