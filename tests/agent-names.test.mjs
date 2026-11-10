import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { canonicalAgentName, generateAgentName, parseAgentName } from "../lib/agent-name.ts";
import { AgentNameStore } from "../lib/agent-name-store.ts";
import { BindingStore } from "../lib/store.ts";
import { binding, identity, sandbox, uuid } from "./fixtures.mjs";

test("generated names are memorable lowercase word pairs with case-insensitive lookup input", () => {
  for (let i = 0; i < 100; i++) {
    const name = generateAgentName();
    assert.equal(parseAgentName(name), name);
  }
  assert.equal(canonicalAgentName("  QUIET-OTTER  "), "quiet-otter");
  for (const value of ["", "quiet", "quiet_otter", "-quiet-otter", "quiet-otter!", "x".repeat(65), 3])
    assert.throws(() => canonicalAgentName(value));
});

test("name assignment persists independently of leases and never reuses a retained alias", t => {
  const bindings = new BindingStore(join(sandbox(t), "bindings"));
  const generated = ["quiet-otter", "quiet-otter", "amber-fox"];
  const names = new AgentNameStore(bindings, () => generated.shift() ?? "calm-fox");
  const who = identity(), other = identity(), lease = binding(who);
  bindings.write(lease);
  assert.equal(names.assign(who), "quiet-otter");
  assert.equal(names.assign(who), "quiet-otter");
  assert.equal(statSync(names.directory).mode & 0o777, 0o700);
  assert.equal(names.resolve(" QUIET-OTTER ").conversationId, who.conversationId);
  assert.equal(names.find(who).name, "quiet-otter");
  bindings.remove(lease.conversationId, lease.token);
  assert.equal(names.assign(other), "amber-fox");
  assert.equal(names.resolve("quiet-otter").conversationId, who.conversationId);
  assert.equal(names.resolve("amber-fox").conversationId, other.conversationId);
  assert.throws(() => names.resolve("missing-agent"), /Unknown or ambiguous/);
});

test("one conversation cannot acquire conflicting identities or multiple names", t => {
  const bindings = new BindingStore(join(sandbox(t), "bindings"));
  const names = new AgentNameStore(bindings, () => "quiet-otter"), who = identity();
  assert.equal(names.assign(who), "quiet-otter");
  assert.throws(() => names.assign({ ...who, taskId: uuid() }), /different conversation identity/);
  assert.throws(() => names.find({ ...who, taskId: uuid() }), /different conversation identity/);
  assert.equal(names.assign(who), "quiet-otter");
});

test("an exhausted generator fails closed instead of assigning a duplicate", t => {
  const bindings = new BindingStore(join(sandbox(t), "bindings"));
  const names = new AgentNameStore(bindings, () => "quiet-otter");
  names.assign(identity());
  assert.throws(() => names.assign(identity()), /Could not allocate/);
});
