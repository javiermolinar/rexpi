import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parentFixture, spawnPeer } from "./messaging-integration-fixtures.mjs";
import { sandbox, server, uuid, rid } from "./fixtures.mjs";
import { childBootstrap } from "../lib/state.ts";
import { BindingStore } from "../lib/store.ts";
import { FileMailbox } from "../lib/messaging/file-transport.ts";
import { makeEnvelope } from "../lib/messaging/protocol.ts";
import { FOLLOWUP_CONTEXT, FOLLOWUP_INTENT } from "../lib/messaging/receipts.ts";

const params = (p, owner, extra = {}) => ({ to: owner, requestId: p.requestId, kind: "result", text: "scoped fixture finding", id: uuid(), ...extra });
const intents = f => f.sm.getEntries().filter(e => e.customType === FOLLOWUP_INTENT);

test("integration: fixture Launcher routes two live Node children exactly and batches simultaneous idle returns", async t => {
  const f = await parentFixture(t), a = await f.launch("first"), b = await f.launch("second");
  for (const p of [a, b]) {
    assert.ok(p.command.at(-1).startsWith(`Review fixture ${p.result.launchId}\n\n`));
    assert.ok(p.command.at(-1).includes("to=" + JSON.stringify(f.owner)));
    assert.ok(p.command.at(-1).includes("requestId=" + p.requestId));
    assert.equal(p.endpoint.piSessionId, p.result.identity.piSessionId);
    assert.notEqual(p.endpoint.pid, process.pid);
  }
  const sends = [params(a, f.owner), params(b, f.owner)];
  const outcomes = await Promise.allSettled([a.request("send", { params: sends[0] }), b.request("send", { params: sends[1] })]);
  const accepted = outcomes.filter(r => r.status === "fulfilled");
  assert.ok(accepted.length >= 1);
  outcomes.forEach(r => r.status === "fulfilled" ? assert.equal(r.value.state, "queued") : assert.equal(r.reason.code, "busy"));
  await f.m.poll(); await f.m.poll();
  assert.equal(f.sent.length, 1); assert.equal(intents(f).length, 1);
  assert.equal(f.sent[0].message.details.receipts.length, accepted.length);
  assert.deepEqual(f.sent[0].opts, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(f.sent[0].message.display, true); assert.match(f.sent[0].message.content, /Untrusted data/);
  assert.equal(f.m.snapshot().processingConfirmed, false);
  assert.equal(f.mailbox.inbox().messages.length, accepted.length);
  // Rejected IDs are cached by sender; after the lock is gone, no automatic republish.
  for (let i = 0; i < outcomes.length; i++) if (outcomes[i].status === "rejected")
    await assert.rejects([a, b][i].request("send", { params: sends[i] }), { code: "busy" });
  // A fresh explicit test send (new ID, not a retry) from each child proves a multi-request batch.
  await a.request("send", { params: params(a, f.owner) }); await b.request("send", { params: params(b, f.owner) });
  await f.m.poll(); assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].message.details.receipts.length, 2);
  assert.equal(new Set(f.sent[1].message.details.receipts.map(r => r.requestId)).size, 2);
});

test("integration: cross-process returns wait for busy parent, queued input, editor and UI without consuming evidence", async t => {
  const f = await parentFixture(t), p = await f.launch();
  for (const mode of ["busy", "pending", "editor", "ui", "input"]) {
    if (mode === "ui") f.m.uiPrompt(true); else if (mode === "input") f.m.inputPending(true);
    else f.holds[mode] = mode === "editor" ? "unsent user work" : true;
    await p.request("send", { params: params(p, f.owner) });
    const before = f.sent.length, count = intents(f).length;
    await f.m.poll(); assert.equal(f.sent.length, before, mode); assert.equal(intents(f).length, count, mode);
    f.m.uiPrompt(false); f.m.inputPending(false); Object.assign(f.holds, { busy: false, pending: false, editor: "" });
    await f.m.poll(); assert.equal(f.sent.length, before + 1, mode);
  }
  assert.equal(f.mailbox.inbox().messages.length, 5);
});

