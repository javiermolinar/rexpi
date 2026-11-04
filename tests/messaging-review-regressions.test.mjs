// F1/F2 regressions: temporary storage, fixture Rex, no native peers or providers.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import piRex from "../extensions/index.ts";
import { parentFixture } from "./messaging-integration-fixtures.mjs";
import { binding, identity, rid, sandbox, world, uuid } from "./fixtures.mjs";
import { BOOTSTRAP_ENV, decodeBootstrap } from "../lib/state.ts";
import { BindingStore } from "../lib/store.ts";
import { endpointFromBinding, makeEnvelope } from "../lib/messaging/protocol.ts";
import { FOLLOWUP_INTENT, ReceiptLedger } from "../lib/messaging/receipts.ts";

async function extensionFixture(t) {
  const root = sandbox(t), w = world(), events = new Map(), tools = new Map(), commands = new Map(), notices = [];
  const env = { REX_SESSION: w.source.sessionId, REX_BLOCK: w.source.blockId, PI_REX_CLI: "/bin/echo",
    PI_REX_BINARY: "/bin/echo", PI_REX_STATE_DIR: join(root, "bindings"), PI_CODING_AGENT_DIR: root,
    PI_REX_BOOTSTRAP: undefined, PI_REX_RETURN_KEY: "off", PI_REX_AGENTS_KEY: "off" };
  const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : process.env[k] = v;
  const sm = SessionManager.create(root, join(root, "sessions"), { id: "review-regression" });
  sm.appendMessage({ role: "user", content: "isolated authorized test delegation", timestamp: Date.now() });
  const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: sm,
    isIdle: () => false, hasPendingMessages: () => false,
    ui: { notify: text => notices.push(text), setStatus() {}, getEditorText: () => "" } };
  t.after(() => {
    events.get("session_shutdown")?.({}, ctx);
    for (const [k, v] of Object.entries(prior)) v === undefined ? delete process.env[k] : process.env[k] = v;
  });
  const pi = { on: (name, fn) => events.set(name, fn), exec: w.exec,
    registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {}, getSettings: () => ({}), getCommands: () => [],
    appendEntry: (type, data) => sm.appendCustomEntry(type, data), sendMessage() { assert.fail("No model work"); } };
  piRex(pi); await events.get("session_start")({}, ctx);
  const params = { prompt: "scoped fixture task", returnResults: true, focus: false };
  return { root, w, events, tools, commands, notices, sm, ctx, params,
    call(id, input = params) { return tools.get("rex_start_pi").execute(id, input, undefined, undefined, ctx); },
    async tree() { events.get("session_before_tree")({}, ctx); await events.get("session_tree")({}, ctx); },
    async status() { return (await tools.get("rex_inspect").execute("status", {}, undefined, undefined, ctx)).details.messaging; },
  };
}

for (const mode of ["unknown", "confirmed", "rejected"]) test(`F1: ${mode} launch call survives same-session tree replacement without dispatch or regrant`, async t => {
  const f = await extensionFixture(t);
  if (mode === "unknown") f.w.failCreate = true;
  if (mode === "confirmed") f.w.onCreate = args => {
    const raw = args.find(s => s.startsWith(BOOTSTRAP_ENV + "="));
    const seed = decodeBootstrap(raw.slice(raw.indexOf("=") + 1));
    // Only a fixture binding, never an executed native launch.
    new BindingStore(join(f.root, "bindings")).write(binding(seed, { blockId: f.w.next.blockId }));
  };
  const input = mode === "rejected" ? { ...f.params, related: false } : f.params;
  const first = await f.call("stable-call", input).then(value => ({ value }), error => ({ error }));
  if (mode === "rejected") assert.match(first.error.message, /related/);
  else assert.equal(first.value.details.creation, mode === "unknown" ? "unknown" : "confirmed");
  const attempts = f.w.created.length;
  await f.tree();
  if (mode === "rejected") f.w.failCreate = true;
  const second = await f.call("stable-call", mode === "rejected" ? f.params : input)
    .then(value => ({ value }), error => ({ error }));
  assert.deepEqual(second, first);
  assert.equal(f.w.created.length, attempts);
  assert.equal((await f.status()).returnRequests, 0, "cached historical result never registers a new ticket");
  // A new explicit ID is still independently admitted in the new runtime.
  f.w.failCreate = true; f.w.onCreate = undefined;
  await f.call("fresh-call"); assert.equal(f.w.created.length, attempts + 1);
});

test("F1: in-flight uncertain call is shared across tree replacement and concurrent inspection", async t => {
  const f = await extensionFixture(t);
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.w.failCreate = true; f.w.onCreate = async () => { entered(); await gate; };
  const first = f.call("pending-call"); await waiting;
  await f.tree();
  const second = f.call("pending-call");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(b, a); assert.equal(f.w.created.length, 1);
  assert.equal((await f.status()).returnRequests, 0);
  f.events.get("session_shutdown")({}, f.ctx);
  assert.deepEqual(await f.call("pending-call"), a, "original evidence is inspectable without an active runtime");
});

