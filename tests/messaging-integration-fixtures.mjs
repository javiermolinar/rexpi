import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { Launcher } from "../lib/launch.ts";
import { MessagingRuntime } from "../lib/messaging/runtime.ts";
import { FileMailbox } from "../lib/messaging/file-transport.ts";
import { endpointFromBinding } from "../lib/messaging/protocol.ts";
import { BOOTSTRAP_ENV, decodeBootstrap } from "../lib/state.ts";
import { active, rid } from "./fixtures.mjs";

// Only Node fixture processes. Never execute the launch command or contact Rex/Pi/providers.
export async function spawnPeer(t, config) {
  const home = join(config.root, "fixture-home"); mkdirSync(home, { recursive: true, mode: 0o700 });
  const child = fork(fileURLToPath(new URL("./messaging-peer.mjs", import.meta.url)), [], {
    cwd: config.root, execArgv: [], silent: true,
    env: { HOME: home, PATH: "", PI_CODING_AGENT_DIR: config.root,
      PI_REX_STATE_DIR: join(config.root, "bindings"), PI_REX_CLI: "/fixture-must-not-execute-rex" },
  });
  let stderr = "", seq = 0; const pending = new Map(), events = [];
  child.stderr.on("data", data => { stderr += data; });
  child.stdout.on("data", data => { stderr += `unexpected stdout: ${data}`; });
  const exit = new Promise(resolve => child.once("exit", (code, signal) => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(Error(`fixture exited ${code}/${signal}: ${stderr}`)); }
    pending.clear(); resolve({ code, signal });
  }));
  child.on("message", message => {
    if (message.event) { events.push(message); return; }
    const p = pending.get(message.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(message.id);
    if (message.error) p.reject(Object.assign(Error(message.error), { code: message.code }));
    else p.resolve(message.value);
  });
  const request = (op, args = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`fixture timeout: ${op}: ${stderr}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, op, ...args }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      // Known test-only Node child, not a native Rex/Pi peer.
      child.kill("SIGKILL");
    }
    await exit;
    assert.equal(stderr, "", "fixture must not emit unexpected output");
  });
  const ready = await request("init", { config });
  return { child, ready, request, exit, events };
}

export async function parentFixture(t, options = {}) {
  const a = await active(t);
  const sm = SessionManager.create(a.root, join(a.root, "sessions"), { id: "test-session" });
  sm.appendMessage({ role: "user", content: "explicit isolated test delegation", timestamp: Date.now() });
  for (const e of a.entries) sm.appendCustomEntry(e.customType, e.data);
  a.ctx.sessionManager = sm;
  const holds = { busy: false, pending: false, editor: "" };
  Object.assign(a.ctx, { isIdle: () => !holds.busy, hasPendingMessages: () => holds.pending });
  a.ctx.ui.getEditorText = () => holds.editor;
  const sent = [], diagnostics = [];
  const pi = options.pi ?? {
    appendEntry(type, data) { sm.appendCustomEntry(type, data); options.onAppend?.(type, data); },
    sendMessage(message, opts) { sent.push({ message, opts }); options.onSend?.(message, opts); },
  };
  const m = new MessagingRuntime(pi, a.runtime, a.root, {
    setTimer: () => ({ unref() {} }), clearTimer() {}, diagnostic: text => diagnostics.push(text),
  });
  m.attach(a.ctx); t.after(() => m.detach());
  const own = a.runtime.snapshot(), owner = endpointFromBinding(a.store.find(own.state, own.server));
  const mailbox = new FileMailbox(a.root, owner, a.store, own.server);
  const launcher = new Launcher(a.runtime, {
    extension: fileURLToPath(new URL("../extensions/index.ts", import.meta.url)), piBinary: "/bin/echo",
    agentDirectory: a.root, stateDirectory: a.store.directory, path: "", startupTimeoutMs: 2000, messaging: m,
  });
  const f = { ...a, sm, holds, sent, diagnostics, pi, m, own, owner, mailbox, launcher };
  f.launch = async (id = "fixture-launch") => {
    const block = rid("block"); a.w.next.blockId = block;
    let peer, command;
    a.w.onCreate = async args => {
      command = args;
      const raw = args.find(s => s.startsWith(BOOTSTRAP_ENV + "="));
      const seed = decodeBootstrap(raw.slice(raw.indexOf("=") + 1));
      peer = await spawnPeer(t, { root: a.root, server: own.server, blockId: block, seed,
        peers: [owner], sessionId: seed.piSessionId });
      a.w.processPids.set(block, peer.ready.endpoint.pid);
    };
    const result = await launcher.launch(id, { prompt: `Review fixture ${id}`, returnResults: true, focus: false }, a.root);
    assert.equal(result.creation, "confirmed"); assert.equal(result.startup.state, "bound");
    assert.equal(result.returnSetup.state, "registered");
    assert.equal(result.target.blockId, peer.ready.endpoint.blockId);
    await m.poll();
    return { ...peer, result, command, endpoint: peer.ready.endpoint, requestId: result.returnSetup.requestId,
      runId: result.returnSetup.runId, runtimeId: result.returnSetup.runtimeId, inReplyTo: result.returnSetup.messageId };
  };
  return f;
}
