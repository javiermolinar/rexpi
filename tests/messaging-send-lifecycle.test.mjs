// Logical send lifecycle regressions: fixture Rex, temporary storage, no real peers/providers.
import test from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, readdirSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import rexpi from "../extensions/index.ts";
import { registerMessageSend } from "../extensions/messaging.ts";
import { BindingStore } from "../lib/store.ts";
import { endpointFromBinding } from "../lib/messaging/protocol.ts";
import { binding, identity, rid, sandbox, world, uuid } from "./fixtures.mjs";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  const root = sandbox(t), w = world(), events = new Map(), tools = new Map(), commands = new Map(), notices = [];
  const env = { REX_SESSION: w.source.sessionId, REX_BLOCK: w.source.blockId, PI_REX_CLI: "/bin/echo",
    PI_REX_BINARY: "/bin/echo", PI_REX_STATE_DIR: join(root, "bindings"), PI_CODING_AGENT_DIR: root,
    PI_REX_BOOTSTRAP: undefined, PI_REX_RETURN_KEY: "off", PI_REX_AGENTS_KEY: "off" };
  const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : process.env[k] = v;
  const sm = SessionManager.create(root, join(root, "sessions"), { id: "logical-send-fixture" });
  sm.appendMessage({ role: "user", content: "isolated authorized send", timestamp: Date.now() });
  const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: sm,
    isIdle: () => false, hasPendingMessages: () => false,
    ui: { notify: text => notices.push(text), setStatus() {}, getEditorText: () => "" } };
  t.after(() => {
    events.get("session_shutdown")?.({}, ctx);
    for (const [k, v] of Object.entries(prior)) v === undefined ? delete process.env[k] : process.env[k] = v;
  });
  rexpi({ on: (name, fn) => events.set(name, fn), exec: w.exec, registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command), registerShortcut() {},
    getSettings: () => ({}), getCommands: () => [], appendEntry: (type, data) => sm.appendCustomEntry(type, data),
    sendMessage() { assert.fail("Inspection cannot request follow-up work"); } }, { messagingTransport: "sync" });
  await events.get("session_start")({}, ctx);
  const store = new BindingStore(join(root, "bindings")), owner = store.all().find(b => b.blockId === w.source.blockId);
  const peer = binding({ ...identity("review"), taskId: owner.taskId }); store.write(peer);
  w.blocks.set(peer.blockId, { sessionId: w.source.sessionId, windowId: rid("window"), blockId: peer.blockId });
  const params = { to: endpointFromBinding(peer), requestId: "scoped-request", kind: "result", text: "same finding", id: uuid() };
  const inbox = join(root, "pi-rex", "messages", peer.serverInstance, peer.conversationId, "inbox");
  return { root, w, events, tools, commands, notices, sm, ctx, store, owner, peer, params, inbox,
    call: (id, input = params) => tools.get("rex_message_send").execute(id, input, undefined, undefined, ctx),
    async tree() { events.get("session_before_tree")({}, ctx); await events.get("session_tree")({}, ctx); },
    async status() { return (await tools.get("rex_inspect").execute("status", {}, undefined, undefined, ctx)).details.messaging; },
  };
}
function publications(t, failFirst = false) {
  const original = fs.linkSync; let count = 0;
  fs.linkSync = (...args) => {
    count++;
    if (failFirst && count === 1) throw Object.assign(Error("fixture EIO at publication"), { code: "EIO" });
    return original(...args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.linkSync = original; syncBuiltinESMExports(); });
  return () => count;
}

test("logical unknown send survives actual tree replacement and a new tool-call ID without republishing", async t => {
  const f = await fixture(t), links = publications(t, true), first = await f.call("first");
  assert.equal(first.details.state, "unknown"); assert.equal(links(), 1);
  const names = readdirSync(f.inbox).sort(), stable = join(f.inbox, f.params.id + ".json");
  assert.equal(existsSync(stable), false); assert.ok(names.some(name => name.startsWith(".tmp-")));
  assert.deepEqual(await f.call("same-generation"), first); assert.equal(links(), 1);
  await f.tree(); assert.notEqual(f.store.all().find(b => b.blockId === f.w.source.blockId).token, f.owner.token);
  const nativeCalls = f.w.calls.length;
  assert.deepEqual(await f.call("new-tool-call"), first);
  assert.deepEqual(await f.call("first"), first);
  assert.equal(links(), 1); assert.equal(f.w.calls.length, nativeCalls);
  assert.equal(existsSync(stable), false); assert.deepEqual(readdirSync(f.inbox).sort(), names);
  assert.equal((await f.status()).returnRequests, 0);
});