test("integration: exited sender and removed parent bindings fence dispatch and new sends, retaining queued bytes", async t => {
  const f = await parentFixture(t), p = await f.launch(), q = await f.launch("other");
  const e = params(p, f.owner); await p.request("send", { params: e });
  const path = join(f.mailbox.directory, e.id + ".json"), original = readFileSync(path, "utf8");
  p.child.kill("SIGKILL"); await p.exit;
  await f.m.poll(); assert.equal(f.sent.length, 0); assert.equal(intents(f).length, 0);
  f.store.remove(f.owner.conversationId, f.owner.token);
  await assert.rejects(q.request("send", { params: params(q, f.owner) }));
  await f.m.poll(); assert.equal(f.sent.length, 0); assert.equal(readFileSync(path, "utf8"), original);
});

test("integration: reload binding rotation, new-session identity and branch navigation cannot rearm stale child traffic", async t => {
  for (const mode of ["reload", "new", "tree", "fork"]) {
    const f = await parentFixture(t), p = await f.launch(), e = params(p, f.owner);
    await p.request("send", { params: e });
    const path = join(f.mailbox.directory, e.id + ".json"), original = readFileSync(path, "utf8");
    if (mode === "tree") { f.sm.branch(f.sm.getEntries()[0].id); await f.m.poll(); }
    else {
      f.m.detach(); f.runtime.stop();
      if (mode === "new") f.sm.newSession();
      if (mode === "fork") assert.ok(f.sm.createBranchedSession(f.sm.getLeafId()));
      await f.runtime.start(f.ctx, state => f.sm.appendCustomEntry("pi-rex.orientation", state));
      f.m.attach(f.ctx); f.m.enable(); await f.m.poll();
      const current = f.runtime.snapshot();
      if (mode === "reload") assert.equal(current.state.conversationId, f.owner.conversationId);
      else assert.notEqual(current.state.piSessionId, f.owner.piSessionId);
      await assert.rejects(p.request("send", { params: params(p, f.owner) }));
    }
    assert.equal(f.sent.length, 0, mode); assert.equal(f.m.snapshot().returnRequests, 0, mode);
    assert.equal(readFileSync(path, "utf8"), original);
  }
});

test("integration: filesystem refusal, capacity and duplicate logical sends preserve evidence and never wake sender", async t => {
  const f = await parentFixture(t), p = await f.launch();
  const e = params(p, f.owner), first = await p.request("send", { params: e });
  assert.equal(first.state, "queued"); assert.deepEqual(await p.request("send", { params: e }), first);
  await assert.rejects(p.request("send", { params: { ...e, text: "conflict" } }), /Conflicting/);
  assert.equal(f.mailbox.inbox().messages.length, 1); assert.equal(p.events.length, 0);
  chmodSync(f.mailbox.directory, 0o755);
  const unsafe = params(p, f.owner); await assert.rejects(p.request("send", { params: unsafe }), /Unsafe/);
  chmodSync(f.mailbox.directory, 0o700);
  await assert.rejects(p.request("send", { params: unsafe }), /Unsafe/, "cached refusal is not retried after repair");
  const store = new BindingStore(join(f.root, "bindings"));
  const small = new FileMailbox(f.root, f.owner, store, f.own.server, { limits: { entries: 1 } });
  assert.throws(() => small.publish(makeEnvelope(p.endpoint, f.owner, p.requestId, "result", "new")), { code: "capacity" });
  assert.equal(f.mailbox.inbox().messages.length, 1); await f.m.poll(); assert.equal(f.sent.length, 1);
});

test("integration: deterministic cross-process contention rejects busy once without sender retry or data loss", async t => {
  const f = await parentFixture(t), p = await f.launch();
  f.mailbox.inbox(); mkdirSync(join(f.mailbox.directory, ".admission"), { mode: 0o700 });
  const e = params(p, f.owner);
  await assert.rejects(p.request("send", { params: e }), { code: "busy" });
  await assert.rejects(p.request("send", { params: e }), { code: "busy" });
  assert.equal(existsSync(join(f.mailbox.directory, e.id + ".json")), false);
  assert.equal(existsSync(join(f.mailbox.directory, ".admission")), true, "no lock stealing");
  assert.equal(p.events.length, 0); assert.equal(f.sent.length, 0);
});

