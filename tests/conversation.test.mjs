import test from "node:test";
import assert from "node:assert/strict";
import { registerConversationTools } from "../extensions/conversation.ts";
import { childBootstrap } from "../lib/state.ts";
import { active, binding, identity, rid, server, uuid } from "./fixtures.mjs";

async function setup(t, parent = identity()) {
  const seed = childBootstrap(parent, true, "chat", server);
  const f = await active(t, { seed, owner: seed.piSessionId });
  const tools = new Map();
  registerConversationTools({ registerTool: tool => tools.set(tool.name, tool) }, () => ({ runtime: f.runtime }));
  const target = { sessionId: f.w.source.sessionId, windowId: rid("window"), blockId: rid("block") };
  const peer = binding(parent, { blockId: target.blockId });
  f.store.write(peer); f.w.blocks.set(target.blockId, target);
  return { ...f, tools, parent, target, peer,
    back(signal, ctx = f.ctx) { return tools.get("rexpi_return_to_parent").execute("back", {}, signal, undefined, ctx); } };
}

test("return tool focuses the exact live parent without launching or sending a task", async t => {
  const f = await setup(t), result = await f.back();
  assert.equal(result.details.target.blockId, f.target.blockId);
  assert.equal(f.w.selected.blockId, f.target.blockId);
  assert.equal(f.w.created.length, 0);
  assert.equal(f.w.selectCalls ?? 0, 0, "same-session focus needs no app selection");
  assert.match(result.content[0].text, /No task was sent or started/);
});

test("return tool fails closed on missing, stale, duplicate or replaced parent evidence", async t => {
  for (const mode of ["missing", "duplicate", "replaced process", "replaced binding"]) await t.test(mode, async t => {
    const f = await setup(t);
    if (mode === "missing") f.store.remove(f.peer.conversationId, f.peer.token);
    if (mode === "duplicate") f.store.write(binding(f.parent));
    if (mode === "replaced process") f.w.processPids.set(f.target.blockId, process.pid + 1);
    if (mode === "replaced binding") f.w.onTerminalData = (block, method) => {
      if (block === f.target.blockId && method === "process") f.store.write(binding(f.parent, { blockId: f.target.blockId }));
    };
    await assert.rejects(f.back());
    assert.equal(f.w.focusCalls ?? 0, 0);
    assert.equal(f.w.created.length, 0);
  });
});

test("return tool rejects aborted calls and stale source contexts before native work", async t => {
  const f = await setup(t), before = f.w.calls.length;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.back(controller.signal));
  await assert.rejects(f.back(undefined, { ...f.ctx, sessionManager: { getSessionId: () => "different" } }), /conversation changed/);
  assert.equal(f.w.calls.length, before);
});

test("a root conversation cannot return and inspection does not invent a parent", async t => {
  const f = await active(t), tools = new Map();
  registerConversationTools({ registerTool: tool => tools.set(tool.name, tool) }, () => ({ runtime: f.runtime }));
  await assert.rejects(tools.get("rexpi_return_to_parent").execute("back", {}, undefined, undefined, f.ctx), /no recorded parent/);
  const result = await tools.get("rexpi_inspect").execute("inspect", {}, undefined, undefined, f.ctx);
  assert.equal(result.details.origin, undefined);
  assert.equal(result.details.messaging, undefined);
  assert.equal(f.w.focusCalls ?? 0, 0);
});

test("opt-in agent inspection exposes cached handles and result state without native or peer reads", async t => {
  const f = await active(t), who = identity("chat");
  const handle = { version: 1, taskId: who.taskId, conversationId: who.conversationId, runtimeId: uuid(), runId: uuid(),
    requestId: "inspect-child", messageId: uuid(), endpointGeneration: 1 };
  const status = { handle, runtimeId: handle.runtimeId, runId: handle.runId, requestId: handle.requestId,
    lifecycle: { binding: "bound", activity: "settled", delivery: "accepted", result: "ready" },
    pendingInput: false, resultAvailable: true, evidence: "retained", readError: "🙂".repeat(600), notice: "details-only-notice" };
  let cachedReads = 0;
  const agent = { cachedStatuses() { cachedReads++; return [status]; } };
  const tools = new Map();
  registerConversationTools({ registerTool: tool => tools.set(tool.name, tool) }, () => ({ runtime: f.runtime, agent }));
  const inspect = params => tools.get("rexpi_inspect").execute("inspect", params, undefined, undefined, f.ctx);
  const before = f.w.calls.length;
  assert.equal((await inspect({})).details.agents, undefined);
  assert.equal((await inspect({ includeAgents: false })).details.agents, undefined);
  assert.equal(cachedReads, 0);
  const result = await inspect({ includeAgents: true });
  assert.equal(cachedReads, 1);
  assert.equal(result.details.agents.length, 1);
  assert.deepEqual(result.details.agents[0].handle, handle);
  assert.equal(result.details.agents[0].lifecycle.result, "ready");
  assert.equal(result.details.agents[0].resultAvailable, true);
  assert.ok(result.details.agents[0].readError.endsWith("…"));
  assert.equal(result.content[0].text.includes("details-only-notice"), false);
  assert.equal(f.w.calls.length, before, "inspection adds no native process or peer probes");
});
