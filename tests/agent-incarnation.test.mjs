import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentRuntime } from "../lib/agent-runtime.ts";
import { agentEndpointId, PeerRuntime } from "../lib/peer.ts";
import { endpointFromBinding } from "../lib/messaging/protocol.ts";
import { Runtime } from "../lib/runtime.ts";
import { Rex } from "../lib/rex.ts";
import { BindingStore } from "../lib/store.ts";
import { childBootstrap } from "../lib/state.ts";
import { sandbox, world, rid, uuid } from "./fixtures.mjs";

function makeHandle(who) {
  return { version: 1, taskId: who.taskId, conversationId: who.conversationId,
    runtimeId: uuid(), runId: uuid(), requestId: "request-1", messageId: uuid(), endpointGeneration: 1 };
}
function makeCompletion(handle) {
  return { requestId: handle.requestId, runId: handle.runId, runtimeId: handle.runtimeId,
    outcome: "completed", summary: "replacement-only completion", artifacts: [] };
}

async function fixture(t) {
  const root = sandbox(t), w = world(), store = new BindingStore(join(root, "bindings"));
  async function start(blockId, seed) {
    const sessionId = seed?.piSessionId ?? uuid();
    const sm = SessionManager.create(root, join(root, "sessions-" + randomUUID()), { id: sessionId });
    sm.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
    w.blocks.set(blockId, { sessionId: rid("session"), windowId: rid("window"), blockId });
    w.callerBlock = blockId;
    const runtime = new Runtime(new Rex("/bin/echo", w.exec), store, blockId);
    const control = { idle: true, aborts: 0, shutdowns: 0 };
    const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: sm,
      isIdle: () => control.idle, hasPendingMessages: () => false,
      abort() { control.aborts++; }, shutdown() { control.shutdowns++; }, ui: { setStatus() {}, notify() {} } };
    await runtime.start(ctx, state => sm.appendCustomEntry("pi-rex.orientation", state), seed);
    const peer = new PeerRuntime({ sendMessage() {} }, runtime, store.directory);
    await peer.attach(ctx);
    const agent = new AgentRuntime(); agent.attach(peer, peer);
    t.after(() => { agent.detach(); peer.detach(); runtime.stop(); });
    const own = runtime.snapshot(), binding = store.find(own.state, own.server);
    return { runtime, peer, agent, control, state: own.state, endpointId: agentEndpointId(endpointFromBinding(binding)) };
  }
  const parent = await start(rid("block"));
  const childBlock = rid("block"), seed = childBootstrap(parent.state, true, "review", w.server);
  let child = await start(childBlock, seed);
  const handle = makeHandle(child.state);
  parent.agent.register(handle); child.agent.register(handle);
  // This is the same evidence available to Launcher.waitForStartup, before any parent remote read.
  parent.agent.pinEndpoint(handle, child.endpointId);
  async function restart() {
    child.agent.detach(); child.peer.detach(); child.runtime.stop();
    child = await start(childBlock, seed);
    child.agent.register(handle);
    return child;
  }
  return { parent, handle, restart, get child() { return child; } };
}

test("first status contact after same-bootstrap restart rejects the replacement incarnation", async t => {
  const f = await fixture(t), previous = f.child;
  await f.restart();
  assert.notEqual(f.child.endpointId, previous.endpointId);
  f.child.control.idle = false;
  const status = await f.parent.agent.status(f.handle);
  assert.equal(status.lifecycle.binding, "replaced");
  assert.equal(status.lifecycle.activity, "unknown", "replacement activity is not adopted");
  assert.equal(status.evidence, "retained");
  assert.equal(status.resultAvailable, false);
});

test("first result contact after same-bootstrap restart cannot accept replacement completion", async t => {
  const f = await fixture(t), previous = f.child;
  await f.restart();
  assert.notEqual(f.child.endpointId, previous.endpointId);
  f.child.agent.complete(f.handle, f.child.state, makeCompletion(f.handle));
  const result = await f.parent.agent.result(f.handle, f.parent.state);
  assert.equal(result.state, "unknown");
  assert.equal(result.completion, undefined);
  assert.equal(f.parent.agent.events(f.handle).resultAvailable, false);
  assert.equal(f.parent.agent.events(f.handle).events.at(-1).lifecycle.binding, "replaced");
});

test("first cancellation contact after same-bootstrap restart has no abort effect", async t => {
  const f = await fixture(t), previous = f.child;
  await f.restart();
  assert.notEqual(f.child.endpointId, previous.endpointId);
  f.child.control.idle = false;
  const outcome = await f.parent.agent.cancel(f.handle, f.parent.state);
  assert.equal(outcome.state, "unknown");
  assert.equal(f.child.control.aborts, 0);
  assert.equal(f.parent.agent.events(f.handle).events.at(-1).lifecycle.binding, "replaced");
  assert.notEqual(f.parent.agent.events(f.handle).events.at(-1).lifecycle.result, "cancelled");
});

test("first stop contact after same-bootstrap restart has no shutdown effect", async t => {
  const f = await fixture(t), previous = f.child;
  await f.restart();
  assert.notEqual(f.child.endpointId, previous.endpointId);
  const outcome = await f.parent.agent.stop(f.handle, f.parent.state, { authorize: true });
  assert.equal(outcome.state, "unknown");
  assert.equal(f.child.control.shutdowns, 0);
  assert.equal(f.parent.agent.events(f.handle).events.at(-1).lifecycle.binding, "replaced");
  assert.notEqual(f.parent.agent.events(f.handle).events.at(-1).lifecycle.result, "cancelled");
});