test("logical successful send returns historical evidence after tree even when the peer disappears", async t => {
  const f = await fixture(t), links = publications(t), first = await f.call("first");
  const stable = join(f.inbox, f.params.id + ".json"), body = readFileSync(stable, "utf8");
  assert.equal(first.details.state, "queued"); await f.tree(); f.store.remove(f.peer.conversationId, f.peer.token);
  assert.deepEqual(await f.call("inspect-logical"), first); assert.equal(links(), 1);
  assert.equal(readFileSync(stable, "utf8"), body); assert.equal((await f.status()).returnRequests, 0);
  await assert.rejects(f.call("fresh", { ...f.params, id: uuid() }), /stale|binding|live/i);
});

test("logical rejected send stays rejected after tree and peer repair; only a new UUID is new work", async t => {
  const f = await fixture(t), links = publications(t); f.store.remove(f.peer.conversationId, f.peer.token);
  const error = await f.call("rejected").then(() => assert.fail("Missing peer must reject"), error => error);
  f.store.write(f.peer); await f.tree();
  await assert.rejects(f.call("new-call-same-logical"), value => value === error);
  assert.equal(links(), 0);
  const next = await f.call("new-work", { ...f.params, id: uuid() });
  assert.equal(next.details.state, "queued"); assert.equal(links(), 1);
});

test("logical conflicts across tree cannot acquire replacement sender authority or overwrite old outcomes", async t => {
  const f = await fixture(t), links = publications(t, true), first = await f.call("first"); await f.tree();
  const changes = [{ text: "changed" }, { requestId: "changed" }, { kind: "question" },
    { to: { ...f.params.to, token: uuid() } }, { to: { ...f.params.to, role: "chat" } },
    { to: { ...f.params.to, piSessionId: uuid() } }];
  for (let i = 0; i < changes.length; i++)
    await assert.rejects(f.call("conflict-" + i, { ...f.params, ...changes[i] }), /Conflicting send ID/);
  await assert.rejects(f.call("conflict-0"), /Conflicting send tool-call ID/, "conflicting call outcome is itself fenced");
  assert.deepEqual(await f.call("original-logical"), first); assert.equal(links(), 1);
});

test("pending logical send joins the original attempt across tree and retains its cancellation rejection", async t => {
  const f = await fixture(t), links = publications(t), entered = deferred(), release = deferred();
  t.after(() => release.resolve()); let held = false;
  f.w.onTerminalData = async block => {
    if (block === f.peer.blockId && !held) { held = true; entered.resolve(); await release.promise; }
  };
  const first = f.call("pending").then(value => ({ value }), error => ({ error })); await entered.promise;
  await f.tree();
  const second = f.call("new-pending-call").then(value => ({ value }), error => ({ error }));
  release.resolve(); const [a, b] = await Promise.all([first, second]);
  assert.ok(a.error); assert.equal(b.error, a.error); assert.equal(links(), 0);
  await assert.rejects(f.call("later"), value => value === a.error);
});

// Pure cache tests separate API cache behavior from native/transport validation above.
function cacheFixture(send) {
  let tool, current, gets = 0, observations = 0, sends = 0;
  const original = { observeRun() { observations++; }, send(params) { sends++; return send(params); } };
  current = original;
  registerMessageSend({ registerTool: value => { tool = value; } }, () => { gets++; return current; });
  const params = { to: endpointFromBinding(binding(identity("main"))), requestId: "cache-test", kind: "result", text: "finding", id: uuid() };
  return { params, setCurrent: value => { current = value; }, original,
    stats: () => ({ gets, observations, sends }),
    call: (id, input = params, signal) => tool.execute(id, input, signal, undefined, {}) };
}
for (const state of ["unknown", "queued", "duplicate"]) test(`logical ${state} inspection needs no current runtime and preserves the original outcome`, async () => {
  const f = cacheFixture(e => Promise.resolve({ id: e.id, state, durability: state === "unknown" ? "unknown" : "observed-existing" }));
  const first = await f.call("first"), before = f.stats(); f.setCurrent(undefined);
  const c = new AbortController(); c.abort();
  assert.deepEqual(await f.call("new-logical-inspection", f.params, c.signal), first);
  assert.deepEqual(f.stats(), before, "cache inspection does not look up or observe another runtime");
});

