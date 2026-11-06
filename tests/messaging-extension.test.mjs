import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import rexpi from "../extensions/index.ts";
import { observeMessaging, registerMessageSend } from "../extensions/messaging.ts";
import { MessagingRuntime } from "../lib/messaging/runtime.ts";
import { FileMailbox } from "../lib/messaging/file-transport.ts";
import { endpointFromBinding, makeEnvelope } from "../lib/messaging/protocol.ts";
import { BindingStore } from "../lib/store.ts";
import { BOOTSTRAP_ENV, decodeBootstrap } from "../lib/state.ts";
import { active, sandbox, world, binding, identity, rid, uuid } from "./fixtures.mjs";

async function setup(t, options = {}) {
  const a = await active(t), sm = SessionManager.create(a.root, join(a.root, "sessions"), { id: "test-session" });
  sm.appendMessage({ role: "user", content: "explicit scoped send", timestamp: Date.now() });
  for (const e of a.entries) sm.appendCustomEntry(e.customType, e.data);
  a.ctx.sessionManager = sm;
  a.ctx.isIdle = () => true; a.ctx.hasPendingMessages = () => false; a.ctx.ui.getEditorText = () => "";
  const own = a.runtime.snapshot(), owner = endpointFromBinding(a.store.find(own.state, own.server));
  const b = binding({ ...identity("review"), taskId: owner.taskId }); a.store.write(b);
  a.w.blocks.set(b.blockId, { sessionId: a.w.source.sessionId, windowId: rid("window"), blockId: b.blockId });
  const child = endpointFromBinding(b), events = new Map(), tools = new Map(), sent = [];
  const pi = { on: (name, fn) => events.set(name, fn), registerTool: tool => tools.set(tool.name, tool),
    appendEntry: (type, data) => sm.appendCustomEntry(type, data), sendMessage: (message, opts) => sent.push({ message, opts }) };
  const m = new MessagingRuntime(pi, a.runtime, a.root, { setTimer: () => ({ unref() {} }), clearTimer() {}, ...options });
  m.attach(a.ctx); t.after(() => m.detach());
  let current = m;
  observeMessaging(pi, () => current); registerMessageSend(pi, () => current);
  const tool = tools.get("rexpi_message_send");
  return { ...a, sm, own, owner, child, m, events, tools, sent, tool,
    setCurrent: value => { current = value; },
    call: (id, params, signal) => tool.execute(id, params, signal, undefined, a.ctx),
    params: { to: child, requestId: "explicit-task", runId: uuid(), runtimeId: uuid(), inReplyTo: uuid(),
      kind: "result", text: "Scoped findings" } };
}

test("send schema includes main parent routes; no inbox/control tools or implicit grants", async t => {
  const f = await setup(t);
  assert.deepEqual([...f.tools.keys()], ["rexpi_message_send"]);
  assert.ok(f.tool.parameters.properties.to.properties.role.anyOf.some(x => x.const === "main"));
  assert.equal(f.tool.parameters.properties.id.maxLength, 36);
  assert.match(f.tool.parameters.properties.id.pattern, /^\^\[0-9a-f\]/);
  assert.equal(f.m.snapshot().enabled, false); assert.equal(f.m.snapshot().returnRequests, 0);
  assert.match(f.tool.description, /scoped progress, question, or result/);
  assert.match(f.tool.description, /exact related endpoint/);
});

