import test from "node:test";
import assert from "node:assert/strict";
import { TerminalOpener, terminalArgv, validateTerminal } from "../lib/terminal.ts";
import { active } from "./fixtures.mjs";

test("generic terminals support every placement without Pi labels, bootstrap or app actions", async t => {
  for (const placement of ["right", "down", "tab", "floating"]) {
    await t.test(placement, async child => {
      const a = await active(child);
      const result = await new TerminalOpener(a.runtime).open("open", {
        command: ["/bin/echo", "literal; $(not-a-command)"], placement, focus: false, keepOpen: true, title: "Tool",
      }, a.root);
      assert.equal(result.creation, "confirmed");
      assert.equal(result.target.blockId, a.w.next.blockId);
      assert.equal(result.target.sessionId, a.w.source.sessionId);
      assert.equal(a.w.calls.some(c => c.includes("do") || c.some(arg => arg.startsWith("PI_REX_BOOTSTRAP="))), false);
      if (placement === "floating") {
        assert.ok(result.target.layerId.startsWith("layer:"));
        const request = a.w.layerRequests[0];
        assert.deepEqual(request.bounds, [0.1, 0.1, 0.8, 0.8]);
        assert.equal(request.window_id, a.w.source.windowId);
        assert.equal(request.focus, false);
        assert.equal(request.layout.block.options.shell, "none");
        assert.equal(request.layout.block.options.exit.on_completion, false);
        assert.equal(request.layout.block.options.command.at(-1), "literal; $(not-a-command)");
      } else {
        const args = a.w.created[0];
        assert.ok(args.includes("--keep-open"));
        assert.ok(args.includes("--focus=false"));
        if (placement === "tab") assert.ok(args.includes("Tool"));
        assert.equal(args.some(value => value.startsWith("Pi · ")), false);
      }
    });
  }
});
test("bounds must fit and cannot be silently ignored for non-floating placement", () => {
  for (const bounds of [[0,0,0,1],[-1,0,1,1],[0.3,0,0.8,1],[0,0,1,Infinity],[0,0,1],["x",0,1,1]]) {
    assert.throws(() => validateTerminal({ command: ["/bin/echo"], placement: "floating", bounds }));
  }
  assert.throws(() => validateTerminal({ command: "true", bounds: [0,0,1,1] }), /floating/);
  validateTerminal({ command: "true", placement: "floating", bounds: [0,0,1,1] });
});
test("string commands intentionally use sh; arrays preserve literal arguments and PATH", t => {
  const a = terminalArgv("printf '%s' hello | cat", "/", "/bin");
  assert.deepEqual(a, ["/usr/bin/env", "PATH=/bin", "/bin/sh", "-c", "printf '%s' hello | cat"]);
  const b = terminalArgv(["/bin/echo", "$HOME", "a b"], "/", "/bin");
  assert.deepEqual(b.slice(-2), ["$HOME", "a b"]);
  assert.equal(b.includes("-c"), false);
});
test("invalid commands, unavailable binaries and nonexistent cwd fail before creation", async t => {
  const a = await active(t), opener = new TerminalOpener(a.runtime);
  for (const options of [{ command: "" }, { command: [] }, { command: ["/bin/echo", null] }, { command: "x\0" },
    { command: ["/nonexistent/tool"] }, { command: "true", cwd: a.root + "/missing" },
    { command: "true", placement: "left" }, { command: "true", keepOpen: "yes" }]) {
    await assert.rejects(opener.open(Math.random().toString(), options, a.root));
  }
  assert.equal(a.w.created.length, 0);
});
test("duplicate terminal IDs reuse evidence instead of launching again", async t => {
  const a = await active(t), opener = new TerminalOpener(a.runtime);
  const first = opener.open("repeat", { command: ["/bin/echo"] }, a.root);
  assert.equal(opener.open("repeat", { command: ["/bin/echo", "different"] }, a.root), first);
  const settled = await first;
  assert.equal(a.w.created.length, 1);
  // Settled outcomes stay as compact evidence: a repeated ID never creates a second terminal.
  assert.deepEqual(await opener.open("repeat", { command: ["/bin/echo", "third"] }, a.root), settled);
  assert.equal(a.w.created.length, 1);
});
test("rejected terminal requests keep their evidence instead of retrying", async t => {
  const a = await active(t), opener = new TerminalOpener(a.runtime);
  await assert.rejects(opener.open("invalid", { command: "" }, a.root), /nonempty/);
  await assert.rejects(opener.open("invalid", { command: ["/bin/echo"] }, a.root), /nonempty/);
  assert.equal(a.w.created.length, 0);
});
test("aggregate argument length has its own limit and error", () => {
  assert.throws(() => validateTerminal({ command: ["/bin/echo", ...Array.from({ length: 9 }, () => "x".repeat(4000))] }),
    /32,768-character total limit/);
});
test("unknown floating creation is not retried or cleaned up", async t => {
  const a = await active(t), opener = new TerminalOpener(a.runtime);
  a.w.failCreate = true;
  const result = await opener.open("uncertain", { command: ["/bin/echo"], placement: "floating" }, a.root);
  assert.equal(result.creation, "unknown");
  assert.match(result.reason, /Inspect Rex/);
  assert.equal(a.w.created.length, 1);
  assert.equal(a.w.calls.some(c => c.some(x => /^(kill|close|send)$/.test(x))), false);
});
test("source cancellation after dispatch preserves confirmed terminal creation", async t => {
  const a = await active(t), opener = new TerminalOpener(a.runtime), signal = new AbortController();
  a.w.onCreate = () => { signal.abort(); a.runtime.stop(); };
  const result = await opener.open("cancelled", { command: ["/bin/echo"] }, a.root, signal.signal);
  assert.equal(result.creation, "confirmed");
  assert.equal(a.w.created.length, 1);
});
test("a stopped source cannot launch an arbitrary command", async t => {
  const a = await active(t), opener = new TerminalOpener(a.runtime);
  a.runtime.stop();
  await assert.rejects(opener.open("stale", { command: "true" }, a.root), /No verified/);
  assert.equal(a.w.created.length, 0);
});