test("generated logical UUIDs are fenced too, including explicit reuse after runtime removal", async () => {
  const f = cacheFixture(e => Promise.resolve({ id: e.id, state: "unknown", durability: "unknown" }));
  const { id: _id, ...input } = f.params;
  const first = await f.call("allocated", input); f.setCurrent(undefined);
  assert.deepEqual(await f.call("explicit-logical", { ...input, id: first.details.id }), first);
  assert.deepEqual(await f.call("allocated", input), first); assert.equal(f.stats().sends, 1);
});

test("unavailable-runtime logical rejection is retained instead of acquiring newly available authority", async () => {
  const f = cacheFixture(e => Promise.resolve({ id: e.id, state: "queued", durability: "observed-existing" }));
  f.setCurrent(undefined);
  const first = await f.call("unavailable").then(() => assert.fail("Unavailable runtime"), error => error);
  f.setCurrent(f.original);
  await assert.rejects(f.call("same-logical"), value => value === first); assert.equal(f.stats().sends, 0);
});

test("new sends capture the original runtime before deferred work rather than acquiring a replacement", async () => {
  const f = cacheFixture(e => Promise.resolve({ id: e.id, state: "unknown", durability: "unknown" }));
  const pending = f.call("first");
  f.setCurrent({ observeRun() { assert.fail("Replacement runtime cannot authorize original work"); }, send() { assert.fail("No replacement send"); } });
  const first = await pending;
  assert.deepEqual(await f.call("second"), first); assert.equal(f.stats().sends, 1);
});

test("deferred send snapshots the admitted payload before the caller can mutate it", async () => {
  let sent;
  const f = cacheFixture(e => { sent = e; return Promise.resolve({ id: e.id, state: "unknown", durability: "unknown" }); });
  const input = structuredClone(f.params), pending = f.call("snapshot");
  f.params.text = "mutated"; f.params.to.token = uuid();
  const first = await pending;
  assert.deepEqual(sent, input); f.setCurrent(undefined);
  assert.deepEqual(await f.call("original-input", input), first);
});

test("route validation rejections fence both IDs, rather than admitting a corrected send later", async () => {
  const f = cacheFixture(e => Promise.resolve({ id: e.id, state: "queued", durability: "observed-existing" }));
  const invalid = { ...f.params, to: { ...f.params.to, token: "not-a-uuid" } };
  const first = await f.call("invalid-route", invalid).then(() => assert.fail("Invalid route"), error => error);
  await assert.rejects(f.call("invalid-repeat", invalid), value => value === first);
  await assert.rejects(f.call("corrected-call", f.params), /Conflicting send ID/);
  await assert.rejects(f.call("invalid-route", f.params), /Conflicting send tool-call ID/);
  assert.equal(f.stats().sends, 0);
});

test("invalid logical UUIDs reject before runtime access and retain their tool-call rejection", async () => {
  const f = cacheFixture(e => Promise.resolve({ id: e.id, state: "queued", durability: "observed-existing" }));
  const invalid = { ...f.params, id: "x".repeat(1000000) };
  const first = await f.call("invalid-id", invalid).then(() => assert.fail("Invalid UUID"), error => error);
  await assert.rejects(f.call("invalid-id", invalid), value => value === first);
  await assert.rejects(f.call("another-invalid", invalid), /Invalid logical message UUID/);
  await assert.rejects(f.call("invalid-id", f.params), /Conflicting send tool-call ID/);
  assert.deepEqual(f.stats(), { gets: 0, observations: 0, sends: 0 });
});

test("canonical endpoint key order does not turn logical inspection into a conflict or new send", async () => {
  const f = cacheFixture(e => Promise.resolve({ id: e.id, state: "unknown", durability: "unknown" }));
  const first = await f.call("original"); f.setCurrent(undefined);
  const input = { ...f.params, to: Object.fromEntries(Object.entries(f.params.to).reverse()) };
  assert.deepEqual(await f.call("reordered", input), first); assert.equal(f.stats().sends, 1);
});

test("send history remains bounded without eviction, while original call outcomes stay inspectable", async () => {
  const f = cacheFixture(e => Promise.resolve({ id: e.id, state: "unknown", durability: "unknown" }));
  let first;
  for (let i = 0; i < 1024; i++) {
    const result = await f.call("call-" + i, { ...f.params, id: i ? uuid() : f.params.id });
    if (!i) first = result;
  }
  await assert.rejects(f.call("overflow", { ...f.params, id: uuid() }), /history bound/);
  f.setCurrent(undefined); assert.deepEqual(await f.call("call-0"), first); assert.equal(f.stats().sends, 1024);
});
