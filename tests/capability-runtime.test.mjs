import test from "node:test";
import assert from "node:assert/strict";
import { attenuateCapabilityGrant, CapabilityRuntime } from "../lib/capability-runtime.ts";

function grant(change = {}) {
  return { tools: ["read", "custom_tool", "rex_start_pi", "rex_message_send", "rex_return_to_parent"],
    readPaths: ["/repo", "/exact[literal]"], writePaths: ["/repo/output"],
    delegation: { maxDepth: 2 }, returnResults: true, turns: 3, timeoutMs: 1000, ...change };
}
function child(change = {}) {
  return { tools: ["read"], readPaths: ["/repo"], writePaths: [], delegation: { maxDepth: 0 },
    returnResults: false, turns: 2, timeoutMs: 500, ...change };
}
function fakeClock() {
  let now = 0, sequence = 0;
  const timers = new Map();
  return {
    timers,
    now: () => now,
    setTimeout(callback, timeoutMs) {
      const timer = { id: ++sequence, at: now + timeoutMs, callback, unrefs: 0,
        unref() { this.unrefs++; } };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer.id); },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.values()].filter(timer => timer.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due.id);
        due.callback();
      }
    },
  };
}
function context() {
  return { aborts: 0, abort() { this.aborts++; } };
}
function runtime(t, value = grant()) {
  const clock = fakeClock(), notices = [];
  const capability = new CapabilityRuntime(value, { clock, onNotice: message => notices.push(message) });
  t.after(() => capability.revoke());
  return { capability, clock, notices };
}

test("the global tool gate allows only literal names for direct, built-in, custom, and nested calls", t => {
  const { capability } = runtime(t);
  assert.equal(capability.guardTool("read", {}, context()), undefined);
  assert.equal(capability.guardTool("custom_tool", {}, context()), undefined);
  assert.equal(capability.guardTool("custom_tool", { nested: true }, context()), undefined);
  for (const name of ["bash", "write", "custom_other", "codemode"])
    assert.equal(capability.guardTool(name, { nested: { toolName: "read" } }, context()).block, true);
  assert.equal(capability.guardTool("read", { nested: true }, context()), undefined,
    "nested execution reaches the same global gate");
  capability.revoke();
  assert.match(capability.guardTool("read", {}).reason, /revoked/);
});

test("delegation zero and omitted child grants cannot create an ungoverned child", t => {
  const { capability } = runtime(t, grant({ delegation: { maxDepth: 0 } }));
  assert.throws(() => capability.deriveChildOptions({ related: true, grant: child() }), /maxDepth must be greater than zero/);
  const delegated = runtime(t);
  assert.throws(() => delegated.capability.deriveChildOptions({ related: true }), /explicit child grant/);
  assert.match(delegated.capability.guardTool("rex_start_pi", { related: true }).reason, /explicit child grant/);
});

test("a valid child is explicitly attenuated and propagated without mutating parent arrays", t => {
  const { capability, clock } = runtime(t);
  const parentTools = ["read"];
  const options = { related: true, grant: child({ tools: parentTools, delegation: { maxDepth: 1 }, returnResults: true }) };
  clock.advance(250);
  const derived = capability.deriveChildOptions(options);
  assert.notEqual(derived, options);
  assert.notEqual(derived.grant, options.grant);
  assert.deepEqual(derived.grant, options.grant);
  assert.equal(derived.returnResults, undefined, "grant returnResults is not focus/result-return setup");
  parentTools.push("rex_message_send");
  assert.deepEqual(derived.grant.tools, ["read"], "the validated child is a private parsed copy");
});

