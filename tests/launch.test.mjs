import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Launcher, piArguments, placementFor, validateOptions } from "../lib/launch.ts";
import { BOOTSTRAP_ENV, decodeBootstrap } from "../lib/state.ts";
import { AGENT_BOOTSTRAP_ENV, decodeAgentBootstrap } from "../lib/agent.ts";
import { AgentRuntime } from "../lib/agent-runtime.ts";
import { active, binding, uuid } from "./fixtures.mjs";

const extension = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
function setup(a, timeout = 30) {
  return new Launcher(a.runtime, { extension, piBinary: "/bin/echo", agentDirectory: a.root,
    stateDirectory: a.store.directory, path: process.env.PATH, startupTimeoutMs: timeout });
}
function acknowledge(a, args, change = x => x) {
  const assignment = args.find(arg => arg.startsWith(BOOTSTRAP_ENV + "="));
  const seed = decodeBootstrap(assignment.slice(assignment.indexOf("=") + 1));
  a.store.write(binding(change(seed), { blockId: a.w.next.blockId }));
  return seed;
}
test("placement is task-aware; explicit placement always wins", () => {
  assert.equal(placementFor({}, false), "session");
  assert.equal(placementFor({ related: true }, false), "right");
  assert.equal(placementFor({ role: "review" }, false), "right");
  assert.equal(placementFor({ related: true }, true), "tab");
  assert.equal(placementFor({ related: true, focus: false }, false), "tab");
  assert.equal(placementFor({ placement: "down" }, true), "down");
});
test("invalid model, relation, input and placement fail before any creation", async t => {
  const a = await active(t), launcher = setup(a);
  for (const options of [{ provider: "x" }, { role: "review", related: false }, { prompt: "x".repeat(16385) },
    { placement: "up" }, { thinking: "unlimited" }, { focus: "yes" }, { cwd: "\0" }]) {
    await assert.rejects(launcher.launch(uuid(), options, a.root));
  }
  assert.equal(a.w.created.length, 0);
});
test("initial task text cannot become a CLI option, file attachment or slash command", () => {
  const args = piArguments({ prompt: "--continue; $(echo bad)", provider: "p", model: "m", thinking: "high" }, "child", extension);
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "--continue; $(echo bad)");
  assert.equal(piArguments({ prompt: "@secret" }, "child", extension).at(-1), "Task:\n@secret");
  assert.equal(piArguments({ prompt: "/rxn nested" }, "child", extension).at(-1), "Task:\n/rxn nested");
});
test("verified launch binds exact task, conversation, session, block and process", async t => {
  const a = await active(t), launcher = setup(a, 1000);
  let seed;
  a.w.onCreate = args => { seed = acknowledge(a, args); };
  const result = await launcher.launch("call-1", { related: true, role: "review", prompt: "Review without editing", focus: false }, a.root);
  assert.equal(result.creation, "confirmed");
  assert.equal(result.startup.state, "bound");
  assert.equal(result.placement, "tab");
  assert.equal(result.identity.taskId, a.runtime.snapshot().state.taskId);
  assert.equal(result.identity.piSessionId, seed.piSessionId);
  assert.equal(result.target.blockId, a.w.next.blockId);
  assert.equal(result.handle.requestId, "call-1");
  assert.equal(result.handle.endpointGeneration, 1);
  const rawHandle = a.w.created[0].find(arg => arg.startsWith(AGENT_BOOTSTRAP_ENV + "="));
  assert.deepEqual(decodeAgentBootstrap(rawHandle.slice(rawHandle.indexOf("=") + 1)), result.handle);
  assert.ok(a.w.created[0].includes("--shell=none"));
  assert.ok(a.w.created[0].includes("--extension"));
  assert.equal(a.w.created[0].includes("--continue"), false);
});
test("related launches register identical created handles and record binding only after exact startup", async t => {
  const a = await active(t), parent = new AgentRuntime(), child = new AgentRuntime();
  const launcher = new Launcher(a.runtime, { extension, piBinary: "/bin/echo", agentDirectory: a.root,
    stateDirectory: a.store.directory, path: process.env.PATH, startupTimeoutMs: 1000, agents: parent });
  a.w.onCreate = args => acknowledge(a, args);
  const result = await launcher.launch("related-handle", { related: true }, a.root);
  assert.equal((await parent.status(result.handle)).lifecycle.binding, "bound");
  assert.equal((await parent.status(result.handle)).lifecycle.result, "pending");
  const raw = a.w.created[0].find(arg => arg.startsWith(AGENT_BOOTSTRAP_ENV + "="));
  const propagated = decodeAgentBootstrap(raw.slice(raw.indexOf("=") + 1));
  assert.deepEqual(child.register(propagated), result.handle);
  child.observe(propagated, { type: "binding.verified" });
  assert.deepEqual(child.register(propagated), parent.register(result.handle));
  assert.throws(() => decodeAgentBootstrap("not+canonical"), /Invalid agent handle bootstrap/);
});