test("tool-call IDs allocate once, logical IDs deduplicate, changed content rejects", async t => {
  const f = await setup(t);
  const first = await f.call("send-call", f.params);
  const repeat = await f.call("send-call", f.params);
  assert.deepEqual(first, repeat); assert.equal(first.details.state, "queued");
  assert.match(first.content[0].text, /Storage evidence only/);
  const id = first.details.id;
  const secondCall = await f.call("different-call", { ...f.params, id });
  assert.deepEqual(secondCall.details, first.details);
  await assert.rejects(f.call("send-call", { ...f.params, text: "changed" }), /Conflicting send tool-call ID/);
  await assert.rejects(f.call("logical-conflict", { ...f.params, id, requestId: "changed" }), /Conflicting send ID/);
  const inbox = new FileMailbox(f.root, f.child, f.store, f.own.server).inbox();
  assert.equal(inbox.messages.length, 1); assert.equal(inbox.messages[0].id, id);
  assert.equal(f.sent.length, 0); assert.equal(f.m.snapshot().returnRequests, 0);
  f.setCurrent(undefined);
  assert.deepEqual(await f.call("send-call", f.params), first, "inspection survives inactive runtime");
});

test("unknown sends never republish across tool or logical IDs; duplicate evidence is not processing", async t => {
  for (const state of ["unknown", "duplicate"]) {
    let publications = 0;
    const f = await setup(t, { mailbox: () => ({ page: () => ({ messages: [] }), publish(e) {
      publications++; return { id: e.id, state, durability: state === "unknown" ? "unknown" : "observed-existing" };
    } }) });
    const params = { ...f.params, id: uuid() }, first = await f.call("unknown", params);
    assert.equal(first.details.state, state); assert.match(first.content[0].text, /processing and task completion are not confirmed/);
    if (state === "unknown") assert.match(first.content[0].text, /Do not republish/);
    assert.deepEqual(await f.call("unknown", params), first);
    assert.deepEqual(await f.call("another", params), first);
    assert.equal(publications, 1);
  }
});

test("strict routes, body bounds, stale/native endpoints and aborted calls fail without publish", async t => {
  const f = await setup(t), c = new AbortController(); c.abort();
  const cases = [{ ...f.params, text: " " }, { ...f.params, text: "x".repeat(32768) },
    { ...f.params, requestId: "bad/id" }, { ...f.params, kind: "control" }, { ...f.params, id: "not-uuid" },
    { ...f.params, to: { ...f.child, taskId: uuid() } }, { ...f.params, to: { ...f.child, token: uuid() } }];
  for (let i = 0; i < cases.length; i++) await assert.rejects(f.call("bad-" + i, cases[i]));
  await assert.rejects(f.call("cancelled", f.params, c.signal));
  f.w.processPids.set(f.child.blockId, process.pid + 1);
  await assert.rejects(f.call("wrong-process", f.params));
  f.w.processPids.clear();
  await assert.rejects(f.call("wrong-process", f.params), undefined, "rejected tool call stays cached");
  assert.equal(f.sent.length, 0);
  assert.equal(new FileMailbox(f.root, f.child, f.store, f.own.server).inbox().messages.length, 0);
});

test("actual UI/input/start/abort/settled events hold and revoke future follow-ups", async t => {
  const f = await setup(t), ticket = await f.m.prepareReturn(); await f.m.registerReturn(ticket, f.child); await f.m.poll();
  const box = new FileMailbox(f.root, f.owner, f.store, f.own.server);
  box.publish(makeEnvelope(f.child, f.owner, ticket.requestId, "result", "Finding", undefined,
    { runId: ticket.runId, runtimeId: ticket.runtimeId, inReplyTo: ticket.messageId }));
  f.events.get("ui_prompt_start")({}, f.ctx); await f.m.poll(); assert.equal(f.sent.length, 0);
  f.events.get("input")({}, f.ctx); f.events.get("ui_prompt_end")({}, f.ctx);
  await f.m.poll(); assert.equal(f.sent.length, 0);
  const c = new AbortController(); f.ctx.signal = c.signal;
  f.events.get("agent_start")({}, f.ctx); await f.m.poll(); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].opts, { triggerTurn: true, deliverAs: "followUp" });
  f.events.get("tool_call")({}, f.ctx); c.abort();
  assert.equal(f.m.snapshot().returnRequests, 0);
  box.publish(makeEnvelope(f.child, f.owner, ticket.requestId, "question", "Another finding", undefined,
    { runId: ticket.runId, runtimeId: ticket.runtimeId, inReplyTo: ticket.messageId }));
  f.events.get("agent_settled")({ aborted: true }, f.ctx); await f.m.poll(); assert.equal(f.sent.length, 1);
});