test("integration: real receiver crashes after publish, intent or enqueue retain all-branch fences and never restore authority", async t => {
  for (const phase of ["pre-intent", "intent", "enqueue-before", "enqueue-after"]) {
    const root = sandbox(t), blockId = rid("block");
    const receiver = await spawnPeer(t, { root, server, blockId });
    const ticket = await receiver.request("prepare");
    const seed = childBootstrap(receiver.ready.state, true, "review", server);
    const sender = await spawnPeer(t, { root, server, seed, sessionId: seed.piSessionId, peers: [receiver.ready.endpoint] });
    await receiver.request("register", { requestId: ticket.requestId, endpoint: sender.ready.endpoint });
    const e = makeEnvelope(sender.ready.endpoint, receiver.ready.endpoint, ticket.requestId, "result", "crash finding");
    await sender.request("send", { params: { to: e.to, requestId: e.requestId, kind: e.kind, text: e.text, id: e.id } });
    if (phase === "pre-intent") {
      receiver.child.kill("SIGKILL"); assert.equal((await receiver.exit).signal, "SIGKILL");
    } else {
      await receiver.request("crash", { phase });
      await assert.rejects(receiver.request("poll"), /fixture exited/);
      assert.equal((await receiver.exit).code, { intent: 71, "enqueue-before": 72, "enqueue-after": 73 }[phase]);
    }
    await assert.rejects(sender.request("send", { params: { to: e.to, requestId: e.requestId,
      kind: "result", text: "parent disappeared", id: uuid() } }), /live|stale|closed|unavailable/i);
    const restarted = await spawnPeer(t, { root, server, blockId, sessionFile: receiver.ready.sessionFile, peers: [sender.ready.endpoint] });
    const observed = await restarted.request("inspect", { envelope: e });
    assert.equal(observed.status, phase === "pre-intent" ? "new" : phase === "enqueue-after" ? "inserted" : "reserved");
    assert.equal(observed.entries.filter(e => e.customType === FOLLOWUP_INTENT).length, phase === "pre-intent" ? 0 : 1);
    assert.equal(observed.entries.filter(e => e.customType === FOLLOWUP_CONTEXT).length, phase === "enqueue-after" ? 1 : 0);
    assert.equal((await restarted.request("enable")).returnRequests, 0);
    assert.equal(restarted.events.length, 0);
    // Navigate away from the crashed branch: all-branch ID fences survive.
    await restarted.request("branch", { entryId: restarted.ready.branch[0].id });
    assert.equal((await restarted.request("inspect", { envelope: e })).status, observed.status);
    assert.equal((await restarted.request("inspect")).snapshot.processingConfirmed, false);
    const mailbox = new FileMailbox(root, e.to, new BindingStore(join(root, "bindings")), server);
    assert.equal(readFileSync(join(mailbox.directory, e.id + ".json"), "utf8").includes("crash finding"), true);
  }
});

test("integration: sender crash after publication leaves uncertain hardlinks and stale admission, not a processing receipt", async t => {
  const f = await parentFixture(t), p = await f.launch(), e = params(p, f.owner);
  await p.request("crash", { phase: "published" });
  await assert.rejects(p.request("send", { params: e }), /fixture exited/); assert.equal((await p.exit).code, 70);
  const names = readdirSync(f.mailbox.directory);
  assert.ok(names.includes(e.id + ".json")); assert.ok(names.includes(".admission"));
  assert.ok(names.some(n => n.startsWith(".tmp-")));
  const before = names.map(name => [name, name.endsWith(".json") ? readFileSync(join(f.mailbox.directory, name), "utf8") : null]);
  await assert.rejects(f.m.poll(), { code: "busy" });
  assert.equal(f.sent.length, 0); assert.equal(f.m.snapshot().processingConfirmed, false);
  assert.deepEqual(names.map(name => [name, name.endsWith(".json") ? readFileSync(join(f.mailbox.directory, name), "utf8") : null]), before);
});
