import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeTunnelJournal } from "../lib/tunnel-journal.ts";
import { sandbox, uuid } from "./fixtures.mjs";

function record() {
  return {
    version: 1,
    attemptId: uuid(),
    hostId: "host:debian",
    hostAlias: "debian",
    request: {
      hostId: "host:debian", hostAlias: "debian", sshTarget: "debian",
      localSocketPath: "/tmp/rex-debian.sock", remoteSocketPath: "/run/user/1000/rex.sock",
    },
    staging: { directory: "/tmp/.rexpi-attempt", path: "/tmp/.rexpi-attempt/forward.sock" },
    controller: { pid: 1000, startToken: "controller start" },
    ssh: { pid: 1001, startToken: "ssh start" },
  };
}

test("journal records persist atomically and close removes only the exact attempt", async t => {
  const root = sandbox(t), journal = new NodeTunnelJournal(join(root, "tunnels"));
  const first = record(), other = { ...record(), attemptId: uuid() };
  await journal.create(first);
  await journal.create(other);
  await assert.rejects(journal.create(first), /EEXIST/);
  assert.equal((await journal.read(first.hostId)).length, 2);

  const updated = { ...first, stagingIdentity: "1:2", publicIdentity: "1:2" };
  await journal.update(updated);
  assert.deepEqual((await journal.read(first.hostId)).find(value => value.attemptId === first.attemptId), updated);
  await journal.remove(first);
  assert.deepEqual((await journal.read(first.hostId)).map(value => value.attemptId), [other.attemptId]);
  await journal.remove(other);
  assert.deepEqual(await journal.read(first.hostId), []);
});
