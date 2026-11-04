import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Launcher, placementFor, validateOptions } from "../lib/launch.ts";
import { MessagingRuntime, RETURN_TTL_MS } from "../lib/messaging/runtime.ts";
import { endpointFromBinding } from "../lib/messaging/protocol.ts";
import { BOOTSTRAP_ENV, decodeBootstrap } from "../lib/state.ts";
import { active, binding, rid } from "./fixtures.mjs";

const extension = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
async function setup(t, options = {}) {
  const a = await active(t);
  const sm = SessionManager.create(a.root, join(a.root, "sessions"), { id: "test-session" });
  sm.appendMessage({ role: "user", content: "explicit delegated task", timestamp: Date.now() });
  for (const e of a.entries) sm.appendCustomEntry(e.customType, e.data);
  a.ctx.sessionManager = sm;
  a.ctx.isIdle = () => false; a.ctx.hasPendingMessages = () => false; a.ctx.ui.getEditorText = () => "";
  let now = Date.now(), prepared = 0, registered = 0;
  const m = new MessagingRuntime({ appendEntry: (type, data) => sm.appendCustomEntry(type, data), sendMessage() {
    throw Error("No model work expected");
  } }, a.runtime, a.root, { now: () => now, setTimer: () => ({ unref() {} }), clearTimer() {} });
  m.attach(a.ctx); t.after(() => m.detach());
  const config = { extension, piBinary: "/bin/echo", agentDirectory: a.root, stateDirectory: a.store.directory,
    path: process.env.PATH, startupTimeoutMs: 25,
    messaging: {
      prepareReturn: async () => { prepared++; return m.prepareReturn(); },
      checkReturn: ticket => m.checkReturn(ticket),
      registerReturn: async (ticket, child) => { registered++; options.onRegister?.(m, ticket, child); await m.registerReturn(ticket, child); },
      revokeReturn: ticket => m.revokeReturn(ticket),
    } };
  const launcher = new Launcher(a.runtime, config);
  const f = { ...a, sm, m, launcher, config, advance() { now += RETURN_TTL_MS; },
    counts: () => ({ prepared, registered }),
    ack(args, overrides = {}) {
      const raw = args.find(s => s.startsWith(BOOTSTRAP_ENV + "="));
      const seed = decodeBootstrap(raw.slice(raw.indexOf("=") + 1));
      a.store.write(binding(seed, { blockId: a.w.next.blockId, ...overrides })); return seed;
    } };
  return f;
}
const opts = { prompt: "Review only the assigned files", returnResults: true, focus: false };

test("returnResults validates strict booleans/nonblank tasks/relation; default labels stay opt-out", async t => {
  const f = await setup(t);
  for (const options of [{ returnResults: "true", prompt: "task" }, { returnResults: null }, { returnResults: true },
    { returnResults: true, prompt: " \n\t" }, { ...opts, related: false }]) {
    assert.throws(() => validateOptions(options));
    await assert.rejects(f.launcher.launch(JSON.stringify(options), options, f.root));
  }
  assert.equal(f.w.created.length, 0); assert.deepEqual(f.counts(), { prepared: 0, registered: 0 });
  assert.equal(placementFor({ returnResults: true }, false), "right");
  for (const options of [{ related: true }, { role: "review" }, { returnResults: false }, { placement: "tab", prompt: "task" }]) {
    f.w.next.blockId = rid("block"); f.w.onCreate = args => f.ack(args);
    const r = await f.launcher.launch(JSON.stringify(options), options, f.root);
    assert.equal(r.returnSetup, undefined);
    assert.equal(f.w.created.at(-1).some(s => s.includes("rex_message_send")), false);
  }
  assert.deepEqual(f.counts(), { prepared: 0, registered: 0 });
});