test("child launches forward agents and messaging-stop shortcut overrides, including opt-out", async t => {
  for (const key of ["alt+shift+a", "off"]) {
    await t.test(key, async t => {
      const a = await active(t);
      const launcher = new Launcher(a.runtime, { extension, piBinary: "/bin/echo", agentDirectory: a.root,
        stateDirectory: a.store.directory, path: process.env.PATH, agentsKey: key, messagesStopKey: key, startupTimeoutMs: 1000 });
      a.w.onCreate = args => acknowledge(a, args);
      await launcher.launch("shortcut", { placement: "tab", focus: false }, a.root);
      assert.ok(a.w.created[0].includes("PI_REX_AGENTS_KEY=" + key));
      assert.ok(a.w.created[0].includes("PI_REX_MESSAGES_STOP_KEY=" + key));
    });
  }
});
test("new independent tasks get a new task identity and a selected session", async t => {
  const a = await active(t), launcher = setup(a, 1000);
  a.w.onCreate = args => acknowledge(a, args);
  const result = await launcher.launch("new-session", {}, a.root);
  assert.equal(result.placement, "session");
  assert.equal(result.startup.state, "bound");
  assert.notEqual(result.identity.taskId, a.runtime.snapshot().state.taskId);
  assert.equal(result.handle, undefined);
  assert.equal(a.w.created[0].some(arg => arg.startsWith(AGENT_BOOTSTRAP_ENV + "=")), false);
  assert.equal(a.w.selectCalls, 1);
});
test("all Pi placements keep their terminal after the agent exits", async t => {
  for (const placement of ["session", "right", "down", "tab"]) {
    await t.test(placement, async t => {
      const a = await active(t), launcher = setup(a, 1000);
      a.w.onCreate = args => acknowledge(a, args);
      const result = await launcher.launch("keep-open", { placement, focus: false }, a.root);
      assert.equal(result.creation, "confirmed");
      assert.equal(result.startup.state, "bound");
      const args = a.w.created[0];
      assert.ok(args.indexOf("--keep-open") < args.indexOf("--"));
      assert.ok(args.includes("--keep-open"));
      assert.ok(args.includes("--shell=none"));
    });
  }
});
test("repeated call IDs inspect the same promise and never relaunch", async t => {
  const a = await active(t), launcher = setup(a);
  const first = launcher.launch("same", { related: true }, a.root);
  const second = launcher.launch("same", { related: true }, a.root);
  assert.equal(first, second);
  await first;
  assert.equal(a.w.created.length, 1);
});
test("lost creation reply is unknown, not failed or automatically retried", async t => {
  const a = await active(t), launcher = setup(a);
  a.w.failCreate = true;
  const result = await launcher.launch("lost", { related: true }, a.root);
  assert.equal(result.creation, "unknown");
  assert.equal(result.startup.state, "unconfirmed");
  assert.match(result.startup.reason, /do not retry automatically/);
  assert.equal(a.runtime.hasRelatedSplit(a.runtime.snapshot().state), true);
  assert.equal(a.w.created.length, 1);
  assert.equal(a.w.calls.some(c => c.includes("close") || c.includes("kill") || c.includes("send")), false);
});
test("missing startup acknowledgement preserves the created pane", async t => {
  const a = await active(t), result = await setup(a).launch("timeout", { related: true }, a.root);
  assert.equal(result.creation, "confirmed");
  assert.equal(result.startup.state, "unconfirmed");
  assert.equal(result.target.blockId, a.w.next.blockId);
  assert.equal(a.w.created.length, 1);
});
test("a wrong conversation binding cannot confirm startup", async t => {
  const a = await active(t), launcher = setup(a);
  a.w.onCreate = args => acknowledge(a, args, seed => ({ ...seed, conversationId: uuid() }));
  const result = await launcher.launch("wrong", { related: true }, a.root);
  assert.equal(result.startup.state, "unconfirmed");
});
test("cancellation or parent shutdown after dispatch does not masquerade as a retryable failure", async t => {
  const a = await active(t), controller = new AbortController(), launcher = setup(a);
  a.w.onCreate = () => { controller.abort(); a.runtime.stop(); };
  const result = await launcher.launch("aborted", { related: true }, a.root, controller.signal);
  assert.equal(result.creation, "confirmed");
  assert.equal(result.startup.state, "unconfirmed");
  assert.equal(a.w.created.length, 1);
});
test("nonexistent cwd and invalid Pi binary do not create a pane", async t => {
  const a = await active(t), launcher = setup(a);
  await assert.rejects(launcher.launch("bad-cwd", { cwd: a.root + "/missing" }, a.root));
  const invalid = new Launcher(a.runtime, { extension, piBinary: "/not/a/pi", agentDirectory: a.root,
    stateDirectory: a.store.directory, path: "", startupTimeoutMs: 10 });
  await assert.rejects(invalid.launch("bad-binary", {}, a.root), /Executable not found/);
  assert.equal(a.w.created.length, 0);
});
