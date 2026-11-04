import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { registerWorktreesCommand } from "../extensions/worktrees.ts";
import { WorktreeResultsOverlay } from "../lib/worktree-results-overlay.ts";
import { WorktreeConfirmationOverlay } from "../lib/worktree-review-overlay.ts";
import { git, gitExec, worktreeFixture } from "./worktree-fixtures.mjs";

async function setup(t) {
  const a = await worktreeFixture(t), commands = new Map(), notices = [], confirmations = [], results = [];
  let runtime = a.runtime, overlay, opened = 0, closed = false, pickerClosed = false, confirm = async () => false, execute = gitExec, autoAcknowledge = true;
  const { cancel, open } = registerWorktreesCommand({ registerCommand: (name, command) => commands.set(name, command),
    exec: (binary, args, options) => args.includes("-C") ? execute(binary, args, options) : a.w.exec(binary, args, options) },
    () => ({ runtime, launcher: a.launcher }));
  const ctx = { ...a.ctx, ui: { ...a.ctx.ui, notify: (...args) => notices.push(args),
    custom: async (factory, options) => {
      assert.equal(options.overlay, true); opened++; closed = false;
      return new Promise(resolve => {
        overlay = factory({ terminal: { rows: 35 }, requestRender() {} }, getThemeByName("dark"),
          new KeybindingsManager(TUI_KEYBINDINGS), value => {
            closed = true;
            if (!(overlay instanceof WorktreeConfirmationOverlay) && !(overlay instanceof WorktreeResultsOverlay)) pickerClosed = true;
            overlay?.dispose(); resolve(value);
          });
        overlay.render(80);
        if (overlay instanceof WorktreeConfirmationOverlay) {
          const confirmation = overlay;
          confirmations.push([confirmation.title, confirmation.message]);
          Promise.resolve().then(() => confirm(confirmation.title, confirmation.message)).then(accepted => {
            if (accepted) confirmation.handleInput("\t");
            confirmation.handleInput("\r");
          });
        } else if (overlay instanceof WorktreeResultsOverlay) {
          results.push(overlay);
          if (autoAcknowledge) overlay.handleInput("\r");
        }
      });
    } } };
  t.after(cancel);
  return { ...a, commands, ctx, notices, confirmations, results, cancel,
    get overlay() { return overlay; }, get opened() { return opened; }, get closed() { return closed; },
    get pickerClosed() { return pickerClosed; },
    setConfirm: callback => { confirm = callback; }, setExec: callback => { execute = callback; },
    acknowledgeResults: value => { autoAcknowledge = value; },
    disable: () => { runtime = undefined; }, open: () => open(ctx) };
}
async function until(predicate) {
  for (let n = 0; n < 300; n++) { if (predicate()) return; await sleep(5); }
  assert.fail("worktree picker did not reach expected state");
}
async function pickLinked(a) {
  await until(() => a.overlay?.selectedRow());
  a.overlay.handleInput("\x1b[B");
  assert.equal(a.overlay.selectedRow().path, a.linked);
}