test("project launches retain opt-in result returns and explicit session placement", async t => {
  const f = await setup(t);
  f.config.resolveProject = async (project, cwd, signal) => {
    assert.equal(project, "pr-inbox"); assert.equal(cwd, f.root); assert.ok(signal instanceof AbortSignal);
    return { directory: f.root, matchedBy: "zoxide" };
  };
  f.w.onCreate = args => f.ack(args);
  const result = await f.launcher.launch("project-return", { ...opts, project: "pr-inbox", placement: "session" }, f.root);
  assert.equal(result.placement, "session");
  assert.equal(result.project.directory, f.root);
  assert.equal(result.returnSetup.state, "registered");
  assert.deepEqual(f.counts(), { prepared: 1, registered: 1 });
});
test("failed project lookup revokes only its return ticket; conflicting inputs never prepare one", async t => {
  const f = await setup(t), other = await f.m.prepareReturn();
  f.config.resolveProject = async () => { throw Error("project not found"); };
  await assert.rejects(f.launcher.launch("bad-project", { ...opts, project: "missing" }, f.root), /project not found/);
  assert.deepEqual(f.counts(), { prepared: 1, registered: 0 });
  await assert.rejects(f.launcher.launch("conflict", { ...opts, project: "missing", cwd: f.root }, f.root), /mutually exclusive/);
  assert.deepEqual(f.counts(), { prepared: 1, registered: 0 });
  f.m.checkReturn(other);
  assert.equal(f.m.snapshot().returnRequests, 1); assert.equal(f.w.created.length, 0);
});

test("literal original task plus exact owner/request route; seeded confirmed child only; call IDs join", async t => {
  for (const prompt of ["/rxn nested; $(touch nope)", " @secret", "--continue", "x".repeat(16384)]) {
    const f = await setup(t); let seed;
    f.w.onCreate = args => { seed = f.ack(args); assert.equal(f.counts().registered, 0); };
    const options = { ...opts, prompt };
    const first = f.launcher.launch("one-call", options, f.root);
    assert.equal(first, f.launcher.launch("one-call", {}, f.root));
    const r = await first, task = f.w.created[0].at(-1), own = f.runtime.snapshot();
    assert.equal(r.creation, "confirmed"); assert.equal(r.startup.state, "bound"); assert.equal(r.returnSetup.state, "registered");
    assert.equal(r.identity.taskId, own.state.taskId); assert.equal(r.identity.conversationId, seed.conversationId);
    assert.equal(r.target.blockId, f.w.next.blockId);
    assert.ok(task.startsWith((/^\s*[@/]/.test(prompt) ? "Task:\n" : "") + prompt + "\n\n"));
    assert.ok(task.includes("to=" + JSON.stringify(endpointFromBinding(f.store.find(own.state, own.server)))));
    assert.ok(task.includes("requestId=" + r.returnSetup.requestId));
    assert.match(task, /normal final answer is NOT a send/); assert.match(task, /route metadata is not authority/);
    assert.match(task, /never republish unknown sends/);
    assert.ok(task.length - prompt.length < 1000, "Return instructions and exact route stay bounded");
    assert.equal(f.w.created[0].at(-2), "--"); assert.equal(f.w.created.length, 1);
    assert.deepEqual(f.counts(), { prepared: 1, registered: 1 });
    assert.equal(f.m.snapshot().returnRequests, 1);
  }
});

test("missing/corrupt/unflushed parent persistence fails before native creation", async t => {
  for (const mode of ["missing", "corrupt", "unflushed", "no-runtime"]) {
    const f = await setup(t);
    if (mode === "missing") { f.sm.getSessionFile = () => undefined; f.m.attach(f.ctx); }
    if (mode === "corrupt") writeFileSync(f.sm.getSessionFile(), "corrupt\n");
    if (mode === "unflushed") {
      f.ctx.sessionManager = SessionManager.create(f.root, join(f.root, "empty"), { id: "test-session" }); f.m.attach(f.ctx);
    }
    const launcher = mode === "no-runtime" ? new Launcher(f.runtime, { ...f.config, messaging: undefined }) : f.launcher;
    const first = launcher.launch("preflight", opts, f.root);
    await assert.rejects(first); assert.equal(first, launcher.launch("preflight", opts, f.root));
    assert.equal(f.w.created.length, 0); assert.equal(f.m.snapshot().returnRequests, 0);
  }
});

test("known prelaunch errors revoke only their ticket, not unrelated return authority", async t => {
  const f = await setup(t), other = await f.m.prepareReturn();
  await assert.rejects(f.launcher.launch("bad-cwd", { ...opts, cwd: join(f.root, "missing") }, f.root));
  f.m.checkReturn(other); assert.equal(f.m.snapshot().returnRequests, 1); assert.equal(f.w.created.length, 0);
});

