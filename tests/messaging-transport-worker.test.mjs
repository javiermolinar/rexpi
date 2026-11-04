import test from "node:test";
import assert from "node:assert/strict";
import { active, binding, identity } from "./fixtures.mjs";
import { endpointFromBinding, makeEnvelope } from "../lib/messaging/protocol.ts";
import { WorkerMailboxTransport } from "../lib/messaging/transport-worker.ts";
import { FileMailbox } from "../lib/messaging/file-transport.ts";
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
  assert.deepEqual(await pending, { id: envelope.id, state: "queued", durability: "file-and-inbox-fsync" });
  const page = new FileMailbox(a.root, child, a.store, own.server).page();
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].text, "worker finding");
  assert.throws(() => mailbox.page(), /closed/);
});

test("messaging runtime awaits worker pages and retains exact delivery behavior", async t => {
  const f = await parentFixture(t, { runtime: { transport: "worker" } });
  const childBinding = binding({ ...identity("review"), taskId: f.owner.taskId }); f.store.write(childBinding);
  const child = endpointFromBinding(childBinding);
  f.w.blocks.set(childBinding.blockId, { sessionId: f.w.source.sessionId, windowId: f.w.source.windowId, blockId: child.blockId });
  const ticket = await f.m.prepareReturn(); await f.m.registerReturn(ticket, child);
  f.mailbox.publish(makeEnvelope(child, f.owner, ticket.requestId, "result", "worker-delivered finding"));
  await f.m.poll();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].message.content, /worker-delivered finding/);
});