test("short and long commands share one transient picker; Escape never launches or deletes", async t => {
  const a = await setup(t);
  assert.deepEqual([...a.commands.keys()], ["rxw", "rxworktrees"]);
  const running = a.commands.get("rxw").handler("", a.ctx);
  await until(() => a.overlay?.selectedRow());
  await a.commands.get("rxworktrees").handler("", a.ctx); assert.equal(a.opened, 1);
  a.overlay.handleInput("\x1b"); await running;
  assert.equal(a.launches.length, 0); assert.equal(existsSync(a.linked), true);
  const again = a.open(); await until(() => a.opened === 2 && a.overlay?.selectedRow());
  a.overlay.handleInput("\x1b"); await again;
});
test("Enter closes the picker before opening a fresh Pi tab", async t => {
  const a = await setup(t), running = a.open(); await pickLinked(a);
  const original = a.launcher.launch;
  a.launcher.launch = (...args) => { assert.equal(a.closed, true); return original(...args); };
  a.overlay.handleInput("\r"); await running;
  assert.equal(a.launches.length, 1);
  assert.equal(a.launches[0][1].placement, "tab"); assert.equal(a.launches[0][1].cwd, a.linked);
  assert.equal(a.launches[0][1].prompt, undefined); assert.equal(a.confirmations.length, 0);
  assert.match(a.notices.at(-1)[0], /source conversation is unchanged/);
});
test("Ctrl+D requires confirmation and cancelling it leaves the worktree intact", async t => {
  const a = await setup(t), running = a.open(); await pickLinked(a);
  a.overlay.handleInput(" ");
  a.setConfirm(async () => { assert.equal(a.pickerClosed, true); return false; });
  a.overlay.handleInput("\x04"); await running;
  assert.equal(a.confirmations.length, 1); assert.equal(existsSync(a.linked), true);
  assert.equal(a.results.length, 0);
  assert.match(a.notices.at(-1)[0], /Deletion cancelled; no worktrees removed/);
  assert.equal(a.launches.length, 0);
});
test("confirmed removal deletes only the chosen clean linked worktree", async t => {
  const a = await setup(t), running = a.open(); await pickLinked(a);
  a.overlay.handleInput(" ");
  a.setConfirm(async () => true);
  a.overlay.handleInput("\x04"); await running;
  assert.equal(a.confirmations.length, 1); assert.equal(existsSync(a.linked), false);
  assert.equal(existsSync(a.repo), true); assert.equal(a.launches.length, 0);
  assert.match(a.notices.at(-1)[0], /branches retained/);
});
async function addBatch(a) {
  const paths = [join(a.root, "batch-a"), join(a.root, "batch-b")];
  for (const path of paths) git(a.repo, "worktree", "add", "-qb", path.split("/").at(-1), path);
  return [...paths, a.linked];
}
async function markBatch(a) {
  await until(() => a.overlay?.selectedRow());
  for (const query of ["batch-a", "batch-b", "feature"]) {
    for (const char of query) a.overlay.handleInput(char);
    assert.ok(a.overlay.selectedRow(), query);
    a.overlay.handleInput(" ");
    a.overlay.handleInput("\x15");
  }
  assert.equal(a.overlay.markedRows().length, 3);
}
test("one confirmation lists all marked worktrees, then removes them sequentially", async t => {
  const a = await setup(t), paths = await addBatch(a), running = a.open();
  await markBatch(a);
  a.setConfirm(async (title, message) => {
    assert.equal(a.pickerClosed, true); assert.match(title, /3 marked worktrees/);
    for (const path of paths) assert.ok(message.includes(JSON.stringify(path)));
    return true;
  });
  a.overlay.handleInput("\x04"); await running;
  assert.equal(a.confirmations.length, 1);
  for (const path of paths) assert.equal(existsSync(path), false);
  assert.equal(existsSync(a.repo), true); assert.equal(a.launches.length, 0);
  assert.match(a.notices.at(-1)[0], /Removed 3 worktrees; branches retained/);
});
test("a protected batch member after confirmation prevents every removal", async t => {
  const a = await setup(t), paths = await addBatch(a), running = a.open();
  await markBatch(a);
  a.setConfirm(async () => { writeFileSync(join(a.linked, "important"), "uncommitted"); return true; });
  a.overlay.handleInput("\x04"); await running;
  for (const path of paths) assert.equal(existsSync(path), true);
  assert.match(a.notices.at(-1)[0], /Removed 0\/3/);
  assert.deepEqual(a.results[0].report.results.map(result => result.outcome), ["not-attempted", "not-attempted", "blocked"]);
});
test("batch cancellation leaves every marked worktree intact", async t => {
  const a = await setup(t), paths = await addBatch(a), running = a.open();
  await markBatch(a);
  a.overlay.handleInput("\x04"); await running;
  assert.equal(a.confirmations.length, 1);
  for (const path of paths) assert.equal(existsSync(path), true);
});
test("batch removal stops at the first failed or uncertain effect and reports confirmed progress", async t => {
  for (const outcome of ["failed", "unknown"]) await t.test(outcome, async t => {
    const a = await setup(t), paths = await addBatch(a), running = a.open();
    await markBatch(a); a.setConfirm(async () => true);
    const attempts = [];
    a.setExec(async (binary, args, options) => {
      if (args.includes("remove")) {
        attempts.push(args.at(-1));
        if (attempts.length === 2) return { code: 1, stdout: "", stderr: "simulated refusal", killed: outcome === "unknown" };
      }
      return gitExec(binary, args, options);
    });
    a.overlay.handleInput("\x04"); await running;
    assert.deepEqual(attempts, paths.slice(0, 2));
    assert.equal(existsSync(paths[0]), false);
    assert.equal(existsSync(paths[1]), true); assert.equal(existsSync(paths[2]), true);
    assert.match(a.notices.at(-1)[0], /Removed 1\/3/);
    assert.match(a.notices.at(-1)[0], outcome === "unknown" ? /outcome unknown/ : /Git worktree removal failed/);
    assert.match(a.notices.at(-1)[0], /No further worktrees attempted/);
    assert.deepEqual(a.results[0].report.results.map(result => result.outcome), ["removed", outcome === "unknown" ? "unknown" : "failed", "not-attempted"]);
    assert.deepEqual(a.results[0].report.results.map(result => result.row.path), paths);
  });
});
test("deletion results remain visible until acknowledged and offer no further effects", async t => {
  const a = await setup(t); a.acknowledgeResults(false);
  const running = a.open(); let settled = false; running.then(() => { settled = true; });
  await pickLinked(a); a.overlay.handleInput(" "); a.setConfirm(async () => true);
  a.overlay.handleInput("\x04");
  await until(() => a.results.length === 1);
  assert.equal(settled, false); assert.equal(a.closed, false);
  assert.equal(existsSync(a.linked), false);
  const result = a.results[0], report = result.report.results[0];
  assert.equal(report.outcome, "removed"); assert.equal(report.row.path, a.linked);
  assert.match(report.message, /verified/);
  const calls = a.w.calls.length;
  await a.open(); // Reentry cannot create another picker or repeat deletion.
  assert.equal(a.opened, 3);
  result.handleInput("\x04");
  await sleep(20); assert.equal(a.w.calls.length, calls);
  for (const char of "nomatch") result.handleInput(char);
  result.handleInput("\r"); await running;
  assert.equal(settled, true); assert.equal(a.closed, true);
  assert.equal(a.launches.length, 0);
});
test("shutdown dismisses the result screen without repeating removal", async t => {
  const a = await setup(t); a.acknowledgeResults(false);
  const running = a.open(); await pickLinked(a);
  a.overlay.handleInput(" "); a.setConfirm(async () => true); a.overlay.handleInput("\x04");
  await until(() => a.results.length === 1);
  a.cancel(); await running;
  assert.equal(a.closed, true); assert.equal(existsSync(a.linked), false);
  assert.equal(a.results.length, 1); assert.equal(a.launches.length, 0);
});
test("a successful exit without verified disappearance is reported as unknown, not deleted", async t => {
  const a = await setup(t), running = a.open(); await pickLinked(a);
  a.overlay.handleInput(" "); a.setConfirm(async () => true);
  let writes = 0;
  a.setExec(async (binary, args, options) => {
    if (args.includes("remove")) { writes++; return { code: 0, stdout: "", stderr: "" }; }
    return gitExec(binary, args, options);
  });
  a.overlay.handleInput("\x04"); await running;
  assert.equal(writes, 1); assert.equal(existsSync(a.linked), true);
  assert.equal(a.results[0].report.results[0].outcome, "unknown");
  assert.match(a.results[0].report.error, /could not be verified/);
  assert.match(a.notices.at(-1)[0], /Removed 0\/1/);
});
test("missing entries confirm registration-only cleanup without touching other stale entries", async t => {
  const a = await setup(t), stale = join(a.root, "other-stale");
  git(a.repo, "worktree", "add", "-qb", "other-stale", stale);
  rmSync(a.linked, { recursive: true }); rmSync(stale, { recursive: true });
  const running = a.open(); await pickLinked(a);
  assert.equal(a.overlay.selectedRow().state, "missing");
  a.overlay.handleInput(" ");
  a.setConfirm(async (_title, message) => {
    assert.ok(message.includes("Registration only:\n" + JSON.stringify(a.linked)));
    assert.ok(!message.includes(JSON.stringify(stale)));
    return true;
  });
  a.overlay.handleInput("\x04"); await running;
  const list = git(a.repo, "worktree", "list", "--porcelain");
  assert.ok(!list.includes(a.linked)); assert.ok(list.includes(stale));
  assert.match(a.notices.at(-1)[0], /1 missing registration/);
  assert.equal(a.results[0].report.results[0].outcome, "cleaned");
  assert.equal(a.launches.length, 0);
});
test("a missing directory reappearing during confirmation prevents cleanup", async t => {
  const a = await setup(t); rmSync(a.linked, { recursive: true });
  const running = a.open(); await pickLinked(a); a.overlay.handleInput(" ");
  a.setConfirm(async () => { mkdirSync(a.linked); writeFileSync(join(a.linked, "important"), "keep"); return true; });
  a.overlay.handleInput("\x04"); await running;
  assert.equal(existsSync(join(a.linked, "important")), true);
  assert.match(a.notices.at(-1)[0], /Removed 0\/1/);
});
test("Enter on a missing registration never launches Pi", async t => {
  const a = await setup(t); rmSync(a.linked, { recursive: true });
  const running = a.open(); await pickLinked(a);
  a.overlay.handleInput("\r"); await running;
  assert.equal(a.launches.length, 0); assert.match(a.notices.at(-1)[0], /directory is missing/);
});
test("post-confirmation dirtiness and runtime replacement prevent removal", async t => {
  for (const kind of ["dirty", "replacement", "shutdown"]) await t.test(kind, async t => {
    const a = await setup(t), running = a.open(); await pickLinked(a);
    a.overlay.handleInput(" ");
    a.setConfirm(async () => {
      if (kind === "dirty") writeFileSync(join(a.linked, "important"), "uncommitted");
      if (kind === "replacement") a.disable();
      if (kind === "shutdown") a.cancel();
      return true;
    });
    a.overlay.handleInput("\x04"); await running;
    assert.equal(existsSync(a.linked), true); assert.equal(a.launches.length, 0);
  });
});
test("protected rows refuse removal without even asking for confirmation", async t => {
  const a = await setup(t), running = a.open(); await until(() => a.overlay?.selectedRow());
  a.overlay.handleInput(" "); a.overlay.handleInput("\x04");
  assert.deepEqual(a.overlay.markedRows(), []);
  assert.equal(a.closed, false);
  a.overlay.handleInput("\x1b"); await running;
  assert.equal(a.confirmations.length, 0); assert.equal(existsSync(a.repo), true);
});
test("noninteractive and inactive commands do no Git reads or native effects", async t => {
  const a = await setup(t), before = a.w.calls.length;
  await a.commands.get("rxw").handler("", { ...a.ctx, mode: "rpc" });
  a.disable(); await a.open();
  assert.equal(a.opened, 0); assert.equal(a.w.calls.length, before); assert.equal(a.notices.length, 2);
});
test("a newly hidden index flag after confirmation prevents every batch effect", async t => {
  const a = await setup(t), paths = await addBatch(a), file = join(a.linked, "tracked");
  writeFileSync(file, "committed"); git(a.linked, "add", "."); git(a.linked, "commit", "-qm", "tracked");
  const running = a.open(); await markBatch(a);
  a.setConfirm(async () => {
    git(a.linked, "update-index", "--assume-unchanged", "tracked"); writeFileSync(file, "local secret");
    return true;
  });
  let writes = 0;
  a.setExec((binary, args, options) => { if (args.includes("remove")) writes++; return gitExec(binary, args, options); });
  a.overlay.handleInput("\x04"); await running;
  assert.equal(writes, 0); for (const path of paths) assert.equal(existsSync(path), true);
  assert.match(a.results[0].report.error, /index entries may hide local changes/);
});
test("cancellation during a dispatched batch waits for settlement and never advances or reopens results", async t => {
  const a = await setup(t), paths = await addBatch(a), attempts = [];
  const running = a.open(); await markBatch(a); a.setConfirm(async () => true);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const dispatched = new Promise(resolve => { entered = resolve; });
  a.setExec(async (binary, args, options) => {
    if (!args.includes("remove")) return gitExec(binary, args, options);
    attempts.push(args.at(-1));
    // The effect may finish before cancellation is observed; its acknowledgement is still pending.
    const result = await gitExec(binary, args, options);
    entered(); await gate; return result;
  });
  a.overlay.handleInput("\x04"); await dispatched;
  let settled = false; running.then(() => { settled = true; });
  a.cancel(); await a.open(); await sleep(10);
  assert.equal(settled, false); assert.equal(a.opened, 2);
  release(); await running;
  assert.deepEqual(attempts, [paths[0]]); assert.equal(existsSync(paths[0]), false);
  assert.equal(existsSync(paths[1]), true); assert.equal(existsSync(paths[2]), true);
  assert.equal(a.results.length, 0); assert.equal(a.launches.length, 0);
});
test("shutdown cancels pending reads and prevents late selection or navigation", async t => {
  const a = await setup(t); let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  a.w.onTerminalData = async () => { entered = true; await gate; };
  const running = a.open(); await until(() => entered);
  a.cancel(); a.runtime.stop(); release(); await running;
  assert.equal(a.overlay.selectedRow(), undefined); assert.equal(a.launches.length, 0); assert.equal(a.notices.length, 0);
});
