import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { active, binding, identity } from "./fixtures.mjs";
import { endpointFromBinding, makeEnvelope } from "../lib/messaging/protocol.ts";
import { WorkerMailboxTransport } from "../lib/messaging/transport-worker.ts";
import { FileMailbox } from "../lib/messaging/file-transport.ts";
import { acceptedMessageDelivery } from "../lib/messaging/delivery.ts";
import { parentFixture } from "./messaging-integration-fixtures.mjs";

test("worker transport publishes and closes after queued work without losing evidence", async t => {
  const a = await active(t), own = a.runtime.snapshot();
  const owner = endpointFromBinding(a.store.find(own.state, own.server));
  const childBinding = binding({ ...identity("review"), taskId: owner.taskId }); a.store.write(childBinding);
  const child = endpointFromBinding(childBinding);
  const transport = new WorkerMailboxTransport(a.root, a.store.directory, own.server);
  t.after(() => transport.close());
  const mailbox = transport.mailbox(child);
  const envelope = makeEnvelope(owner, child, "worker-request", "result", "worker finding");
  const pending = mailbox.publish(envelope);
  transport.close();
  assert.deepEqual(await pending, { id: envelope.id, state: "queued", durability: "file-and-inbox-fsync",
    delivery: acceptedMessageDelivery(envelope.messageId, "mailbox-queued") });
  const page = new FileMailbox(a.root, child, a.store, own.server).page();
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].text, "worker finding");
  await assert.rejects(mailbox.page(), /closed/);
});

test("stale worker pages fall back to current synchronous evidence without replaying publish", async t => {
  const a = await active(t), own = a.runtime.snapshot();
  const owner = endpointFromBinding(a.store.find(own.state, own.server));
  const childBinding = binding({ ...identity("review"), taskId: owner.taskId }); a.store.write(childBinding);
  const child = endpointFromBinding(childBinding), incoming = makeEnvelope(child, owner, "stale-worker-request", "result", "current finding");
  new FileMailbox(a.root, owner, a.store, own.server).publish(incoming);
  const { messageId, requestId, runId, runtimeId, inReplyTo, ...legacy } = incoming;
  legacy.version = 1;
  const stale = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    parentPort.on('message', request => {
      if (request.operation === 'close') { parentPort.close(); return; }
      if (request.operation === 'page') parentPort.postMessage({ id: request.id, value: workerData.page });
    });`, { eval: true, workerData: { page: { messages: [legacy] } } });
  let workers = 0;
  const transport = new WorkerMailboxTransport(a.root, a.store.directory, own.server, () => ++workers === 1 ? stale
    : new Worker(new URL("../lib/messaging/transport-thread.ts", import.meta.url), { execArgv: [],
      workerData: { agentDirectory: a.root, stateDirectory: a.store.directory, server: own.server } }));
  t.after(() => { transport.close(); stale.terminate(); });
  const page = await transport.mailbox(owner).page();
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].messageId, incoming.id);
  assert.equal(page.messages[0].requestId, incoming.requestId);
  assert.equal(page.messages[0].version, 2);
  assert.notEqual(transport.worker, stale);
  const outgoing = makeEnvelope(owner, child, "fresh-worker-after-stale-read", "result", "fresh publish");
  const published = await transport.mailbox(child).publish(outgoing);
  assert.equal(published.state, "queued");
  const stored = new FileMailbox(a.root, child, a.store, own.server).page().messages.find(e => e.id === outgoing.id);
  assert.equal(stored.version, 2);
  assert.equal(stored.messageId, outgoing.id);
});

test("messaging runtime awaits worker pages and retains exact delivery behavior", async t => {
  const f = await parentFixture(t, { runtime: { transport: "worker" } });
  const childBinding = binding({ ...identity("review"), taskId: f.owner.taskId }); f.store.write(childBinding);
  const child = endpointFromBinding(childBinding);
  f.w.blocks.set(childBinding.blockId, { sessionId: f.w.source.sessionId, windowId: f.w.source.windowId, blockId: child.blockId });
  const ticket = await f.m.prepareReturn(); await f.m.registerReturn(ticket, child);
  f.mailbox.publish(makeEnvelope(child, f.owner, ticket.requestId, "result", "worker-delivered finding", undefined,
    { runId: ticket.runId, runtimeId: ticket.runtimeId, inReplyTo: ticket.messageId }));
  await f.m.poll();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].message.content, /worker-delivered finding/);
});
