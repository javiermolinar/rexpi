// Explicit, no-prompt native test. Creates and destroys only its own hidden Rex session.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { executable } from "../lib/executable.ts";
import { Rex } from "../lib/rex.ts";
import { BindingStore } from "../lib/store.ts";
import { rexId } from "../lib/state.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-rex-smoke-")));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rexBinary = executable(process.env.PI_REX_CLI ?? "rex", process.cwd());
const piBinary = executable(process.env.PI_REX_BINARY ?? "pi", process.cwd());
const run = promisify(execFile);
let createdSession;
let creationAttempted = false;
const exec = async (command, args, options) => {
  const response = await run(command, args, { timeout: options?.timeout ?? 7000, maxBuffer: options?.maxBuffer, signal: options?.signal });
  try {
    const value = JSON.parse(response.stdout);
    if (creationAttempted && args.includes("new") && rexId(value.session_id, "session")
        && value.session_id !== process.env.REX_SESSION) createdSession = value.session_id;
  } catch { /* most commands do not create sessions */ }
  return { ...response, code: 0 };
};
const rex = new Rex(rexBinary, exec, process.env.PI_REX_SERVER);
const store = new BindingStore(join(root, "bindings"));
const parentId = randomUUID();
let parentTarget;
const childPids = new Set();
let success = false;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  const server = await rex.initialize(process.env.REX_BLOCK);
  const source = await rex.locate(process.env.REX_BLOCK);
  const agent = join(root, "agent"); mkdirSync(agent, { mode: 0o700 });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({
    defaultProvider: "openai", defaultModel: "gpt-4.1",
    "pi-rex": { commands: {
      "smoke-float": { run: ["/bin/sh", "-c", "printf floating-tool-ok; exec /bin/sleep 60"],
        placement: "floating", focus: false, title: "pi-rex floating smoke", bounds: [0.2, 0.2, 0.6, 0.6] },
      "smoke-tab": { run: ["/bin/sh", "-c", "printf tab-tool-ok; exec /bin/sleep 60"],
        placement: "tab", focus: false, title: "pi-rex tab smoke" },
    } },
  }), { mode: 0o600 });
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "pi-rex-no-prompt-smoke-not-a-real-key" } }), { mode: 0o600 });
  const wrapper = join(root, "pi-smoke.sh");
  writeFileSync(wrapper, "#!/bin/sh\nexport PI_OFFLINE=1\nexec " + quote(piBinary)
    + ' --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp --no-themes "$@"\n', { mode: 0o700 });
  creationAttempted = true;
  parentTarget = await rex.create({ placement: "session", source, cwd: repo, sessionName: "pi-rex smoke workspace", title: "pi-rex smoke", focus: false,
    command: ["/usr/bin/env", "PATH=" + process.env.PATH, "PI_CODING_AGENT_DIR=" + agent,
      "PI_REX_CLI=" + rexBinary, "PI_REX_SERVER=" + server.endpoint, "PI_REX_BINARY=" + wrapper, "PI_REX_STATE_DIR=" + store.directory,
      wrapper, "--extension", join(repo, "extensions", "index.ts"), "--session-id", parentId] });
  createdSession = parentTarget.sessionId;
  const matches = await rex.matchingSessions("PI-REX SMOKE WORKSPACE");
  assert.deepEqual(matches, [{ sessionId: createdSession, name: "pi-rex smoke workspace" }]);
  const initial = await rex.view(createdSession);
  assert.equal(initial.windows[0].label, "pi-rex smoke", "Session name and tab title must be independent");
  const wait = async predicate => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const found = store.all().filter(predicate);
      if (found.length === 1) return found[0];
      await sleep(200);
    }
    throw new Error("Native Pi binding was not observed before the smoke-test deadline");
  };
  const parent = await wait(b => b.piSessionId === parentId && b.blockId === parentTarget.blockId);
  childPids.add(parent.pid);
  await rex.verifyProcess(await rex.locate(parent.blockId), parent.pid);
  // These are extension commands, not model prompts. The wrapper disables automatic network activity.
  const sendCommand = async (block, command) => {
    await exec(rexBinary, ["--autostart=false", "-S", server.endpoint, "send", "-s", createdSession, "-b", block, command]);
    await exec(rexBinary, ["--autostart=false", "-S", server.endpoint, "send-key", "-s", createdSession, "-b", block, "enter"]);
  };
  await sendCommand(parent.blockId, "/rxt");
  const child = await wait(b => b.piSessionId !== parentId);
  childPids.add(child.pid);
  assert.notEqual(child.blockId, parent.blockId);
  await rex.verifyProcess(await rex.locate(child.blockId), child.pid);
  const childLocation = await rex.locate(child.blockId);
  assert.equal(childLocation.sessionId, createdSession);
  assert.notEqual(childLocation.windowId, parentTarget.windowId, "Pi must start in a new tab");
  const sessions = join(agent, "sessions");
  const files = readdirSync(sessions, { recursive: true }).filter(name => name.endsWith(".jsonl"));
  const entries = files.flatMap(name => readFileSync(join(sessions, name), "utf8").trim().split("\n").map(JSON.parse));
  // Pi deliberately keeps setup-only conversations in memory until the first user/assistant message.
  assert.equal(entries.some(e => e.type === "message" && e.message.role === "assistant"), false);
  await sendCommand(child.blockId, "/reload");
  const reloaded = await wait(b => b.piSessionId === child.piSessionId && b.token !== child.token);
  assert.equal(reloaded.conversationId, child.conversationId);
  await sendCommand(child.blockId, "/rxwho");
  let observedOrigin = false;
  for (let i = 0; i < 30; i++) {
    const capture = await exec(rexBinary, ["--autostart=false", "-S", server.endpoint, "capture", "-s", createdSession, "-b", child.blockId, "--trim", "--unwrap"]);
    if (capture.stdout.includes(parent.conversationId)) { observedOrigin = true; break; }
    await sleep(100);
  }
  assert.ok(observedOrigin, "Live child identity must retain its precise parent after /reload");
  await sendCommand(child.blockId, "/rxbk");
  let returned = false;
  for (let i = 0; i < 30; i++) {
    const view = await rex.view(createdSession);
    if (view.active_window_id === parentTarget.windowId
        && view.windows.some(w => w.window_id === parentTarget.windowId && w.focused_block_id === parent.blockId)) {
      returned = true; break;
    }
    await sleep(100);
  }
  assert.ok(returned, "Same-session /rxbk must focus the exact parent without an app action");
  await sendCommand(child.blockId, "/new");
  const replaced = await wait(b => b.blockId === child.blockId && b.piSessionId !== child.piSessionId);
  assert.notEqual(replaced.conversationId, child.conversationId);
  assert.equal(replaced.role, "main");
  for (const [command, title, token, kind] of [
    ["/smoke-float", "pi-rex floating smoke", "floating-tool-ok", "floating"],
    ["/smoke-tab", "pi-rex tab smoke", "tab-tool-ok", "tiled"],
  ]) {
    await sendCommand(parent.blockId, command);
    let helper;
    for (let i = 0; i < 50 && !helper; i++) {
      const view = await rex.view(createdSession);
      for (const window of view.windows) for (const layer of window.layers) {
        const block = layer.blocks.find(b => b.label === title)
          ?? (window.label === title && layer.blocks.length === 1 ? layer.blocks[0] : undefined);
        if (block) {
          assert.equal(layer.kind, kind);
          if (kind === "floating") assert.deepEqual(layer.bounds, [0.2, 0.2, 0.6, 0.6]);
          helper = block;
        }
      }
      if (!helper) await sleep(100);
    }
    assert.ok(helper, "Configured " + kind + " terminal must be created once");
    const process = await rex.json(["block", "call", "-s", createdSession, "-b", helper.block_id, "process"]);
    childPids.add(process.child?.pid ?? process.foreground.pid);
    let outputSeen = false;
    for (let i = 0; i < 30; i++) {
      const captured = await exec(rexBinary, ["--autostart=false", "-S", server.endpoint, "capture", "-s", createdSession, "-b", helper.block_id, "--trim"]);
      if (captured.stdout.includes(token)) { outputSeen = true; break; }
      await sleep(100);
    }
    assert.ok(outputSeen, "Configured command must actually run in its created terminal");
    const after = await rex.view(createdSession);
    assert.equal(after.active_window_id, parentTarget.windowId, "Background tools must not change the active tab");
    assert.equal(after.windows.find(w => w.window_id === parentTarget.windowId).focused_block_id, parent.blockId);
  }
  console.log("Native smoke passed: exact named workspace + independent tab title, real Pi root + child tab, exact process bindings, parent identity across /reload, same-session /rxbk focus, fresh identity after /new, configured floating/tab tools with preserved focus; no model prompts. Cross-session app selection was not exercised.");
  success = true;
} catch (error) {
  if (parentTarget) {
    try {
      const result = await exec(rexBinary, ["--autostart=false", "capture", "-s", parentTarget.sessionId, "-b", parentTarget.blockId, "--trim"]);
      console.error(result.stdout.slice(-5000));
    } catch { /* do not retry unknown creation */ }
  }
  throw error;
} finally {
  if (createdSession) {
    const view = await rex.view(createdSession);
    assert.equal(view.label, "pi-rex smoke workspace", "Refusing to clean up a session not identified as this smoke test");
    for (const value of store.all()) childPids.add(value.pid);
    await rex.api("session.destroy", { session_id: createdSession });
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const end = Date.now() + 5000;
    while ([...childPids].some(alive) && Date.now() < end) await sleep(100);
    assert.ok(![...childPids].some(alive), "Test Pi processes are not quiescent; state retained at " + root);
    rmSync(root, { recursive: true, force: true });
  } else if (!creationAttempted) rmSync(root, { recursive: true, force: true });
  else console.error("Creation outcome unknown; inspect Rex before cleanup. Test state retained at " + root);
  if (!success) process.exitCode = 1;
}
