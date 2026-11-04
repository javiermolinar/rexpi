import test from "node:test";
import assert from "node:assert/strict";
import { AgentBrowser, agentText, processAgent } from "../lib/agents.ts";
import { active, binding, rid, uuid } from "./fixtures.mjs";

function report(app, pid, state = "idle", extra = {}) {
  return { app, effective_app: app, state, updated_at: new Date().toISOString(), owner: { pid, name: "node" }, ...extra };
}
function add(a, { app = "pi", pid = 12345, state = "idle", sessionId = a.w.source.sessionId, windowId = a.w.source.windowId, ...overrides } = {}) {
  const target = { sessionId, windowId, blockId: rid("block"), ...overrides };
  a.w.blocks.set(target.blockId, target);
  a.w.processData.set(target.blockId, { foreground: { pid, name: "node", cwd: "/project" } });
  a.w.statuses.set(target.blockId, { records: [report(app, pid, state)] });
  return target;
}
function mutations(w) { return w.calls.filter(args => args.includes("session.focus_block") || args.includes("do") || args.includes("new") || args.includes("send") || args.includes("kill")); }

test("agents in splits are separate rows, across tabs and sessions, without discovery effects", async t => {
  const a = await active(t), browser = new AgentBrowser(a.runtime);
  a.w.statuses.set(a.w.source.blockId, { records: [report("pi", process.pid, "working")] });
  const split = add(a, { state: "blocked", pid: 12345 });
  const tab = add(a, { app: "claude", windowId: rid("window"), pid: 12346 });
  const other = add(a, { app: "codex", sessionId: rid("session"), windowId: rid("window"), pid: 12347, state: "error" });
  a.w.sessionLabels.set(other.sessionId, "Other project");
  const result = await browser.list();
  assert.equal(result.rows.length, 4);
  assert.equal(result.unavailable, 0);
  assert.equal(result.rows[0].blockId, split.blockId);
  assert.equal(result.rows.find(r => r.blockId === tab.blockId).app, "Claude");
  assert.equal(result.rows.at(-1).sessionId, other.sessionId);
  const own = result.rows.find(r => r.current);
  assert.equal(own.binding.conversationId, a.runtime.snapshot().state.conversationId);
  assert.equal(own.state, "working");
  assert.equal(mutations(a.w).length, 0);
});
test("nested records for one process collapse to its most urgent state, distinct processes remain distinct", async t => {
  const a = await active(t), target = add(a);
  a.w.statuses.set(target.blockId, { records: [report("pi", 12345), report("pi", 12345, "working", { id: "task" }),
    report("pi", 12345, "blocked", { id: "task/question", msg: "Needs approval" }), report("claude", 12346, "error")] });
  a.w.processData.set(target.blockId, { foreground: { pid: 12345, name: "node" }, ancestors: [{ pid: 12346, name: "node" }] });
  const rows = (await new AgentBrowser(a.runtime).list()).rows.filter(r => r.blockId === target.blockId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, "blocked");
  assert.equal(rows[0].message, "Needs approval");
});
test("unreported bound Pi has unknown status; stale native owners and non-agent programs are omitted", async t => {
  const a = await active(t);
  add(a, { app: "cargo" });
  const stale = add(a, { pid: 12346 });
  a.w.processData.set(stale.blockId, { foreground: { pid: 12346, name: "different executable" } });
  const result = await new AgentBrowser(a.runtime).list();
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].native, false);
  assert.equal(result.rows[0].state, "unknown");
});
test("Claude's versioned native executable appears in an adjacent split without status reports", async t => {
  const a = await active(t), peer = add(a), browser = new AgentBrowser(a.runtime);
  a.w.statuses.set(peer.blockId, { records: [] });
  a.w.processData.set(peer.blockId, {
    foreground: { pid: 22601, name: "2.1.245", path: "/home/test/.local/share/claude/versions/2.1.245", argv0: "claude", cwd: "/project" },
    child: { pid: 22571, name: "login", path: "/usr/bin/login" },
    ancestors: [{ pid: 22572, name: "fish", argv0: "-fish" }],
  });
  a.w.titles.set(peer.blockId, { title: "✳ Claude Code", owner: { pid: 22601, name: "2.1.245" } });
  const result = await browser.list();
  const claude = result.rows.find(row => row.blockId === peer.blockId);
  assert.ok(claude);
  assert.equal(claude.app, "Claude");
  assert.equal(claude.state, "unknown");
  assert.equal(claude.processName, "2.1.245");
  assert.equal(claude.processDetected, true);
  assert.equal(claude.native, false);
  assert.equal(claude.conversationTitle, "✳ Claude Code");
  assert.equal(mutations(a.w).length, 0);
  await browser.focus(claude);
  assert.equal(a.w.selected.blockId, peer.blockId);
  assert.equal(a.w.selectCalls ?? 0, 0);
  a.w.statuses.set(peer.blockId, { records: [report("claude", 22601, "working", { owner: { pid: 22601, name: "2.1.245" } })] });
  const reported = (await browser.list()).rows.filter(row => row.blockId === peer.blockId);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].key, claude.key);
  assert.equal(reported[0].state, "working");
});
test("recognized nonreporting agents use process metadata, never stale titles or directory names", async t => {
  const a = await active(t), browser = new AgentBrowser(a.runtime);
  const peer = add(a);
  a.w.statuses.set(peer.blockId, { records: [] });
  a.w.processData.set(peer.blockId, { foreground: { pid: 12345, name: "node", script: "/opt/node_modules/@openai/codex/bin/codex.js", cwd: "/project" } });
  let row = (await browser.list()).rows.find(row => row.blockId === peer.blockId);
  assert.equal(row.app, "Codex");
  assert.equal(row.state, "unknown");
  a.w.processData.set(peer.blockId, { foreground: { pid: 12345, name: "fish", argv0: "-fish", cwd: "/projects/claude" } });
  a.w.titles.set(peer.blockId, { title: "Claude Code", owner: { pid: 12345, name: "fish" } });
  assert.equal((await browser.list()).rows.some(row => row.blockId === peer.blockId), false);
});
test("process-only agent selection revalidates the CLI identity even if PID and executable name stay unchanged", async t => {
  const a = await active(t), peer = add(a), browser = new AgentBrowser(a.runtime);
  a.w.statuses.set(peer.blockId, { records: [] });
  a.w.processData.set(peer.blockId, { foreground: { pid: 12345, name: "node", argv0: "claude" } });
  const row = (await browser.list()).rows.find(row => row.blockId === peer.blockId);
  a.w.processData.set(peer.blockId, { foreground: { pid: 12345, name: "node", argv0: "node", script: "/project/server.js" } });
  await assert.rejects(browser.focus(row), /no longer identifiable/);
  assert.equal(mutations(a.w).length, 0);
});
test("process agent recognition handles wrappers and rejects conflicting identities", () => {
  for (const [metadata, app] of [
    [{ argv0: "claude", name: "2.1.245" }, "Claude"],
    [{ path: "/home/test/.local/share/claude/versions/2.1.245" }, "Claude"],
    [{ name: "node", script: "/opt/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" }, "Pi"],
    [{ argv0: "/usr/bin/codex" }, "Codex"],
    [{ name: "opencode" }, "OpenCode"],
    [{ script: "/opt/node_modules/@google/gemini-cli/dist/index.js" }, "Gemini"],
    [{ name: "fish", cwd: "/project/claude" }, undefined],
    [{ name: "node", script: "/project/claude/app.js" }, undefined],
    [{ name: "node", argv0: "claude", script: "/opt/node_modules/@openai/codex/bin/codex.js" }, undefined],
  ]) assert.equal(processAgent(metadata), app);
});
test("remote and nonterminal panes are excluded before reading them", async t => {
  const a = await active(t);
  const remote = add(a, { hostId: uuid() });
  const nonterminal = add(a, { creator: "browser" });
  await new AgentBrowser(a.runtime).list();
  assert.equal(a.w.calls.some(args => args.includes(remote.blockId) || args.includes(nonterminal.blockId)), false);
});
test("unreadable panes and unavailable native status are reported without hiding healthy agents", async t => {
  const a = await active(t), peer = add(a);
  a.w.unreadable.add(peer.blockId + ":process");
  a.w.unreadable.add(a.w.source.blockId + ":program_status");
  const result = await new AgentBrowser(a.runtime).list();
  assert.equal(result.unavailable, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].state, "unknown");
});
test("future native status values are treated as idle, not success", async t => {
  const a = await active(t), peer = add(a, { state: "future-state" });
  const row = (await new AgentBrowser(a.runtime).list()).rows.find(r => r.blockId === peer.blockId);
  assert.equal(row.state, "idle");
});
test("same-session split selection needs no app or Remote Control", async t => {
  const a = await active(t), peer = add(a), browser = new AgentBrowser(a.runtime);
  a.w.apps = []; a.w.remoteControl = false;
  const row = (await browser.list()).rows.find(r => r.blockId === peer.blockId);
  const target = await browser.focus(row);
  assert.equal(target.blockId, peer.blockId);
  assert.equal(a.w.selected.blockId, peer.blockId);
  assert.equal(a.w.selectCalls ?? 0, 0);
});
test("selection follows an agent moved since discovery by exact pane ID", async t => {
  const a = await active(t), peer = add(a), browser = new AgentBrowser(a.runtime);
  const row = (await browser.list()).rows.find(r => r.blockId === peer.blockId);
  const moved = { ...peer, sessionId: rid("session"), windowId: rid("window") };
  a.w.blocks.set(peer.blockId, moved);
  const target = await browser.focus(row);
  assert.equal(target.sessionId, moved.sessionId);
  assert.equal(target.windowId, moved.windowId);
  assert.equal(a.w.selectCalls, 1);
});
test("closed panes, replaced process names and missing native owners cannot receive focus", async t => {
  for (const kind of ["closed", "name", "status"]) await t.test(kind, async t => {
    const a = await active(t), peer = add(a), browser = new AgentBrowser(a.runtime);
    const row = (await browser.list()).rows.find(r => r.blockId === peer.blockId);
    if (kind === "closed") a.w.blocks.delete(peer.blockId);
    if (kind === "name") a.w.processData.set(peer.blockId, { foreground: { pid: row.pid, name: "replacement" } });
    if (kind === "status") a.w.statuses.set(peer.blockId, { records: [] });
    await assert.rejects(browser.focus(row), /closed|process|status/);
    assert.equal(mutations(a.w).length, 0);
  });
});
test("cross-session Remote Control denial is reported once without fallback or retry", async t => {
  const a = await active(t), peer = add(a, { sessionId: rid("session"), windowId: rid("window") }), browser = new AgentBrowser(a.runtime);
  const row = (await browser.list()).rows.find(r => r.blockId === peer.blockId);
  a.w.remoteControl = false;
  await assert.rejects(browser.focus(row), /Remote Control/);
  assert.equal(a.w.selectCalls, 1);
  assert.equal(a.w.focusCalls ?? 0, 0);
});
test("replacement during app capability lookup and changed Pi bindings prevent focus", async t => {
  const a = await active(t), peer = add(a, { sessionId: rid("session"), windowId: rid("window") }), browser = new AgentBrowser(a.runtime);
  const row = (await browser.list()).rows.find(r => r.blockId === peer.blockId);
  a.w.onActions = () => a.w.processData.set(peer.blockId, { foreground: { pid: 55555, name: "node" } });
  await assert.rejects(browser.focus(row), /process/);
  assert.equal(mutations(a.w).length, 0);
  const own = (await browser.list()).rows.find(r => r.current);
  a.store.write(binding({ ...own.binding }, { blockId: own.blockId, token: uuid() }));
  await assert.rejects(browser.focus(own), /uniquely live|multiple Rex|competing/);
});
test("process replacement during app selection prevents the subsequent pane focus", async t => {
  const a = await active(t), peer = add(a, { sessionId: rid("session"), windowId: rid("window") }), browser = new AgentBrowser(a.runtime);
  const row = (await browser.list()).rows.find(r => r.blockId === peer.blockId);
  a.w.onSelect = () => a.w.processData.set(peer.blockId, { foreground: { pid: 55555, name: "node" } });
  await assert.rejects(browser.focus(row), /process/);
  assert.equal(a.w.selectCalls, 1);
  assert.equal(a.w.focusCalls ?? 0, 0);
});
test("cancelled discovery and stale server/source cannot navigate", async t => {
  const a = await active(t), browser = new AgentBrowser(a.runtime), controller = new AbortController();
  controller.abort();
  await assert.rejects(browser.list(controller.signal));
  const row = (await browser.list()).rows[0];
  await assert.rejects(browser.focus({ ...row, serverInstance: uuid() }), /earlier Rex server/);
  a.runtime.stop();
  await assert.rejects(browser.focus(row));
  assert.equal(mutations(a.w).length, 0);
});
test("conversation titles are used only when owned by the exact live agent process", async t => {
  const a = await active(t), peer = add(a), browser = new AgentBrowser(a.runtime);
  a.w.titles.set(peer.blockId, { title: "π - Conversation - project", owner: { pid: 12345, name: "node" } });
  let row = (await browser.list()).rows.find(r => r.blockId === peer.blockId);
  assert.equal(row.conversationTitle, "π - Conversation - project");
  a.w.titles.set(peer.blockId, { title: "Stale shell title", owner: { pid: 12345, name: "fish" } });
  row = (await browser.list()).rows.find(r => r.blockId === peer.blockId);
  assert.equal(row.conversationTitle, undefined);
  a.w.unreadable.add(peer.blockId + ":title");
  const result = await browser.list();
  assert.equal(result.rows.some(r => r.blockId === peer.blockId), true);
  assert.equal(result.unavailable, 0);
});
test("agent display data is sanitized and bounded", () => {
  assert.equal(agentText("\x1b[31mhello\x1b[0m\nworld\u202e"), "hello world");
  assert.equal(agentText("\x1b]8;;https://example.org\x07link\x1b]8;;\x07"), "link");
  assert.equal(agentText("x".repeat(10000)).length, 300);
});
