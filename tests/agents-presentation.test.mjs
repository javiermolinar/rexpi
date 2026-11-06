import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { agentHandleFromIdentity } from "../lib/agent.ts";
import { AgentRuntime } from "../lib/agent-runtime.ts";
import { parseAgentLaunchRelation } from "../lib/agent-relations.ts";
import { AgentsOverlay, presentAgentRows } from "../lib/agents-overlay.ts";
import { binding, identity, rid, server, uuid } from "./fixtures.mjs";

let nextPid = 10_000;
function agentRow(name, sessionId = "workspace") {
  const who = identity("review"); who.piSessionId = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const blockId = rid("block"), pid = nextPid++;
  const bound = binding(who, { blockId, pid });
  return { key: blockId + ":" + pid, sessionId, windowId: rid("window"), blockId, serverInstance: server.instanceId,
    app: "Pi", pid, processName: "node", state: "working", title: name, message: "", cwd: "/project", label: name,
    sessionLabel: "Work", windowLabel: "Main", current: false, native: true, binding: bound };
}
function own(parent, generation = 4) {
  return { state: { version: 1, taskId: parent.binding.taskId, conversationId: parent.binding.conversationId,
    piSessionId: parent.binding.piSessionId, role: parent.binding.role }, server, blockId: parent.blockId, generation };
}
function relation(parent, child, generation = 4) {
  return { handle: agentHandleFromIdentity(child.binding, { runtimeId: uuid(), runId: uuid(), requestId: "launch:" + child.key,
    messageId: uuid(), endpointGeneration: 1 }), endpointGeneration: 1,
    origin: { taskId: parent.binding.taskId, conversationId: parent.binding.conversationId,
      piSessionId: parent.binding.piSessionId, role: parent.binding.role },
    identity: { taskId: child.binding.taskId, conversationId: child.binding.conversationId,
      piSessionId: child.binding.piSessionId, role: child.binding.role },
    childBlockId: child.blockId, childPid: child.pid,
    childBindingId: "sha256:" + createHash("sha256").update(child.binding.token).digest("hex"),
    serverInstance: server.instanceId, hostId: server.hostId,
    parentBlockId: parent.blockId, parentGeneration: generation,
    parentBindingId: "sha256:" + createHash("sha256").update(parent.binding.token).digest("hex"),
    parentName: parent.binding.piSessionId };
}
function status(relation, activity = "idle", result = "pending") {
  return { handle: relation.handle, runtimeId: relation.handle.runtimeId, runId: relation.handle.runId,
    requestId: relation.handle.requestId, lifecycle: { binding: "bound", activity, delivery: "created", result },
    pendingInput: false, resultAvailable: ["ready", "failed", "cancelled"].includes(result), evidence: "retained",
    notice: "retained test evidence" };
}
function setup(rows, relations, statuses = [], options = {}) {
  const parent = rows.find(row => row.binding?.conversationId === relations[0]?.origin.conversationId) ?? rows[0], overlay = new AgentsOverlay({ keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    terminalRows: () => 40, done() {}, refresh() {}, requestRender() {} },
  { snapshot: () => own(parent), evidence: () => ({ relations, statuses }), ...options });
  overlay.setList({ rows, unavailable: 0 });
  return overlay;
}
function lines(overlay, width = 88) {
  return overlay.render(width).map(line => line.replaceAll(CURSOR_MARKER, ""));
}

test("persisted relation schemas reject secrets, stale generations and malformed fences", () => {
  const parent = agentRow("Parent"), child = agentRow("Child"), direct = relation(parent, child);
  assert.deepEqual(parseAgentLaunchRelation(direct), direct);
  for (const candidate of [{ ...direct, token: "secret" }, { ...direct, endpointGeneration: 2 },
    { ...direct, parentGeneration: -1 }, { ...direct, parentBindingId: "token" }, { ...direct, childBindingId: "token" },
    { ...direct, childPid: 0 }])
    assert.throws(() => parseAgentLaunchRelation(candidate));
});

test("cached status presentation performs no peer read and never infers completion from idle", () => {
  const parent = agentRow("Parent"), child = agentRow("Child"), direct = relation(parent, child);
  let reads = 0;
  const runtime = new AgentRuntime({ async agentActivity() { reads++; throw new Error("unexpected peer read"); } });
  runtime.register(direct.handle);
  runtime.observe(direct.handle, { type: "binding.verified" });
  runtime.observe(direct.handle, { type: "activity.sample", idle: true, pendingMessages: false });
  runtime.observe(direct.handle, { type: "activity.settled" });
  const cached = runtime.cachedStatuses();
  assert.equal(reads, 0);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].lifecycle.activity, "settled");
  assert.equal(cached[0].lifecycle.result, "pending");
  assert.equal(cached[0].resultAvailable, false);
  assert.equal(cached[0].evidence, "retained");
});

