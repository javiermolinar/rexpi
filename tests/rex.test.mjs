import test from "node:test";
import assert from "node:assert/strict";
import { Rex } from "../lib/rex.ts";
import { rid, uuid, world } from "./fixtures.mjs";

test("adapter pins a verified local endpoint and uses argv, not a shell", async () => {
  const w = world(), rex = new Rex("/bin/echo", w.exec);
  await rex.initialize(w.source.blockId);
  const target = await rex.locate(w.source.blockId);
  assert.deepEqual(target, w.source);
  await rex.verifyProcess(target, process.pid);
  assert.ok(w.calls.slice(1).every(call => call.includes("-S") && call.includes(w.server.endpoint)));
  assert.ok(w.calls.every(call => call[0] === "--autostart=false"));
});
test("adapter refuses inherited stale IDs, remote transports and remote blocks", async () => {
  const w = world(), rex = new Rex("/bin/echo", w.exec);
  await assert.rejects(rex.initialize(rid("block")), /exact/);
  w.remote = true;
  await assert.rejects(rex.initialize(w.source.blockId), /local/);
  w.remote = false;
  await rex.initialize(w.source.blockId);
  w.source.hostId = uuid();
  await assert.rejects(rex.locate(w.source.blockId), /remote/);
});
test("server restart and a replaced Pi process fail closed", async () => {
  const w = world(), rex = new Rex("/bin/echo", w.exec);
  await rex.initialize(w.source.blockId);
  w.server.instanceId = uuid();
  await assert.rejects(rex.checkServer(), /instance changed/);
  w.processPids.set(w.source.blockId, 99999999);
  await assert.rejects(rex.verifyProcess(w.source, process.pid), /exact Pi process/);
});
test("location follows full block ID across window moves, never title/index", async () => {
  const w = world(), rex = new Rex("/bin/echo", w.exec);
  await rex.initialize(w.source.blockId);
  const moved = { ...w.source, windowId: rid("window") };
  w.blocks.set(moved.blockId, moved);
  assert.equal((await rex.locate(moved.blockId)).windowId, moved.windowId);
  w.blocks.delete(moved.blockId);
  await assert.rejects(rex.locate(moved.blockId), /closed or detached/);
});
test("app targeting uses pane ownership and refuses ambiguous clients", async () => {
  const w = world(), rex = new Rex("/bin/echo", w.exec);
  await rex.initialize(w.source.blockId);
  assert.equal(await rex.app(w.source), w.source.owner);
  w.apps.push({ client_id: rid("client"), info: { kind: "app" } });
  await assert.rejects(rex.app({ ...w.source, owner: undefined }), /exactly one/);
});
test("app action denial reports the Remote Control setting without dumping arbitrary stderr", async () => {
  const w = world(), rex = new Rex("/bin/echo", w.exec);
  await rex.initialize(w.source.blockId);
  w.remoteControl = false;
  await assert.rejects(rex.select(w.source.owner, w.source), /Enable Remote Control in Rex Settings/);
  const failed = new Rex("/bin/echo", async () => ({ code: 1, stdout: "", stderr: "sensitive launch arguments" }));
  await assert.rejects(failed.json(["whoami", "--json"]), error =>
    error.message.includes("exit 1") && !error.message.includes("sensitive"));
});
test("interruption and truncation have distinct uncertainty diagnostics", async () => {
  for (const [flag, message] of [["killed", /interrupted or timed out/], ["truncated", /output limit/]]) {
    const rex = new Rex("/bin/echo", async () => ({ code: 1, stdout: "", stderr: "", [flag]: true }));
    await assert.rejects(rex.json(["whoami", "--json"]), message);
  }
});
test("creation preserves metacharacters as arguments and never uses send/respawn", async () => {
  const w = world(), rex = new Rex("/bin/echo", w.exec);
  await rex.initialize(w.source.blockId);
  const command = ["/usr/bin/env", "X=a b;$HOME", "/tmp/pi with spaces", "--", "task; $(touch /tmp/no)"];
  const created = await rex.create({ placement: "down", source: w.source, cwd: "/tmp/a b", title: "task", focus: false, command });
  assert.equal(created.blockId, w.next.blockId);
  const args = w.created[0];
  assert.ok(args.includes("--split=below"));
  assert.ok(args.includes("--shell=none"));
  assert.ok(args.includes("--focus=false"));
  assert.deepEqual(args.slice(args.indexOf("--") + 1), command);
  assert.equal(w.calls.some(c => c.includes("send") || c.includes("respawn")), false);
});