test("F1: deferred preflight stays bound to its original generation, not a replacement runtime", async t => {
  const f = await extensionFixture(t); f.w.failCreate = true;
  const first = f.call("preflight-call").then(() => assert.fail("Old generation cannot launch"), error => error);
  await f.tree();
  const error = await first;
  await assert.rejects(f.call("preflight-call"), value => value === error);
  assert.equal(f.w.created.length, 0);
});

test("F1: extension-lifetime launch history is bounded and tree replacement cannot reset its admission fence", async t => {
  const f = await extensionFixture(t), bad = { ...f.params, related: false };
  for (let i = 0; i < 256; i++) await assert.rejects(f.call("bad-" + i, bad), /related/);
  await f.tree(); f.w.failCreate = true;
  await assert.rejects(f.call("overflow"), /history.*full/i);
  await assert.rejects(f.call("bad-0"), /related/, "old rejection remains inspectable at capacity");
  assert.equal(f.w.created.length, 0);
});

for (const mode of ["missing", "corrupt", "replacement", "identical-replacement", "ancestor-replacement", "hardlink", "symlink", "permissions", "memory-change"])
  test(`F2: ${mode} storage after intent confirmation fails closed and never replays after repair`, async t => {
    let f, changed = false, original, path;
    f = await parentFixture(t, { onAppend(type) {
      if (type !== FOLLOWUP_INTENT) return;
      f.w.onTerminalData = () => {
        f.w.onTerminalData = undefined;
        path = f.sm.getSessionFile(); original = readFileSync(path, "utf8");
        assert.match(original, /pi-rex.message.followup.intent/);
        if (mode === "missing") unlinkSync(path);
        if (mode === "corrupt") writeFileSync(path, "corrupt\n");
        if (mode === "replacement" || mode === "identical-replacement") {
          renameSync(path, path + ".original"); writeFileSync(path, mode === "identical-replacement" ? original : "replacement\n");
        }
        if (mode === "ancestor-replacement") {
          const directory = dirname(path); renameSync(directory, directory + ".original");
          mkdirSync(directory, { mode: 0o700 }); renameSync(join(directory + ".original", basename(path)), path);
        }
        if (mode === "hardlink") linkSync(path, path + ".link");
        if (mode === "symlink") { renameSync(path, path + ".original"); symlinkSync(path + ".original", path); }
        if (mode === "permissions") chmodSync(path, 0o666);
        if (mode === "memory-change") f.sm.getEntries().at(-1).data.receipts[0].digest = "0".repeat(64);
        changed = true;
      };
    } });
    const b = binding({ ...identity("review"), taskId: f.owner.taskId }); f.store.write(b);
    f.w.blocks.set(b.blockId, { sessionId: f.w.source.sessionId, windowId: rid("window"), blockId: b.blockId });
    const child = endpointFromBinding(b), ticket = await f.m.prepareReturn();
    await f.m.registerReturn(ticket, child); await f.m.poll();
    const e = makeEnvelope(child, f.owner, ticket.requestId, "result", "isolated finding", uuid()); f.mailbox.publish(e);
    await assert.rejects(f.m.poll(), /no automatic replay/);
    assert.equal(changed, true); assert.equal(f.sent.length, 0); assert.equal(f.m.snapshot().attempted, 1);
    assert.equal(f.m.snapshot().processingConfirmed, false);
    // Explicit test-only repair, never production recovery or replay.
    if (mode === "hardlink") unlinkSync(path + ".link");
    if (mode === "symlink" || mode === "replacement" || mode === "identical-replacement") {
      unlinkSync(path); renameSync(path + ".original", path);
    }
    if (mode === "ancestor-replacement") {
      const directory = dirname(path); renameSync(path, join(directory + ".original", basename(path)));
      rmdirSync(directory); renameSync(directory + ".original", directory);
    }
    if (mode === "permissions") chmodSync(path, 0o600);
    writeFileSync(path, original);
    await f.m.poll(); assert.equal(f.sent.length, 0);
    assert.equal(f.mailbox.inbox().messages.length, 1);
  });

test("F2: a confirmed ledger synchronously fences file changes after its last asynchronous confirmation", async t => {
  const f = await parentFixture(t), ledger = new ReceiptLedger(f.owner, f.sm, () => {});
  await ledger.confirm(); ledger.assertConfirmed();
  const path = f.sm.getSessionFile(), original = readFileSync(path, "utf8");
  renameSync(path, path + ".original"); writeFileSync(path, original);
  assert.throws(() => ledger.assertConfirmed(), /changed/i);
  await assert.rejects(ledger.confirm(), /changed/i, "even identical replacement cannot repin this ledger");
});