test("verified direct and nested relations are stable real rows with Unicode and ASCII fallbacks", () => {
  const parent = agentRow("Parent"), child = agentRow("Child"), grandchild = agentRow("Grandchild"), other = agentRow("Other");
  const relations = [relation(parent, child), relation(child, grandchild)];
  for (const [ascii, marker] of [[false, "↳"], [true, "+-"]]) {
    const presented = presentAgentRows([child, grandchild, other, parent], own(parent), { relations, statuses: [] }, ascii);
    assert.deepEqual(presented.map(item => item.row.title), ["Other", "Parent", "Child", "Grandchild"]);
    assert.equal(presented[2].presentation.prefix, marker + " ");
    assert.equal(presented[3].presentation.prefix, "  " + marker + " ");
    assert.equal(presented[2].presentation.parent, "parent:Parent");
    assert.equal(presented[2].presentation.activity.text, "act:?");
    assert.equal(presented[2].presentation.result.text, "result:?");
    assert.equal(presented[1].presentation, undefined, "the root is not a synthetic subagent");
  }
});

test("self, cycles, excess depth, stale fences and ambiguity never create live hierarchy", () => {
  const parent = agentRow("Parent"), child = agentRow("Child");
  const direct = relation(parent, child);
  let presented = presentAgentRows([parent, child], own(parent), { relations: [relation(child, child)], statuses: [] });
  assert.equal(presented.find(item => item.row === child).presentation.depth, 0);
  assert.match(presented.find(item => item.row === child).presentation.parent, /^parent:/);
  presented = presentAgentRows([parent, child], own(parent), { relations: [{ ...direct, parentGeneration: 3 }], statuses: [] });
  assert.equal(presented[1].presentation.depth, 0);
  assert.match(presented[1].presentation.parent, /^history:/);
  presented = presentAgentRows([parent, child], own(parent), { relations: [{ ...direct, childPid: child.pid + 1 }], statuses: [] });
  assert.equal(presented[1].presentation.depth, 0);
  assert.match(presented[1].presentation.parent, /^history:/);
  presented = presentAgentRows([parent, child], own(parent), { relations: [{ ...direct, childBindingId: "sha256:" + "0".repeat(64) }], statuses: [] });
  assert.equal(presented[1].presentation.depth, 0);
  assert.match(presented[1].presentation.parent, /^history:/);
  presented = presentAgentRows([parent, child], own(parent), { relations: [{ ...direct, parentBindingId: "sha256:" + "0".repeat(64) }], statuses: [] });
  assert.equal(presented[1].presentation.depth, 0);
  assert.match(presented[1].presentation.parent, /^history:/);
  const duplicate = { ...parent, key: "duplicate", pid: nextPid++ };
  presented = presentAgentRows([parent, duplicate, child], own(parent), { relations: [direct], statuses: [] });
  assert.equal(presented.at(-1).presentation.depth, 0);
  assert.match(presented.at(-1).presentation.parent, /^parent:/);
  const a = agentRow("A"), b = agentRow("B");
  presented = presentAgentRows([a, b], own(a), { relations: [relation(a, b), relation(b, a)], statuses: [] });
  assert.ok(presented.every(item => !item.presentation || item.presentation.depth === 0));
  const chain = [parent];
  const relations = [];
  for (let index = 0; index < 6; index++) {
    const next = agentRow("Level " + (index + 1));
    relations.push(relation(chain.at(-1), next)); chain.push(next);
  }
  presented = presentAgentRows(chain, own(parent), { relations, statuses: [] });
  assert.deepEqual(presented.map(item => item.presentation?.depth ?? 0), [0, 1, 2, 3, 4, 0, 0]);
});

test("filtering retains a matching child without expanding its parent or changing key selection", () => {
  const parent = agentRow("Parent"), child = agentRow("Child"), other = agentRow("Other");
  const overlay = setup([parent, child, other], [relation(parent, child)]);
  for (const char of "Child") overlay.handleInput(char);
  const text = lines(overlay).join("\n");
  assert.match(text, /↳ Child/); assert.match(text, /parent:Parent/); assert.doesNotMatch(text, /Other/);
  assert.equal(overlay.selectedRow().key, child.key);
  overlay.input.setValue(""); overlay.setList({ rows: [parent, child, other], unavailable: 0 });
  assert.equal(overlay.selectedRow().key, child.key);
  overlay.setList({ rows: [other, child, parent], unavailable: 0 });
  assert.equal(overlay.selectedRow().key, child.key);
  overlay.handleInput("\r");
});