test("before navigation/replacement events revoke even cancelled operations; registration grants nothing", async t => {
  for (const event of ["session_before_tree", "session_before_switch", "session_before_fork"]) {
    const f = await setup(t), ticket = await f.m.prepareReturn(); await f.m.registerReturn(ticket, f.child); await f.m.poll();
    assert.equal(f.events.get(event)({}, f.ctx), undefined);
    assert.equal(f.m.snapshot().enabled, false); assert.equal(f.m.snapshot().returnRequests, 0);
    const box = new FileMailbox(f.root, f.owner, f.store, f.own.server);
    box.publish(makeEnvelope(f.child, f.owner, ticket.requestId, "result", "finding", undefined,
      { runId: ticket.runId, runtimeId: ticket.runtimeId, inReplyTo: ticket.messageId }));
    await f.m.poll(); assert.equal(f.sent.length, 0);
  }
});

test("extension wires opt-in launch and literal instructions; shutdown preserves creation evidence", async t => {
  const root = sandbox(t), w = world(), events = new Map(), tools = new Map(), sent = [];
  const env = { REX_SESSION: w.source.sessionId, REX_BLOCK: w.source.blockId, PI_REX_CLI: "/bin/echo",
    PI_REX_BINARY: "/bin/echo", PI_REX_STATE_DIR: join(root, "bindings"), PI_CODING_AGENT_DIR: root,
    PI_REX_BOOTSTRAP: undefined, PI_REX_RETURN_KEY: "off", PI_REX_AGENTS_KEY: "off" };
  const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : process.env[k] = v;
  const sm = SessionManager.create(root, join(root, "sessions"), { id: "extension-session" });
  sm.appendMessage({ role: "user", content: "delegate review with result return", timestamp: Date.now() });
  const c = new AbortController();
  const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: sm, signal: c.signal,
    isIdle: () => false, hasPendingMessages: () => false, ui: { notify() {}, setStatus() {}, getEditorText: () => "" } };
  t.after(() => {
    events.get("session_shutdown")?.({}, ctx);
    for (const [k, v] of Object.entries(prior)) v === undefined ? delete process.env[k] : process.env[k] = v;
  });
  const pi = { on: (name, fn) => events.set(name, fn), exec: w.exec, registerTool: tool => tools.set(tool.name, tool),
    registerCommand() {}, registerShortcut() {}, getSettings: () => ({}), getCommands: () => [],
    appendEntry: (type, data) => sm.appendCustomEntry(type, data), sendMessage: (...args) => sent.push(args) };
  rexpi(pi); assert.equal(tools.size, 0); await events.get("session_start")({}, ctx);
  const store = new BindingStore(join(root, "bindings"));
  w.onCreate = args => {
    const raw = args.find(s => s.startsWith(BOOTSTRAP_ENV + "="));
    const seed = decodeBootstrap(raw.slice(raw.indexOf("=") + 1));
    store.write(binding(seed, { blockId: w.next.blockId }));
  };
  const launch = tools.get("rexpi_start_pi");
  const result = await launch.execute("opt-in", { prompt: "/rxn not a command", returnResults: true, focus: false }, c.signal, undefined, ctx);
  assert.equal(result.details.creation, "confirmed"); assert.equal(result.details.returnSetup.state, "registered");
  assert.match(result.content[0].text, /permission registered/);
  assert.match(w.created[0].at(-1), /^Task:\n\/rxn not a command\n\n/);
  assert.equal(sent.length, 0);
  events.get("session_shutdown")({}, ctx);
  await assert.rejects(launch.execute("after-stop", { prompt: "task", returnResults: true }, c.signal, undefined, ctx));
  assert.equal(w.created.length, 1);
});