test("every child authority expansion vector is denied before launch", t => {
  const parent = grant();
  const invalid = [
    child({ tools: ["bash"] }), child({ readPaths: ["/other"] }), child({ writePaths: ["/other"] }),
    child({ delegation: { maxDepth: 2 } }), child({ returnResults: true, turns: 2 }),
    child({ turns: 4 }), child({ timeoutMs: 1001 }),
  ];
  // returnResults expansion needs a parent which cannot return results.
  assert.throws(() => attenuateCapabilityGrant({ ...parent, returnResults: false }, invalid[4], 1000), /returnResults/);
  for (const [index, value] of invalid.entries()) {
    if (index === 4) continue;
    assert.throws(() => attenuateCapabilityGrant(parent, value, 1000), /Capability delegation denied/, String(index));
  }
  assert.deepEqual(attenuateCapabilityGrant(parent, child({ delegation: { maxDepth: 1 }, returnResults: true }), 500),
    child({ delegation: { maxDepth: 1 }, returnResults: true }));
});

test("child timeout is bounded by the remaining whole-parent timeout", t => {
  const { capability, clock } = runtime(t);
  clock.advance(400);
  assert.equal(capability.deriveChildGrant(child({ timeoutMs: 600 })).timeoutMs, 600);
  assert.throws(() => capability.deriveChildGrant(child({ timeoutMs: 601 })), /remaining parent timeout/);
  clock.advance(600);
  assert.throws(() => capability.deriveChildGrant(child()), /expired/);
});

test("returnResults=false gates only result sends; progress, question, and focus return remain tool-governed", t => {
  const { capability } = runtime(t, grant({ returnResults: false }));
  assert.match(capability.guardTool("rex_message_send", { kind: "result", nested: true }).reason, /returnResults=false/);
  assert.equal(capability.guardTool("rex_message_send", { kind: "progress" }), undefined);
  assert.equal(capability.guardTool("rex_message_send", { kind: "question" }), undefined);
  assert.equal(capability.guardTool("rex_return_to_parent", {}), undefined);
  const restricted = runtime(t, grant({ tools: ["read"], returnResults: false }));
  assert.match(restricted.capability.guardTool("rex_message_send", { kind: "progress" }).reason, /not whitelisted/);
});

test("turn_start permits exactly grant.turns model turns and retains one bounded denial", t => {
  const { capability, notices } = runtime(t, grant({ turns: 2 }));
  const ctx = context();
  assert.equal(capability.startTurn(ctx), true);
  assert.equal(capability.startTurn(ctx), true);
  assert.equal(ctx.aborts, 0);
  assert.equal(capability.startTurn(ctx), false);
  assert.equal(ctx.aborts, 1);
  assert.match(capability.notice, /denied turn 3: at most 2 model turns/);
  assert.ok(capability.notice.length < 160);
  assert.equal(capability.startTurn(ctx), false);
  assert.deepEqual(notices, [capability.notice]);
  assert.match(capability.guardTool("read", {}).reason, /turn limit exhausted/);
});

test("one unref'd consumption timer aborts current work and denies future turns and tools", t => {
  const { capability, clock, notices } = runtime(t, grant({ timeoutMs: 100 }));
  assert.equal(clock.timers.size, 1);
  assert.equal([...clock.timers.values()][0].unrefs, 1);
  clock.advance(50);
  const ctx = context();
  assert.equal(capability.startTurn(ctx), true);
  clock.advance(50);
  assert.equal(ctx.aborts, 1);
  assert.equal(capability.signal.aborted, true);
  assert.equal(capability.startTurn(ctx), false);
  assert.match(capability.guardTool("read", {}).reason, /expired/);
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(notices, ["Capability grant expired; aborted current work and denied future turns"]);
});

test("revocation clears the only timer and permanently denies the old incarnation", t => {
  const { capability, clock, notices } = runtime(t);
  const ctx = context();
  capability.attachContext(ctx);
  capability.revoke();
  capability.revoke();
  assert.equal(ctx.aborts, 1);
  assert.equal(clock.timers.size, 0);
  assert.equal(capability.startTurn(ctx), false);
  assert.match(capability.guardTool("read", {}).reason, /revoked/);
  assert.throws(() => capability.deriveChildGrant(child()), /revoked/);
  clock.advance(5000);
  assert.deepEqual(notices, []);
});