test("cached activity and result evidence stay independent, including missing and settled states", () => {
  const parent = agentRow("Parent"), settled = agentRow("Settled"), ready = agentRow("Ready"), failed = agentRow("Failed"), missing = agentRow("Missing");
  const relations = [relation(parent, settled), relation(parent, ready), relation(parent, failed), relation(parent, missing)];
  const statuses = [status(relations[0], "settled", "pending"), status(relations[1], "idle", "ready"),
    status(relations[2], "running", "failed")];
  const presented = presentAgentRows([parent, settled, ready, failed, missing], own(parent), { relations, statuses });
  assert.equal(presented[1].presentation.activity.text, "act:settled");
  assert.equal(presented[1].presentation.result.text, "result:pending");
  assert.equal(presented[2].presentation.result.text, "result:ready");
  assert.equal(presented[3].presentation.activity.text, "act:running");
  assert.equal(presented[3].presentation.result.text, "result:failed");
  assert.equal(presented[4].presentation.activity.text, "act:?");
  assert.equal(presented[4].presentation.result.text, "result:?");
  const unrelated = agentRow("Same task");
  unrelated.binding.taskId = parent.binding.taskId;
  assert.equal(presentAgentRows([parent, unrelated], own(parent), { relations: [], statuses }).at(-1).presentation, undefined,
    "taskId alone is not hierarchy evidence");
  const replaced = status(relations[0], "settled", "ready"); replaced.lifecycle.binding = "replaced";
  const stale = presentAgentRows([parent, settled], own(parent), { relations: [relations[0]], statuses: [replaced] });
  assert.equal(stale[1].presentation.depth, 0);
  assert.match(stale[1].presentation.parent, /^history:/);
  assert.equal(stale[1].presentation.result.text, "result:ready", "terminal result evidence survives replacement");
});

test("wide, medium, narrow and ASCII layouts bound every line and preserve two-line rows", () => {
  const parent = agentRow("Parent"), child = agentRow("Child with a long delegated title");
  const direct = relation(parent, child), evidence = [status(direct, "settled", "pending")];
  const unicode = setup([parent, child], [direct], evidence);
  assert.match(lines(unicode, 88).join("\n"), /↳ .*parent:Parent.*act:settled.*result:pending/);
  assert.match(lines(unicode, 60).join("\n"), /parent:Parent.*act:settled.*result:pending/);
  assert.doesNotMatch(lines(unicode, 59).join("\n"), /act:settled/);
  assert.match(lines(unicode, 50).join("\n"), /result:pending/);
  assert.doesNotMatch(lines(unicode, 50).join("\n"), /act:settled/);
  assert.match(lines(unicode, 30).join("\n"), /A:s.*R:p/);
  const ascii = setup([parent, child], [direct], evidence, { ascii: true });
  assert.match(lines(ascii, 88).join("\n"), /\+- Child/);
  for (const overlay of [unicode, ascii]) for (const width of [1, 2, 10, 24, 28, 35, 40, 59, 72, 100])
    for (const line of lines(overlay, width)) assert.ok(visibleWidth(line) <= width, `overflow at ${width}`);
});

test("wide boundary rows preserve lifecycle badges and native status before parent or title text", () => {
  const parent = agentRow("Parent with a very long name ".repeat(8)), child = agentRow("Child with a very long delegated title ".repeat(8));
  const direct = relation(parent, child), overlay = setup([parent, child], [direct], [status(direct, "settled", "pending")]);
  for (const width of [60, 64]) {
    const childLine = lines(overlay, width).find(line => line.includes("↳"));
    assert.ok(childLine, `child row at ${width}`);
    assert.match(childLine, /act:settled/);
    assert.match(childLine, /result:pending/);
    assert.match(childLine, /●/);
    assert.doesNotMatch(childLine, /Working/);
    assert.ok(visibleWidth(childLine) <= width);
  }
  const wideChild = lines(overlay, 72).find(line => line.includes("↳"));
  assert.match(wideChild, /act:settled/);
  assert.match(wideChild, /result:pending/);
  assert.match(wideChild, /● Working/);
});

test("refresh evidence failures remove stale relation badges without retargeting selection", () => {
  const parent = agentRow("Parent"), child = agentRow("Child");
  let fail = false;
  const overlay = setup([parent, child], [relation(parent, child)], [], { evidence: () => {
    if (fail) throw new Error("partial relation evidence");
    return { relations: [relation(parent, child)], statuses: [] };
  } });
  overlay.handleInput("\x1b[B");
  assert.equal(overlay.selectedRow().key, child.key);
  fail = true; overlay.setList({ rows: [parent, child], unavailable: 0 });
  assert.equal(overlay.selectedRow().key, child.key);
  assert.doesNotMatch(lines(overlay).join("\n"), /↳|act:|result:|history:/);
});
