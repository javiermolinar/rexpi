import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CAPABILITY_GRANT_ENV, Launcher, MAX_CAPABILITY_DELEGATION_DEPTH, MAX_CAPABILITY_PATH_LENGTH,
  MAX_CAPABILITY_PATHS, MAX_CAPABILITY_TIMEOUT_MS, MAX_CAPABILITY_TOOL_LENGTH, MAX_CAPABILITY_TOOLS, MAX_CAPABILITY_TURNS,
  decodeCapabilityGrant, encodeCapabilityGrant, parseCapabilityGrant, piArguments, placementFor, validateOptions } from "../lib/launch.ts";
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
const capabilityGrant = () => ({ tools: ["read", "write", "rex_start_pi"], readPaths: ["/repo/../literal", "/repo/[exact]"],
  writePaths: ["/repo/output"], delegation: { maxDepth: 2 }, returnResults: true, turns: 7, timeoutMs: 30_000 });
const withoutGrantField = (value, field) => { const copy = { ...value }; delete copy[field]; return copy; };
function grantAssignment(args) {
  return args.find(arg => arg.startsWith(CAPABILITY_GRANT_ENV + "="));
}

test("capability grants round-trip literal bounded values without normalization", () => {
  const value = capabilityGrant();
  assert.deepEqual(parseCapabilityGrant(value), value);
  assert.deepEqual(decodeCapabilityGrant(encodeCapabilityGrant(value)), value);
  const boundary = { tools: ["t".repeat(MAX_CAPABILITY_TOOL_LENGTH)], readPaths: ["r".repeat(MAX_CAPABILITY_PATH_LENGTH)],
    writePaths: [], delegation: { maxDepth: MAX_CAPABILITY_DELEGATION_DEPTH }, returnResults: false,
    turns: MAX_CAPABILITY_TURNS, timeoutMs: MAX_CAPABILITY_TIMEOUT_MS };
  assert.deepEqual(decodeCapabilityGrant(encodeCapabilityGrant(boundary)), boundary);
  assert.deepEqual(parseCapabilityGrant({ ...capabilityGrant(), tools: [], readPaths: [], writePaths: [], delegation: { maxDepth: 0 },
    turns: 1, timeoutMs: 1 }).delegation, { maxDepth: 0 });
});

test("capability grant schema rejects missing, unknown, duplicate, malformed and unbounded input", () => {
  const value = capabilityGrant();
  const invalid = [null, [], withoutGrantField(value, "tools"), withoutGrantField(value, "readPaths"),
    withoutGrantField(value, "writePaths"), withoutGrantField(value, "delegation"), withoutGrantField(value, "returnResults"),
    withoutGrantField(value, "turns"), withoutGrantField(value, "timeoutMs"), { ...value, extra: true },
    { ...value, tools: "read" }, { ...value, tools: ["read", "read"] }, { ...value, tools: [""] },
    { ...value, tools: ["bad tool"] }, { ...value, tools: ["t".repeat(MAX_CAPABILITY_TOOL_LENGTH + 1)] },
    { ...value, tools: Array.from({ length: MAX_CAPABILITY_TOOLS + 1 }, (_, i) => "tool" + i) },
    { ...value, readPaths: ["/same", "/same"] }, { ...value, readPaths: ["relative\0path"] },
    { ...value, readPaths: ["p".repeat(MAX_CAPABILITY_PATH_LENGTH + 1)] },
    { ...value, writePaths: Array.from({ length: MAX_CAPABILITY_PATHS + 1 }, (_, i) => "/p" + i) },
    { ...value, delegation: { maxDepth: -1 } }, { ...value, delegation: { maxDepth: MAX_CAPABILITY_DELEGATION_DEPTH + 1 } },
    { ...value, delegation: { maxDepth: 1.5 } }, { ...value, delegation: { maxDepth: 1, extra: true } },
    { ...value, returnResults: 1 }, { ...value, turns: 0 }, { ...value, turns: MAX_CAPABILITY_TURNS + 1 },
    { ...value, turns: 1.5 }, { ...value, timeoutMs: 0 }, { ...value, timeoutMs: MAX_CAPABILITY_TIMEOUT_MS + 1 },
    { ...value, timeoutMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...value, readPaths: Array.from({ length: 5 }, (_, i) => i + "p".repeat(MAX_CAPABILITY_PATH_LENGTH)) }];
  for (const candidate of invalid) assert.throws(() => parseCapabilityGrant(candidate));
  for (const raw of ["", "not+canonical", "a".repeat(22_001), Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify({ ...value, extra: "secret" })).toString("base64url")])
    assert.throws(() => decodeCapabilityGrant(raw), /Invalid capability grant bootstrap/);
});

test("launcher propagates only the literal grant and never inherits it into a later launch", async t => {
  const a = await active(t), launcher = setup(a), value = capabilityGrant();
  await launcher.launch("granted", { prompt: "Delegated task", related: true, grant: value }, a.root);
  const granted = a.w.created[0], raw = grantAssignment(granted);
  assert.ok(raw);
  assert.deepEqual(decodeCapabilityGrant(raw.slice(raw.indexOf("=") + 1)), value);
  const identityRaw = granted.find(arg => arg.startsWith(BOOTSTRAP_ENV + "="));
  assert.equal(decodeBootstrap(identityRaw.slice(identityRaw.indexOf("=") + 1)).grant, undefined,
    "identity bootstrap remains grant-free");
  assert.equal(JSON.stringify(a.entries).includes("readPaths"), false, "orientation entries never persist grants");
  await launcher.launch("unganted-after-grant", { role: "review", prompt: JSON.stringify(value) }, a.root);
  assert.equal(grantAssignment(a.w.created[1]), undefined, "roles, prompts, and prior launches cannot create or inherit grants");
});

test("no grant preserves the launch command and malformed grants fail before native creation", async t => {
  const a = await active(t), launcher = setup(a);
  await launcher.launch("default", {}, a.root);
  assert.equal(grantAssignment(a.w.created[0]), undefined);
  assert.ok(a.w.created[0].some(arg => arg.startsWith(BOOTSTRAP_ENV + "=")));
  const before = a.w.created.length;
  for (const [index, invalid] of [{ ...capabilityGrant(), turns: 0 }, { ...capabilityGrant(), writePaths: ["/x", "/x"] },
    { ...capabilityGrant(), delegation: { maxDepth: 99 } }, { ...capabilityGrant(), unknown: true }].entries())
    await assert.rejects(launcher.launch("invalid-grant-" + index, { grant: invalid }, a.root));
  assert.equal(a.w.created.length, before);
});

test("grants are rejected for unrelated launches before native creation", async t => {
  const a = await active(t), launcher = setup(a), value = capabilityGrant();
  for (const [index, options] of [{ grant: value }, { related: false, grant: value }].entries())
    await assert.rejects(launcher.launch("unrelated-grant-" + index, options, a.root), /grant requires a related launch/);
  assert.equal(a.w.created.length, 0);
});

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
  assert.throws(() => parent.pinEndpoint(result.handle, "0".repeat(64)), /Stale|conflicting/,
    "verified startup pins the expected incarnation before any remote read");
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
