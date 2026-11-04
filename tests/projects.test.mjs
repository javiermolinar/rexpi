import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectResolver } from "../lib/projects.ts";
import { Launcher } from "../lib/launch.ts";
import { BOOTSTRAP_ENV, decodeBootstrap } from "../lib/state.ts";
import { active, binding, sandbox, uuid } from "./fixtures.mjs";

const extension = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
function launcher(a, resolveProject) {
  return new Launcher(a.runtime, { extension, piBinary: "/bin/echo", agentDirectory: a.root,
    stateDirectory: a.store.directory, path: process.env.PATH, startupTimeoutMs: 30, resolveProject });
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
test("project launches honor every explicit placement without changing source identity", async t => {
  for (const placement of ["session", "right", "down", "tab"]) await t.test(placement, async t => {
    const a = await active(t), destination = join(a.root, "project"); mkdirSync(destination);
    const own = a.runtime.snapshot().state, lookups = [];
    a.w.onCreate = args => acknowledge(a, args);
    const launch = launcher(a, async (query, cwd, signal) => {
      lookups.push({ query, cwd, signal });
      return { directory: destination, matchedBy: "zoxide" };
    });
    const result = await launch.launch("project", { project: "pr-inbox", placement,
      prompt: "Inspect the requested project", provider: "test", model: "model", thinking: "high", focus: false }, a.root);
    assert.deepEqual(result.project, { directory: destination, matchedBy: "zoxide" });
    assert.equal(result.creation, "confirmed");
    assert.equal(result.startup.state, "bound");
    assert.equal(result.placement, placement);
    assert.equal(result.target.sessionId, placement === "session" ? a.w.next.sessionId : a.w.source.sessionId);
    assert.equal(result.origin.conversationId, own.conversationId);
    assert.notEqual(result.identity.taskId, own.taskId);
    assert.equal(a.runtime.snapshot().state.conversationId, own.conversationId);
    assert.equal(lookups.length, 1); assert.equal(lookups[0].query, "pr-inbox");
    assert.equal(lookups[0].cwd, a.root); assert.ok(lookups[0].signal instanceof AbortSignal);
    const args = a.w.created[0];
    assert.ok(args.includes("--keep-open")); assert.ok(args.includes(destination));
    assert.ok(args.includes("--model")); assert.ok(args.includes("model")); assert.ok(args.includes("high"));
    assert.equal(args.at(-1), "Inspect the requested project");
    if (placement === "session") assert.ok(!args.includes("window"));
    else if (placement === "tab") assert.ok(args.includes("window"));
    else assert.ok(args.includes("--split=" + (placement === "down" ? "below" : "right")));
  });
});
test("project lookup preserves task-aware defaults and exact new session names", async t => {
  for (const [name, options, expected] of [
    ["independent", {}, "session"],
    ["related", { related: true }, "right"],
    ["review", { role: "review" }, "right"],
    ["background", { related: true, focus: false }, "tab"],
    ["named", { sessionName: "PR Inbox" }, "session"],
  ]) await t.test(name, async t => {
    const a = await active(t);
    a.w.onCreate = args => acknowledge(a, args);
    const result = await launcher(a, async () => ({ directory: a.root, matchedBy: "path" }))
      .launch(name, { project: a.root, ...options }, a.root);
    assert.equal(result.placement, expected);
    assert.equal(result.startup.state, "bound");
    assert.equal(a.w.created[0].filter(arg => arg === "--").length, 1);
    if (options.sessionName) assert.equal(a.w.sessionLabels.get(result.target.sessionId), options.sessionName);
  });
});
test("project and cwd are exclusive, and invalid options fail before native IO or lookup", async t => {
  const a = await active(t);
  const launch = launcher(a, async () => assert.fail("lookup must not run"));
  const calls = a.w.calls.length;
  for (const options of [
    { project: "project", cwd: a.root }, { project: "" }, { project: " " }, { project: 123 },
    { project: "line\nfeed" }, { project: "x".repeat(4097) }, { project: "project", provider: "without-model" },
    { project: "project", sessionName: "Name", placement: "tab" },
  ]) await assert.rejects(launch.launch(uuid(), options, a.root));
  assert.equal(a.w.calls.length, calls);
  assert.equal(a.w.created.length, 0);
});
test("strict cwd paths never fall back to project lookup", async t => {
  const a = await active(t), launch = launcher(a, async () => assert.fail("no project lookup"));
  await assert.rejects(launch.launch("missing-cwd", { cwd: "missing-project" }, a.root));
  a.w.onCreate = args => acknowledge(a, args);
  const result = await launch.launch("cwd-only", { cwd: a.root, focus: false }, a.root);
  assert.equal(result.project, undefined);
  assert.equal(result.placement, "session");
});
test("project launches require a configured resolver rather than silently using cwd", async t => {
  const a = await active(t);
  await assert.rejects(launcher(a).launch("no-resolver", { project: "project" }, a.root), /lookup is unavailable/);
  assert.equal(a.w.created.length, 0);
});
test("repeated launch IDs neither resolve again nor create another resource", async t => {
  const a = await active(t); let lookups = 0;
  a.w.onCreate = args => acknowledge(a, args);
  const launch = launcher(a, async () => { lookups++; return { directory: a.root, matchedBy: "path" }; });
  const first = launch.launch("repeat", { project: a.root }, a.root);
  assert.equal(launch.launch("repeat", { project: "different", placement: "tab" }, a.root), first);
  await first;
  assert.equal(lookups, 1); assert.equal(a.w.created.length, 1);
});
test("a changed source or cancelled lookup cannot create Pi", async t => {
  for (const mode of ["source", "abort"]) await t.test(mode, async t => {
    const a = await active(t), controller = new AbortController();
    const launch = launcher(a, async () => {
      if (mode === "source") a.runtime.stop(); else controller.abort();
      return { directory: a.root, matchedBy: "path" };
    });
    await assert.rejects(launch.launch("stale", { project: a.root }, a.root, controller.signal));
    assert.equal(a.w.created.length, 0);
  });
});
test("locality and pre-aborted requests are checked before directory lookup", async t => {
  const a = await active(t);
  const launch = launcher(a, async () => assert.fail("lookup must not run"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(launch.launch("abort", { project: "project" }, a.root, controller.signal));
  a.w.remote = true;
  await assert.rejects(launch.launch("remote", { project: "project" }, a.root), /local/);
  assert.equal(a.w.created.length, 0);
});
test("resolved directories are revalidated before creation", async t => {
  const a = await active(t);
  const launch = launcher(a, async () => ({ directory: join(a.root, "missing"), matchedBy: "zoxide" }));
  await assert.rejects(launch.launch("missing-result", { project: "project" }, a.root));
  assert.equal(a.w.created.length, 0);
});
test("lookup failures and unknown creation outcomes are not retried", async t => {
  const a = await active(t); let lookups = 0;
  const failing = launcher(a, async () => { lookups++; throw Error("no match"); });
  const first = failing.launch("none", { project: "project" }, a.root);
  await assert.rejects(first, /no match/);
  assert.equal(failing.launch("none", {}, a.root), first);
  assert.equal(lookups, 1); assert.equal(a.w.created.length, 0);
  a.w.failCreate = true;
  const launch = launcher(a, async () => ({ directory: a.root, matchedBy: "path" }));
  const result = await launch.launch("unknown", { project: a.root }, a.root);
  assert.equal(result.creation, "unknown"); assert.equal(result.project.directory, a.root);
  assert.equal(await launch.launch("unknown", { project: a.root }, a.root), result);
  assert.equal(a.w.created.length, 1);
  assert.equal(a.w.calls.some(c => c.includes("kill") || c.includes("close") || c.includes("send")), false);
});
