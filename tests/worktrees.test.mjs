import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorktreeBrowser, parseWorktrees } from "../lib/worktrees.ts";
import { git, gitExec, worktreeFixture } from "./worktree-fixtures.mjs";
import { rid } from "./fixtures.mjs";

const noAgents = async () => ({ rows: [], unavailable: 0 });
function browser(a, options = {}) {
  return new WorktreeBrowser(a.runtime, a.launcher, options.exec ?? gitExec, options.cwd ?? a.repo, options.agents ?? noAgents);
}
async function selected(b, path) { return (await b.list()).rows.find(row => row.path === path); }

test("porcelain -z preserves literal paths and detached/bare/locked/prunable metadata", () => {
  const head = "a".repeat(40), path = '/tmp/spaces\n"quoted"';
  const rows = parseWorktrees(`worktree /tmp/main\0HEAD ${head}\0branch refs/heads/main\0\0worktree ${path}\0HEAD ${head}\0detached\0locked reason\0prunable missing\0\0`);
  assert.equal(rows[0].main, true); assert.equal(rows[1].main, false);
  assert.equal(rows[1].path, path); assert.equal(rows[1].branch, "");
  assert.equal(rows[1].locked, "reason"); assert.equal(rows[1].prunable, "missing");
  assert.equal(parseWorktrees("worktree /tmp/bare\0bare\0\0")[0].bare, true);
  for (const bad of ["", "worktree /tmp/x\0HEAD bad\0\0", `worktree relative\0HEAD ${head}\0\0`,
    `worktree /tmp/x\0HEAD ${head}\0HEAD ${head}\0\0`, `worktree /tmp/x\0HEAD ${head}\0`]) assert.throws(() => parseWorktrees(bad));
});
test("lists the current repository's worktrees without launches or writes", async t => {
  const a = await worktreeFixture(t), calls = [];
  const b = browser(a, { exec: async (...args) => { calls.push(args); return gitExec(...args); } });
  const list = await b.list();
  assert.equal(list.unavailable, 0); assert.equal(list.rows.length, 2);
  assert.equal(list.rows[0].path, a.repo); assert.equal(list.rows[0].main, true); assert.equal(list.rows[0].current, true);
  assert.equal(list.rows[0].deletionIssue, "Main worktree");
  assert.equal(list.rows[1].state, "clean"); assert.equal(list.rows[1].branch, "refs/heads/feature");
  assert.equal(list.rows[1].deletionIssue, "");
  assert.equal(a.launches.length, 0);
  assert.ok(calls.every(([, args]) => !args.includes("remove") && !args.includes("add")));
  assert.ok(calls.every(([, args]) => args.includes("core.fsmonitor=false")));
});
test("detached and prunable worktrees remain visible without pretending to be branches", async t => {
  const a = await worktreeFixture(t);
  git(a.linked, "checkout", "--detach", "-q");
  const b = browser(a), detached = await selected(b, a.linked);
  assert.equal(detached.branch, ""); assert.equal(detached.state, "clean");
  rmSync(a.linked, { recursive: true });
  const prunable = await selected(b, a.linked);
  assert.notEqual(prunable.prunable, undefined); assert.equal(prunable.state, "missing");
  assert.equal(prunable.deletionIssue, "");
  await assert.rejects(b.open("prunable", prunable), /directory is missing/);
  await b.remove(prunable);
  assert.equal((await b.list()).rows.length, 1);
});
test("missing registrations can be removed individually without global pruning or branch deletion", async t => {
  const a = await worktreeFixture(t), stale = join(a.root, "another stale worktree"), calls = [];
  git(a.repo, "worktree", "add", "-qb", "other-stale", stale);
  rmSync(a.linked, { recursive: true }); rmSync(stale, { recursive: true });
  const b = new WorktreeBrowser(a.runtime, a.launcher, async (...args) => { calls.push(args); return gitExec(...args); }, a.repo);
  const list = await b.list(), row = list.rows.find(row => row.path === a.linked);
  assert.equal(list.unavailable, 0);
  assert.equal(list.rows.filter(row => row.state === "missing").length, 2);
  assert.equal(row.deletionIssue, "");
  await b.remove(row);
  const after = await b.list();
  assert.equal(after.rows.some(row => row.path === a.linked), false);
  assert.equal(after.rows.find(row => row.path === stale).state, "missing");
  assert.ok(git(a.repo, "show-ref", "--verify", "refs/heads/feature"));
  const writes = calls.filter(([, args]) => args.includes("remove") || args.includes("prune"));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][1].slice(-4), ["worktree", "remove", "--", a.linked]);
});
test("existing worktrees sort before missing registrations", async t => {
  const a = await worktreeFixture(t), stale = join(a.root, "aaa-stale");
  git(a.repo, "worktree", "add", "-qb", "stale", stale); rmSync(stale, { recursive: true });
  const rows = (await browser(a).list()).rows;
  assert.deepEqual(rows.map(row => row.path), [a.repo, a.linked, stale]);
});
test("a prunable registration with an existing directory is not eligible for cleanup", async t => {
  const a = await worktreeFixture(t);
  rmSync(join(a.linked, ".git")); writeFileSync(join(a.linked, "important"), "do not delete");
  const b = browser(a), row = await selected(b, a.linked);
  assert.notEqual(row.prunable, undefined); assert.equal(row.state, "unavailable");
  await assert.rejects(b.remove(row), /directory still exists/);
  assert.equal(existsSync(join(a.linked, "important")), true);
});
test("missing cleanup refuses reappeared directories, symlinks, locks and incomplete agent discovery", async t => {
  for (const kind of ["directory", "symlink", "locked", "agents"]) await t.test(kind, async t => {
    const a = await worktreeFixture(t);
    rmSync(a.linked, { recursive: true });
    const b = browser(a, { agents: kind === "agents" ? async () => ({ rows: [], unavailable: 1 }) : noAgents });
    const row = await selected(b, a.linked);
    assert.equal(row.state, "missing");
    if (kind === "directory") { mkdirSync(a.linked); writeFileSync(join(a.linked, "important"), "keep"); }
    if (kind === "symlink") symlinkSync(join(a.root, "no-such-target"), a.linked);
    if (kind === "locked") git(a.repo, "worktree", "lock", a.linked);
    await assert.rejects(b.remove(row), /changed|Cannot remove/);
    assert.ok(git(a.repo, "worktree", "list", "--porcelain").includes(a.linked));
    if (kind === "directory") assert.equal(existsSync(join(a.linked, "important")), true);
  });
});
test("bare repositories are visible but cannot be opened or removed", async t => {
  const a = await worktreeFixture(t), bare = join(a.root, "bare.git");
  mkdirSync(bare); git(bare, "init", "--bare", "-q");
  const b = browser(a, { cwd: bare }), row = (await b.list()).rows[0];
  assert.equal(row.bare, true); assert.equal(row.main, true);
  await assert.rejects(b.open("bare", row), /unavailable/);
  await assert.rejects(b.remove(row), /Cannot remove/);
});
test("outside a repository and oversized Git output fail without native effects", async t => {
  const a = await worktreeFixture(t), outside = browser(a, { cwd: a.root });
  await assert.rejects(outside.list(), /Cannot read Git/);
  const b = browser(a, { exec: async () => ({ code: 0, stdout: "", stderr: "", truncated: true }) });
  await assert.rejects(b.list(), /output limit/);
  assert.equal(a.launches.length, 0); assert.equal(existsSync(a.linked), true);
});
test("opens a selected worktree through the guarded launcher, without prompts or history", async t => {
  const a = await worktreeFixture(t), b = browser(a), row = await selected(b, a.linked);
  await b.open("open-1", row);
  assert.equal(a.launches.length, 1);
  assert.deepEqual(a.launches[0].slice(0, 3), ["worktree:open-1", { cwd: a.linked, placement: "tab", title: "feature with spaces" }, a.repo]);
});
test("clean linked worktree removal retains its branch and never forces", async t => {
  const a = await worktreeFixture(t), calls = [];
  const b = browser(a, { exec: async (...args) => { calls.push(args); return gitExec(...args); } });
  const row = await selected(b, a.linked);
  await b.remove(row);
  assert.equal(existsSync(a.linked), false);
  assert.equal(git(a.repo, "show-ref", "--verify", "refs/heads/feature").trim().endsWith("refs/heads/feature"), true);
  const writes = calls.filter(([, args]) => args.includes("remove"));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][1].slice(-4), ["worktree", "remove", "--", a.linked]);
});
test("main, current, locked, dirty, ignored and unreadable worktrees cannot be removed", async t => {
  for (const kind of ["main", "current", "locked", "untracked", "staged", "ignored", "unreadable"]) {
    await t.test(kind, async t => {
      const a = await worktreeFixture(t);
      if (kind === "locked") git(a.repo, "worktree", "lock", a.linked);
      if (kind === "untracked" || kind === "staged") writeFileSync(join(a.linked, "change"), "important");
      if (kind === "staged") git(a.linked, "add", "change");
      if (kind === "ignored") {
        writeFileSync(join(a.linked, ".gitignore"), "secret\n"); git(a.linked, "add", ".gitignore"); git(a.linked, "commit", "-qm", "ignore");
        writeFileSync(join(a.linked, "secret"), "important ignored data");
      }
      const b = browser(a, { cwd: kind === "current" ? a.linked : a.repo,
        exec: async (binary, args, options) => kind === "unreadable" && args.includes(a.linked) && args.includes("status")
          ? { code: 1, stdout: "", stderr: "unreadable" } : gitExec(binary, args, options) });
      const row = await selected(b, kind === "main" ? a.repo : a.linked);
      assert.ok(row.deletionIssue);
      await assert.rejects(b.remove(row), /Cannot remove/);
      assert.equal(existsSync(a.linked), true); assert.equal(existsSync(a.repo), true);
    });
  }
});
test("changes after selection are rechecked, including newly dirty paths and replacement directories", async t => {
  for (const kind of ["dirty", "head", "replacement", "gone"]) await t.test(kind, async t => {
    const a = await worktreeFixture(t), b = browser(a), row = await selected(b, a.linked);
    if (kind === "dirty") writeFileSync(join(a.linked, "new"), "uncommitted");
    if (kind === "head") git(a.linked, "commit", "--allow-empty", "-qm", "new head");
    if (kind === "replacement") { renameSync(a.linked, a.linked + "-old"); mkdirSync(a.linked); }
    if (kind === "gone") rmSync(a.linked, { recursive: true });
    await assert.rejects(b.remove(row), /Cannot remove|changed|disappeared/);
    if (kind !== "dirty") await assert.rejects(b.open("stale", row), /changed|disappeared|unavailable/);
    assert.equal(a.launches.length, 0);
  });
});
test("live Rex agents protect descendant directories, not sibling path prefixes", async t => {
  const a = await worktreeFixture(t), sub = join(a.linked, "subdirectory"); mkdirSync(sub);
  let agentPath = sub;
  const b = browser(a, { agents: async () => ({ rows: [{ rawCwd: agentPath }], unavailable: 0 }) });
  const row = await selected(b, a.linked);
  assert.equal(row.agents, 1); await assert.rejects(b.remove(row), /Live Rex agents/);
  agentPath = a.linked + "-other"; mkdirSync(agentPath);
  assert.equal((await selected(b, a.linked)).agents, 0);
});
test("actual native discovery uses raw process directories, including whitespace", async t => {
  const a = await worktreeFixture(t), peer = { ...a.w.source, blockId: rid("block") };
  a.w.blocks.set(peer.blockId, peer);
  const sub = join(a.linked, "two  spaces"); mkdirSync(sub);
  a.w.processData.set(peer.blockId, { foreground: { pid: 12345, name: "claude", argv0: "claude", cwd: sub } });
  const b = new WorktreeBrowser(a.runtime, a.launcher, gitExec, a.repo);
  const row = await selected(b, a.linked);
  assert.equal(row.agents, 1); await assert.rejects(b.remove(row), /Live Rex agents/);
});
test("incomplete agent discovery or unknown directories block deletion but not navigation", async t => {
  for (const live of [{ rows: [], unavailable: 1 }, { rows: [{}], unavailable: 0 }]) await t.test(JSON.stringify(live), async t => {
    const a = await worktreeFixture(t), b = browser(a, { agents: async () => live });
    const row = await selected(b, a.linked);
    assert.equal(row.deletionIssue, "Agent locations unavailable");
    await assert.rejects(b.remove(row), /Agent locations unavailable/);
    await b.open("still-openable", row); assert.equal(a.launches.length, 1);
  });
});
test("a newly arriving agent is checked again before deletion", async t => {
  const a = await worktreeFixture(t); let live = false;
  const b = browser(a, { agents: async () => ({ rows: live ? [{ rawCwd: a.linked }] : [], unavailable: 0 }) });
  const row = await selected(b, a.linked); live = true;
  await assert.rejects(b.remove(row), /Live Rex agents/);
  assert.equal(existsSync(a.linked), true);
});
test("interrupted/truncated reads never authorize removal and uncertain writes are not retried", async t => {
  for (const kind of ["read", "write"]) await t.test(kind, async t => {
    const a = await worktreeFixture(t); let fail = false, writes = 0;
    const b = browser(a, { exec: async (binary, args, options) => {
      const mutation = args.includes("remove"); if (mutation) writes++;
      if (fail && (kind === "write" ? mutation : args.includes("status"))) return { code: 0, stdout: "", stderr: "", killed: true };
      return gitExec(binary, args, options);
    } });
    const row = await selected(b, a.linked); fail = true;
    await assert.rejects(b.remove(row), kind === "write" ? /outcome unknown/ : /Cannot remove/);
    assert.equal(writes, kind === "write" ? 1 : 0); assert.equal(existsSync(a.linked), true);
  });
});
test("a verification read failure after deletion remains unknown and is never retried", async t => {
  const a = await worktreeFixture(t); let dispatched = false, writes = 0;
  const b = browser(a, { exec: async (binary, args, options) => {
    if (dispatched && args.includes("list")) return { code: 1, stdout: "", stderr: "read failed" };
    const result = await gitExec(binary, args, options);
    if (args.includes("remove")) { dispatched = true; writes++; }
    return result;
  } });
  const row = await selected(b, a.linked);
  await assert.rejects(b.remove(row), error => error.outcome === "unknown" && error.path === a.linked && /could not be verified/.test(error.message));
  assert.equal(existsSync(a.linked), false); assert.equal(writes, 1);
});
test("modified tracked files stay protected even when index flags hide their changes", async t => {
  for (const flag of ["assume-unchanged", "skip-worktree"]) await t.test(flag, async t => {
    const a = await worktreeFixture(t), path = join(a.linked, "local config\nwith spaces");
    writeFileSync(path, "committed"); git(a.linked, "add", "."); git(a.linked, "commit", "-qm", "config");
    const b = browser(a), before = await selected(b, a.linked);
    git(a.linked, "update-index", "--" + flag, "local config\nwith spaces");
    writeFileSync(path, "uncommitted secret");
    assert.equal(git(a.linked, "status", "--porcelain"), ""); // Native status alone is insufficient.
    const row = await selected(b, a.linked);
    assert.equal(row.state, "clean"); assert.match(row.deletionIssue, /index entries may hide local changes/);
    await assert.rejects(b.checkRemoval([before]), /index entries may hide local changes/);
    await assert.rejects(b.remove(row), /Cannot remove/);
    assert.equal(existsSync(path), true);
    assert.match(git(a.linked, "ls-files", "-v"), flag === "assume-unchanged" ? /^h / : /^S /);
    await b.open("protected-but-openable", row); assert.equal(a.launches.length, 1);
  });
});
test("ordinary unstaged tracked edits are dirty", async t => {
  const a = await worktreeFixture(t), file = join(a.linked, "tracked");
  writeFileSync(file, "before"); git(a.linked, "add", "."); git(a.linked, "commit", "-qm", "tracked");
  writeFileSync(file, "after");
  const b = browser(a), row = await selected(b, a.linked);
  assert.equal(row.state, "dirty"); await assert.rejects(b.remove(row), /Cannot remove/);
});
test("clean initialized submodules and leftover submodule metadata block the whole batch", async t => {
  for (const kind of ["initialized", "metadata"]) await t.test(kind, async t => {
    const a = await worktreeFixture(t), clean = join(a.root, "clean-peer");
    git(a.repo, "worktree", "add", "-qb", "clean-peer", clean);
    if (kind === "initialized") {
      git(a.linked, "-c", "protocol.file.allow=always", "submodule", "add", "-q", a.repo, "module");
      git(a.linked, "commit", "-qam", "module");
    } else mkdirSync(git(a.linked, "rev-parse", "--path-format=absolute", "--git-path", "modules").trim());
    assert.equal(git(a.linked, "status", "--porcelain"), "");
    const calls = [], b = browser(a, { exec: async (...args) => { calls.push(args); return gitExec(...args); } });
    const rows = (await b.list()).rows, protectedRow = rows.find(row => row.path === a.linked);
    assert.equal(protectedRow.state, "clean"); assert.match(protectedRow.deletionIssue, /submodule/);
    await assert.rejects(b.checkRemoval([rows.find(row => row.path === clean), protectedRow]), /submodule/);
    assert.equal(calls.some(([, args]) => args.includes("remove")), false);
    assert.equal(existsSync(clean), true); assert.equal(existsSync(a.linked), true);
  });
});
test("incomplete or unreadable index inspections fail closed", async t => {
  for (const response of [{ code: 0, stdout: "H truncated", stderr: "" },
    { code: 0, stdout: "", stderr: "", truncated: true }, { code: 1, stdout: "", stderr: "unreadable" }]) await t.test(JSON.stringify(response), async t => {
    const a = await worktreeFixture(t), b = browser(a, { exec: (binary, args, options) => args.includes("ls-files") ? response : gitExec(binary, args, options) });
    const row = await selected(b, a.linked);
    assert.equal(row.state, "unavailable"); await assert.rejects(b.remove(row), /Cannot remove/);
    assert.equal(existsSync(a.linked), true);
  });
});
test("per-effect checks do not rescan unselected worktrees as the batch grows", async t => {
  const a = await worktreeFixture(t), extra = join(a.root, "extra"); git(a.repo, "worktree", "add", "-qb", "extra", extra);
  const calls = [], b = browser(a, { exec: async (...args) => { calls.push(args); return gitExec(...args); } });
  const rows = (await b.list()).rows.filter(row => !row.main);
  calls.length = 0;
  await b.checkRemoval(rows);
  assert.equal(calls.filter(([, args]) => args.includes("status")).length, 2);
  calls.length = 0;
  for (const row of rows) await b.remove(row);
  const status = calls.filter(([, args]) => args.includes("status"));
  assert.equal(status.length, 2);
  assert.deepEqual(status.map(([, args]) => args[args.indexOf("-C") + 1]), rows.map(row => row.path));
});
test("cancellation after removal dispatch is unknown, even if the directory was actually removed", async t => {
  for (const effected of [false, true]) await t.test(String(effected), async t => {
    const a = await worktreeFixture(t), controller = new AbortController(); let writes = 0;
    const b = browser(a, { exec: async (binary, args, options) => {
      if (!args.includes("remove")) return gitExec(binary, args, options);
      writes++;
      const result = effected ? await gitExec(binary, args, options) : { code: 1, stdout: "", stderr: "", killed: true };
      controller.abort(); return result;
    } });
    const row = await selected(b, a.linked);
    await assert.rejects(b.remove(row, controller.signal), error => error.outcome === "unknown" && error.path === a.linked);
    assert.equal(writes, 1); assert.equal(existsSync(a.linked), !effected);
  });
});
test("cancelled or stopped sources cannot open or remove a selected worktree", async t => {
  const a = await worktreeFixture(t), b = browser(a), row = await selected(b, a.linked), controller = new AbortController();
  controller.abort();
  await assert.rejects(b.remove(row, controller.signal));
  await assert.rejects(b.open("cancelled", row, controller.signal));
  a.runtime.stop(); await assert.rejects(b.remove(row));
  assert.equal(existsSync(a.linked), true); assert.equal(a.launches.length, 0);
});
