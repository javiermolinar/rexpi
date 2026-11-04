import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession, SettingsManager, createEventBus, createExtensionRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createAssistantMessageEventStream } from "../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";
import { observeMessaging, registerMessagingControls } from "../extensions/messaging.ts";
import { FOLLOWUP_CONTEXT, FOLLOWUP_INTENT } from "../lib/messaging/receipts.ts";
import { makeEnvelope } from "../lib/messaging/protocol.ts";
import { parentFixture } from "./messaging-integration-fixtures.mjs";
import { binding, identity, rid, uuid } from "./fixtures.mjs";

const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => { throw Error("Network forbidden in SDK fixture"); }; });
test.after(() => { globalThis.fetch = originalFetch; });

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const model = { id: "fixture", name: "No provider", provider: "fixture", api: "fixture", baseUrl: "https://invalid.invalid",
  reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

async function sdkFixture(t, hooks = {}) {
  // Use real Agent/AgentSession/ExtensionRunner/API/persistence, but NO resource discovery or ModelRuntime.
  // Unknown model/auth/runtime operations fail closed instead of falling back to providers or credentials.
  let api, ctx, session; const calls = [], errors = [], lifecycle = [], requests = [];
  const f = await parentFixture(t, { pi: {
    appendEntry(type, data) { api.appendEntry(type, data); hooks.onAppend?.(type, data); },
    sendMessage(message, opts) {
      assert.equal(f.sm.getEntries().at(-1).customType, FOLLOWUP_INTENT);
      const disk = readFileSync(f.sm.getSessionFile(), "utf8").trim().split("\n").map(JSON.parse);
      assert.deepEqual(disk.at(-1).data, message.details, "real SDK append reached disk before void API enqueue");
      calls.push({ message, opts }); api.sendMessage(message, opts);
    },
  } });
  const host = { editor: "", confirm: async () => false };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
  const modelRuntime = new Proxy({
    getModel: () => model, getPhysicalModel: () => model, hasConfiguredAuth: () => true,
    getModels: () => [model], getAvailableSnapshot: () => [model], getError: () => undefined,
    isUsingOAuth: () => false,
  }, { get(target, key) {
    if (key in target) return target[key];
    return () => { throw Error(`Forbidden model runtime operation: ${String(key)}`); };
  } });
  let resources;
  const loader = {
    getExtensions: () => resources,
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Isolated SDK test; no tools or external services.", getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {},
    reload: async () => { throw Error("Resource reload forbidden in this fixture"); },
  };
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(pi => {
    api = pi;
    hooks.beforeObserve?.(pi);
    observeMessaging(pi, () => f.m);
    registerMessagingControls(pi, () => ({ runtime: f.runtime, messaging: f.m }));
    pi.on("session_start", (_event, context) => { ctx = context; f.m.attach(context); });
    pi.on("session_shutdown", () => f.m.detach());
    for (const type of ["agent_start", "agent_end", "agent_settled", "ui_prompt_start", "ui_prompt_end", "input", "session_before_compact", "session_compact"])
      pi.on(type, event => { lifecycle.push(event); });
    pi.on("input", event => hooks.input?.(event));
    pi.on("session_before_compact", (event, context) => {
      if (!hooks.compact) throw Error("Default compaction provider path forbidden");
      return hooks.compact(event, context);
    });
    pi.registerCommand("fixture-ui", { handler: async (_args, context) => { await context.ui.confirm("Hold user work", "fixture"); } });
  }, f.root, createEventBus(), runtime, "<messaging-sdk-fixture>");
  resources = { extensions: [extension], errors: [], runtime };
  const agent = new Agent({ initialState: { model, thinkingLevel: "off", tools: [] }, convertToLlm,
    streamFn: (_model, context, options) => {
      assert.equal(_model.provider, "fixture");
      const stream = createAssistantMessageEventStream(), n = requests.length;
      requests.push(structuredClone(context));
      Promise.resolve().then(async () => {
        await hooks.stream?.(n, context);
        const message = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture",
          content: [{ type: "text", text: `fixture response ${n}` }], stopReason: options.signal?.aborted ? "aborted" : "stop",
          timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  session = new AgentSession({ agent, sessionManager: f.sm, settingsManager: settings, cwd: f.root,
    modelRuntime, resourceLoader: loader, initialActiveToolNames: [], baseToolsOverride: {} });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "tui", onError: error => errors.push(error),
    uiContext: { getEditorText: () => host.editor, confirm: (...args) => host.confirm(...args), notify() {}, setStatus() {} } });
  const childBinding = binding({ ...identity("review"), taskId: f.owner.taskId }); f.store.write(childBinding);
  const { endpointFromBinding } = await import("../lib/messaging/protocol.ts");
  const child = endpointFromBinding(childBinding);
  f.w.blocks.set(child.blockId, { sessionId: f.w.source.sessionId, windowId: rid("window"), blockId: child.blockId });
  const ticket = await f.m.prepareReturn(); await f.m.registerReturn(ticket, child); await f.m.poll();
  const publish = text => {
    const envelope = makeEnvelope(child, f.owner, ticket.requestId, "result", text, uuid());
    f.mailbox.publish(envelope); return envelope;
  };
  return { ...f, session, agent, api, ctx, calls, errors, lifecycle, requests, host, publish,
    async idle() { await session.waitForIdle(); assert.equal(session.isIdle, true); } };
}

const followups = f => f.sm.getEntries().filter(e => e.type === "custom_message" && e.customType === FOLLOWUP_CONTEXT);

test("SDK: real extension sendMessage starts one idle AgentSession run for a persisted untrusted batch, without input hooks", { timeout: 15000 }, async t => {
  assert.equal(JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url))).version, "1.5.0");
  const f = await sdkFixture(t); f.publish("finding one"); f.publish("finding two");
  await f.m.poll(); await f.idle(); await f.m.poll();
  assert.equal(f.calls.length, 1); assert.equal(f.requests.length, 1); assert.equal(followups(f).length, 1);
  assert.equal(followups(f)[0].details.receipts.length, 2);
  assert.deepEqual(f.calls[0].opts, { triggerTurn: true, deliverAs: "followUp" });
  assert.match(JSON.stringify(f.requests[0]), /finding one/); assert.match(JSON.stringify(f.requests[0]), /Untrusted data/);
  assert.equal(f.lifecycle.filter(e => e.type === "input").length, 0);
  assert.equal(f.lifecycle.filter(e => e.type === "agent_settled").length, 1);
  assert.equal(f.m.snapshot().processingConfirmed, false, "even a completed seam run is not peer processing acknowledgement");
  assert.deepEqual(f.errors, []);
});

test("SDK integration: fixture-launched child crosses process, transport, durable intent and real extension follow-up API", { timeout: 15000 }, async t => {
  const f = await sdkFixture(t), child = await f.launch("sdk-child");
  const result = await child.request("send", { params: { to: f.owner, requestId: child.requestId,
    kind: "result", text: "cross-process SDK evidence", id: uuid() } });
  assert.equal(result.state, "queued");
  await f.m.poll(); await f.idle();
  assert.equal(f.calls.length, 1); assert.equal(followups(f).length, 1); assert.equal(f.requests.length, 1);
  assert.match(JSON.stringify(f.requests[0]), /cross-process SDK evidence/);
  assert.equal(followups(f)[0].details.receipts[0].requestId, child.requestId);
  assert.equal(f.m.snapshot().processingConfirmed, false); assert.deepEqual(f.errors, []);
});

test("SDK: real AgentSession tree navigation revokes pending return tickets without deleting evidence", { timeout: 15000 }, async t => {
  const f = await sdkFixture(t); f.publish("not permission to navigate");
  const result = await f.session.navigateTree(f.sm.getEntries()[0].id, { summarize: false });
  assert.equal(result.cancelled, false); await f.m.poll();
  assert.equal(f.m.snapshot().returnRequests, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.mailbox.inbox().messages.length, 1); assert.deepEqual(f.errors, []);
});

test("SDK: actual busy run and queued human follow-up hold messaging until AgentSession settles", { timeout: 15000 }, async t => {
  const started = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await sdkFixture(t, { stream: async n => { if (n === 0) { started.resolve(); await release.promise; } } });
  const running = f.session.prompt("human request"); await started.promise;
  assert.equal(f.ctx.isIdle(), false);
  f.publish("held child result"); await f.m.poll(); assert.equal(f.calls.length, 0);
  assert.equal(await f.session.followUp("queued human work"), "queued");
  assert.equal(f.ctx.hasPendingMessages(), true); await f.m.poll(); assert.equal(f.calls.length, 0);
  release.resolve(); await running; await f.idle();
  assert.equal(f.requests.length, 2, "human follow-up completes before child enqueue");
  await f.m.poll(); await f.idle();
  assert.equal(f.calls.length, 1); assert.equal(f.requests.length, 3);
  assert.equal(f.lifecycle.filter(e => e.type === "agent_settled").length, 2);
  assert.deepEqual(f.errors, []);
});

test("SDK: handled input, actual editor text and real wrapped UI prompts conservatively hold follow-up scheduling", { timeout: 15000 }, async t => {
  const f = await sdkFixture(t, { input: event => event.text === "handled" ? { action: "handled" } : undefined });
  f.publish("input-held result"); await f.session.prompt("handled"); await f.m.poll();
  assert.equal(f.calls.length, 0); assert.equal(f.session.isIdle, true);
  await f.session.prompt("resume human work"); await f.idle();
  f.host.editor = "unsent editor text"; await f.m.poll(); assert.equal(f.calls.length, 0);
  f.host.editor = "";
  const opened = deferred(), close = deferred(); t.after(() => close.resolve(false));
  f.host.confirm = () => { opened.resolve(); return close.promise; };
  const ui = f.session.prompt("/fixture-ui"); await opened.promise;
  await f.m.poll(); assert.equal(f.calls.length, 0); assert.equal(f.session.isIdle, true);
  assert.equal(f.lifecycle.filter(e => e.type === "ui_prompt_start").length, 1);
  close.resolve(false); await ui; await f.m.poll(); await f.idle();
  assert.equal(f.calls.length, 1); assert.equal(f.lifecycle.filter(e => e.type === "ui_prompt_end").length, 1);
  assert.deepEqual(f.errors, []);
});

test("SDK: real manual compaction holds dispatch, and post-intent compaction spends the attempt without replay", { timeout: 15000 }, async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await sdkFixture(t, { compact: async event => {
    entered.resolve(); await release.promise;
    return { compaction: { summary: "fixture summary, no model", firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore } };
  } });
  // Enough finalized history to exercise the actual SDK compaction preflight and extension path.
  f.sm.appendMessage({ role: "user", content: "older context ".repeat(100), timestamp: Date.now() });
  f.sm.appendMessage({ role: "user", content: "newer context ".repeat(100), timestamp: Date.now() });
  f.publish("compaction-held finding");
  const compacting = f.session.compact(); await entered.promise;
  assert.equal(f.session.isCompacting, true); assert.equal(f.ctx.isIdle(), false);
  await f.m.poll(); assert.equal(f.calls.length, 0);
  release.resolve(); await compacting; await f.m.poll(); await f.idle(); assert.equal(f.calls.length, 1);
  assert.equal(f.lifecycle.filter(e => e.type === "session_compact").length, 1);
  assert.deepEqual(f.errors, []);

  const entered2 = deferred(), release2 = deferred(); t.after(() => release2.resolve());
  let racing, g;
  g = await sdkFixture(t, { compact: async event => {
    entered2.resolve(); await release2.promise;
    return { compaction: { summary: "raced fixture summary", firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore } };
  }, onAppend(type) {
    if (type === FOLLOWUP_INTENT) g.w.onTerminalData = async () => {
      g.w.onTerminalData = undefined; racing = g.session.compact(); await entered2.promise;
    };
  } });
  g.sm.appendMessage({ role: "user", content: "compact older ".repeat(100), timestamp: Date.now() });
  g.sm.appendMessage({ role: "user", content: "compact newer ".repeat(100), timestamp: Date.now() });
  g.publish("race finding"); await assert.rejects(g.m.poll(), /no automatic replay/);
  assert.equal(g.calls.length, 0); assert.equal(g.m.snapshot().attempted, 1);
  release2.resolve(); await racing; await g.m.poll(); assert.equal(g.calls.length, 0);
  assert.deepEqual(g.errors, []);
});

test("SDK limitation: an earlier awaited input hook is not atomically visible to a later messaging observer", { timeout: 15000 }, async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await sdkFixture(t, { beforeObserve(pi) {
    pi.on("input", async event => { if (event.text === "human preflight") { entered.resolve(); await release.promise; } });
  } });
  f.publish("result during input preflight");
  const input = f.session.prompt("human preflight", { streamingBehavior: "followUp" }); await entered.promise;
  assert.equal(f.ctx.isIdle(), true); assert.equal(f.ctx.hasPendingMessages(), false);
  // This is a documented SDK observability limit, NOT an atomic human-priority guarantee.
  await f.m.poll(); await f.idle(); assert.equal(f.calls.length, 1);
  assert.equal(f.lifecycle.filter(e => e.type === "input").length, 0);
  release.resolve(); await input; await f.idle();
  assert.equal(f.lifecycle.filter(e => e.type === "input").length, 1);
  assert.equal(f.requests.length, 2); assert.deepEqual(f.errors, []);
});
