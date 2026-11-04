import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectResolver, ProjectJumper } from "../lib/jump.ts";
import { Launcher } from "../lib/launch.ts";
import { BOOTSTRAP_ENV, decodeBootstrap } from "../lib/state.ts";
import { active, binding, sandbox, uuid } from "./fixtures.mjs";

const extension = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
function launcher(a) {
  return new Launcher(a.runtime, { extension, piBinary: "/bin/echo", agentDirectory: a.root,
    stateDirectory: a.store.directory, path: process.env.PATH, startupTimeoutMs: 30 });
}
function acknowledge(a, args) {
  const raw = args.find(arg => arg.startsWith(BOOTSTRAP_ENV + "="));
  const seed = decodeBootstrap(raw.slice(raw.indexOf("=") + 1));
  a.store.write(binding(seed, { blockId: a.w.next.blockId }));
}
test("existing absolute, relative, spaced and home paths do not require zoxide", async t => {
  const root = sandbox(t), directory = join(root, "a project"); mkdirSync(directory);
  const resolver = new ProjectResolver(async () => assert.fail("lookup must not execute"), "", "/missing/zoxide");
  for (const query of [directory, "a project", "./a project"]) {
    assert.deepEqual(await resolver.resolve(query, root), { directory, matchedBy: "path" });
  }
  assert.equal((await resolver.resolve("~", root)).directory, realpathSync(homedir()));
});
test("missing explicit paths and existing files cannot silently jump to unrelated zoxide matches", async t => {
  const root = sandbox(t); writeFileSync(join(root, "file"), "not a directory");
  const resolver = new ProjectResolver(async () => assert.fail("lookup must not execute"), "", "/missing/zoxide");
  for (const query of [join(root, "missing"), "./missing", "../missing/path", "~/pi-rex-missing-" + uuid(), "file"])
    await assert.rejects(resolver.resolve(query, root));
});
test("fuzzy lookup uses literal bounded query arguments and validates its returned directory", async t => {
  const root = sandbox(t), destination = join(root, "tempo project"); mkdirSync(destination);
  const calls = [];
  const resolver = new ProjectResolver(async (binary, args, options) => {
    calls.push({ binary, args, options });
    return { code: 0, stdout: destination + "\n", stderr: "" };
  }, "/bin", "/bin/echo");
  assert.deepEqual(await resolver.resolve("grafana tempo", root), { directory: destination, matchedBy: "zoxide" });
  assert.deepEqual(calls[0].args, ["query", "--", "grafana", "tempo"]);
  assert.equal(calls[0].options.timeout, 5000);
  assert.equal(calls[0].options.maxBuffer, 16384);
  assert.equal(calls[0].options.cwd, root);
  await resolver.resolve("--help", root);
  assert.deepEqual(calls[1].args, ["query", "--", "--help"]);
});
test("unavailable, malformed, stale and failed zoxide results cannot launch", async t => {
  const root = sandbox(t);
  for (const response of [
    { code: 1, stdout: "", stderr: "no match" },
    { code: 0, stdout: root, stderr: "", killed: true },
    { code: 0, stdout: root, stderr: "", truncated: true },
    { code: 0, stdout: "relative/path\n", stderr: "" },
    { code: 0, stdout: root + "\n" + root + "\n", stderr: "" },
    { code: 0, stdout: join(root, "missing") + "\n", stderr: "" },
  ]) {
    await assert.rejects(new ProjectResolver(async () => response, "/bin", "/bin/echo").resolve("keyword", root));
  }
  await assert.rejects(new ProjectResolver(async () => assert.fail("no executable"), "", "/missing/zoxide").resolve("keyword", root), /Executable/);
});
test("query validation and cancellation prevent lookup", async t => {
  const root = sandbox(t), resolver = new ProjectResolver(async () => assert.fail("no lookup"), "", "/missing/zoxide");
  for (const query of ["", " ", "line\nfeed", "x".repeat(4097)]) await assert.rejects(resolver.resolve(query, root));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(resolver.resolve("keyword", root, cancelled.signal));
});
test("project jumps reuse verified Pi launches with an explicit new-tab placement", async t => {
  const a = await active(t), destination = join(a.root, "project"); mkdirSync(destination);
  a.w.onCreate = args => acknowledge(a, args);
  const jumper = new ProjectJumper(a.runtime, launcher(a), async () => ({ directory: destination, matchedBy: "zoxide" }));
  const result = await jumper.jump("project", { query: "project", prompt: "Inspect the requested project", focus: false }, a.root);
  assert.equal(result.directory, destination);
  assert.equal(result.launch.creation, "confirmed");
  assert.equal(result.launch.startup.state, "bound");
  assert.equal(result.launch.placement, "tab");
  assert.equal(result.launch.target.sessionId, a.w.source.sessionId);
  assert.equal(result.launch.origin.conversationId, a.runtime.snapshot().state.conversationId);
  assert.notEqual(result.launch.identity.taskId, a.runtime.snapshot().state.taskId);
  assert.ok(a.w.created[0].includes("window"));
  assert.ok(a.w.created[0].includes("--focus=false"));
  assert.ok(a.w.created[0].includes("--keep-open"));
  assert.ok(a.w.created[0].includes(destination));
  assert.equal(a.w.created[0].at(-1), "Inspect the requested project");
});
test("repeated jump IDs neither resolve again nor create another tab", async t => {
  const a = await active(t); let lookups = 0;
  a.w.onCreate = args => acknowledge(a, args);
  const jumper = new ProjectJumper(a.runtime, launcher(a), async () => { lookups++; return { directory: a.root, matchedBy: "path" }; });
  const first = jumper.jump("repeat", { query: a.root }, a.root);
  assert.equal(jumper.jump("repeat", { query: "different" }, a.root), first);
  await first;
  assert.equal(lookups, 1);
  assert.equal(a.w.created.length, 1);
});
test("a changed source during lookup cannot create a Pi tab", async t => {
  const a = await active(t);
  const jumper = new ProjectJumper(a.runtime, launcher(a), async () => {
    a.runtime.stop();
    return { directory: a.root, matchedBy: "path" };
  });
  await assert.rejects(jumper.jump("stale", { query: a.root }, a.root));
  assert.equal(a.w.created.length, 0);
});
test("locality and option guards run before directory lookup", async t => {
  const a = await active(t);
  const jumper = new ProjectJumper(a.runtime, launcher(a), async () => assert.fail("lookup must not run"));
  await assert.rejects(jumper.jump("invalid", { query: "project", provider: "without-model" }, a.root), /requires model/);
  a.w.remote = true;
  await assert.rejects(jumper.jump("remote", { query: "project" }, a.root), /local/);
  assert.equal(a.w.created.length, 0);
});
test("lookup failures and unknown creation outcomes are not retried", async t => {
  const a = await active(t);
  const failing = new ProjectJumper(a.runtime, launcher(a), async () => { throw Error("no match"); });
  await assert.rejects(failing.jump("none", { query: "project" }, a.root), /no match/);
  assert.equal(a.w.created.length, 0);
  a.w.failCreate = true;
  const jumper = new ProjectJumper(a.runtime, launcher(a), async () => ({ directory: a.root, matchedBy: "path" }));
  const result = await jumper.jump("unknown", { query: a.root }, a.root);
  assert.equal(result.launch.creation, "unknown");
  assert.equal(a.w.created.length, 1);
  assert.equal(a.w.calls.some(c => c.includes("kill") || c.includes("close") || c.includes("send")), false);
});