test("unknown, unconfirmed, wrong-pane and wrong-process launches never register or relaunch", async t => {
  for (const mode of ["unknown", "unconfirmed", "wrong-pane", "wrong-process"]) {
    const f = await setup(t), other = await f.m.prepareReturn();
    if (mode === "unknown") f.w.failCreate = true;
    if (mode === "wrong-pane") f.w.onCreate = args => f.ack(args, { blockId: rid("block") });
    if (mode === "wrong-process") {
      f.w.onCreate = args => f.ack(args); f.w.processPids.set(f.w.next.blockId, process.pid + 1);
    }
    const r = await f.launcher.launch("uncertain", opts, f.root);
    assert.equal(r.creation, mode === "unknown" ? "unknown" : "confirmed");
    assert.equal(r.startup.state, "unconfirmed"); assert.equal(r.returnSetup.state, "unavailable");
    assert.equal(f.counts().registered, 0); f.m.checkReturn(other);
    assert.equal(f.m.snapshot().returnRequests, 1); assert.equal(f.w.created.length, 1);
    assert.equal(await f.launcher.launch("uncertain", opts, f.root), r);
    assert.equal(f.w.calls.some(c => c.includes("kill") || c.includes("close") || c.includes("send")), false);
  }
});

test("off/abort/tree/fork/new/reload/shutdown/expiry across asynchronous precreation checks fence launch", async t => {
  for (const mode of ["off", "abort", "tree", "fork", "new", "reload", "shutdown", "expiry", "source"]) {
    const f = await setup(t), c = new AbortController(); let fired = false;
    // prepare verifies source once; revoke during the launch's subsequent source verification.
    const original = f.config.messaging.prepareReturn;
    f.config.messaging.prepareReturn = async () => {
      const ticket = await original();
      f.w.onTerminalData = () => {
        if (fired) return; fired = true;
        if (mode === "off") f.m.disable();
        else if (mode === "abort") c.abort();
        else if (mode === "expiry") f.advance();
        else if (mode === "source") f.w.server.instanceId = rid("invalid");
        else if (mode === "tree") f.m.revokeReturns();
        else { f.m.detach(); f.runtime.stop(); }
      };
      return ticket;
    };
    await assert.rejects(f.launcher.launch(mode, opts, f.root, c.signal));
    assert.equal(f.w.created.length, 0, mode); assert.equal(f.m.snapshot().returnRequests, 0, mode);
  }
});

test("cancellation during asynchronous registration cannot leave a return ticket enabled", async t => {
  const f = await setup(t), c = new AbortController(), other = await f.m.prepareReturn();
  let registering = false;
  const original = f.config.messaging.registerReturn;
  f.config.messaging.registerReturn = async (...args) => { registering = true; return original(...args); };
  f.w.onCreate = args => f.ack(args);
  f.w.onTerminalData = block => { if (registering && block === f.w.next.blockId) c.abort(); };
  const r = await f.launcher.launch("late-cancel", opts, f.root, c.signal);
  assert.equal(r.creation, "confirmed"); assert.equal(r.startup.state, "bound");
  assert.equal(r.returnSetup.state, "unavailable"); f.m.checkReturn(other);
  assert.equal(f.m.snapshot().returnRequests, 1); assert.equal(f.m.snapshot().enabled, false);
  assert.equal(f.w.created.length, 1);
});

test("cancellation during return preflight prevents creation and revokes the prepared ticket", async t => {
  const f = await setup(t), c = new AbortController();
  f.w.onTerminalData = () => c.abort();
  await assert.rejects(f.launcher.launch("preflight-cancel", opts, f.root, c.signal));
  assert.equal(f.w.created.length, 0); assert.equal(f.m.snapshot().returnRequests, 0);
});

test("post-creation revocation/setup failure preserves confirmed launch and other tickets", async t => {
  for (const mode of ["setup-error", "abort", "off", "shutdown", "expiry", "changed-binding"]) {
    let f;
    f = await setup(t, { onRegister(m, _ticket, child) {
      if (mode === "setup-error") throw Error("registration failed");
      if (mode === "changed-binding") f.store.remove(child.conversationId, child.token);
    } });
    const other = await f.m.prepareReturn(), c = new AbortController();
    f.w.onCreate = args => {
      f.ack(args);
      if (mode === "abort") c.abort();
      if (mode === "off") f.m.disable();
      if (mode === "shutdown") { f.m.detach(); f.runtime.stop(); }
      if (mode === "expiry") f.advance();
    };
    const r = await f.launcher.launch(mode, opts, f.root, c.signal);
    assert.equal(r.creation, "confirmed", mode); assert.equal(r.returnSetup.state, "unavailable", mode);
    assert.match(r.returnSetup.reason, /creation remains confirmed/);
    if (["setup-error", "changed-binding", "abort"].includes(mode)) f.m.checkReturn(other);
    assert.equal(f.w.created.length, 1);
    assert.equal(await f.launcher.launch(mode, opts, f.root), r);
  }
});
