import test from "node:test";
import assert from "node:assert/strict";
import { HostSelection } from "../lib/host-selection.ts";
import { RemoteTerminalOpener, remoteProcessDirectory, remoteTerminalArgv } from "../lib/remote-terminal.ts";
import { Rex } from "../lib/rex.ts";
import { TerminalOpener } from "../lib/terminal.ts";
import { registerTerminalFeatures } from "../extensions/terminal.ts";
import { active, rid, world } from "./fixtures.mjs";

const REMOTE_HOST = "33333333-3333-4333-8333-333333333333";
const REMOTE_INSTANCE = "44444444-4444-4444-8444-444444444444";
const CONFIGURED_ID = "host:configured-debian";
const FORWARD = "/tmp/rex-debian-forward.sock";
const REMOTE_CWD = "/srv/debian/base with spaces";

function configured() {
  return Object.freeze({
    state: "configured", source: "rex hosts", rexConfigured: true,
    ready: false, readiness: "unverified", rexInstalled: "unknown", rexReachable: "unknown",
    id: CONFIGURED_ID, label: "Debian", alias: "debian", endpoints: Object.freeze(["unix://" + FORWARD]),
  });
}
function ticket(request) {
  return Object.freeze({ hostId: request.hostId, hostAlias: request.hostAlias,
    endpoint: request.localSocketPath, ownership: "rexpi" });
}
async function fixture(t, options = {}) {
  const a = await active(t);
  const w = world();
  w.remote = true;
  w.server = { endpoint: "unix:///remote-endpoint-is-not-adopted.sock",
    hostId: REMOTE_HOST, instanceId: REMOTE_INSTANCE };
  w.processData.set(w.source.blockId, {
    foreground: { pid: 700, name: "remote-shell", cwd: REMOTE_CWD }, child: null, ancestors: null,
  });
  let current = { configured: [configured()], candidates: [] };
  const registry = {
    snapshot: () => current,
    resolve: alias => current.configured.find(host => host.alias === alias),
    discover: async () => current,
  };
  const persisted = [];
  const transport = {
    operationRequests: [], closeRequests: [], disconnectListeners: new Set(),
    async connect(request) { return ticket(request); },
    async withOperation(request, operation, signal) {
      this.operationRequests.push(request);
      const result = await operation(ticket(request), signal ?? new AbortController().signal);
      // Model withOperation's post-dispatch cancellation fence for the cancellation test.
      if (signal?.aborted) throw new Error("operation_uncertain");
      return result;
    },
    async close(binding) { this.closeRequests.push(binding); },
    async closeAll() {},
    onDisconnect(_ticket, listener) {
      this.disconnectListeners.add(listener);
      return () => this.disconnectListeners.delete(listener);
    },
    disconnect() { for (const listener of [...this.disconnectListeners]) listener(); },
  };
  const selection = new HostSelection(a.runtime, registry, transport, {
    settings: { connections: { debian: {
      sshTarget: "rex-user@explicit.example", remoteSocketPath: "/run/user/1000/rex.sock",
      expectedServerHostId: REMOTE_HOST, expectedServerInstanceId: REMOTE_INSTANCE,
    } } },
    persist: intent => persisted.push(intent),
  });
  const opener = new RemoteTerminalOpener(selection,
    endpointTicket => new Rex("/explicit/local/rex", w.exec, endpointTicket.endpoint));
  if (options.selected) await selection.connect("debian");
  return { a, w, registry, transport, selection, opener, persisted,
    setHosts: hosts => { current = { configured: hosts, candidates: [] }; } };
}
function createdCommand(w, placement) {
  return placement === "floating"
    ? w.layerRequests[0].layout.block.options.command
    : w.created[0].slice(w.created[0].indexOf("--") + 1);
}

test("all remote placements use exact host/server and Rex IDs without mutating a one-off selection", async t => {
  for (const placement of ["session", "right", "down", "tab", "floating"]) {
    await t.test(placement, async child => {
      const f = await fixture(child);
      const before = f.selection.snapshot();
      const result = await f.opener.open("open-" + placement, {
        command: ["remote-tool", "literal; $(not-local)"], placement, focus: false, keepOpen: true,
      }, "debian");
      assert.equal(result.creation, "confirmed");
      assert.equal(result.placement, placement);
      assert.equal(result.executionHost.kind, "remote");
      assert.equal(result.executionHost.alias, "debian");
      assert.equal(result.executionHost.configuredHostId, CONFIGURED_ID);
      assert.equal(result.executionHost.expectedServerHostId, REMOTE_HOST);
      assert.equal(result.executionHost.expectedServerInstanceId, REMOTE_INSTANCE);
      assert.equal(result.executionHost.serverHostId, REMOTE_HOST);
      assert.equal(result.executionHost.serverInstanceId, REMOTE_INSTANCE);
      assert.equal(result.localOrigin.serverHostId, f.a.runtime.snapshot().server.hostId);
      assert.equal(result.localOrigin.serverInstanceId, f.a.runtime.snapshot().server.instanceId);
      assert.equal(result.localOrigin.blockId, f.a.w.source.blockId);
      assert.equal(result.target.blockId, f.w.next.blockId);
      assert.equal(result.target.sessionId, placement === "session" ? f.w.next.sessionId : f.w.source.sessionId);
      assert.equal(result.target.windowId, ["session", "tab"].includes(placement) ? f.w.next.windowId : f.w.source.windowId);
      if (placement === "floating") assert.ok(result.target.layerId.startsWith("layer:"));
      assert.strictEqual(f.selection.snapshot(), before);
      assert.equal(f.persisted.length, 0);
      assert.equal(f.transport.operationRequests.length, 1);
      assert.equal(f.transport.operationRequests[0].sshTarget, "rex-user@explicit.example");
      assert.equal(f.a.w.created.length, 0, "no local Rex mutation or fallback");
      assert.ok(f.w.calls.every(call => call.includes("-S") && call.includes(FORWARD)));
    });
  }
});

test("a new remote session needs no existing anchor, while anchored placements still do", async t => {
  const empty = await fixture(t);
  empty.w.blocks.clear();
  const result = await empty.opener.open("empty-session", {
    command: ["/bin/echo", "remote"], placement: "session", cwd: "~/project",
  }, "debian");
  assert.equal(result.creation, "confirmed");
  assert.equal(result.target.sessionId, empty.w.next.sessionId);
  const command = createdCommand(empty.w, "session");
  assert.equal(command[4], "~", "an unanchored session starts in the remote home, never the Mac cwd");
  assert.equal(command[5], "~/project");

  const anchored = await fixture(t);
  anchored.w.blocks.clear();
  await assert.rejects(anchored.opener.open("empty-split", { command: "true", placement: "right" }, "debian"),
    /No appropriate remote Rex terminal anchor/);
  assert.equal(anchored.w.created.length, 0, "the failed split did not create or retry a terminal");
});

test("remote cwd and command arguments are literal and never reuse local cwd or PATH", async t => {
  const f = await fixture(t);
  const localCwd = f.a.root;
  const localPath = process.env.PATH;
  await f.opener.open("relative", {
    command: ["remote-tool", "$HOME", "a b;$(touch /tmp/not-local)"], cwd: "../project with spaces",
  }, "debian");
  const command = createdCommand(f.w, "right");
  assert.deepEqual(command.slice(0, 4), ["/bin/sh", "-c", command[2], "rexpi-remote-terminal"]);
  assert.equal(command[4], REMOTE_CWD, "Rex cwd comes from the remote anchor process");
  assert.equal(command[5], "../project with spaces");
  assert.equal(command[6], "argv");
  assert.deepEqual(command.slice(7), ["remote-tool", "$HOME", "a b;$(touch /tmp/not-local)"]);
  assert.equal(command.includes(localCwd), false);
  assert.equal(command.includes(localPath), false);
  assert.equal(command.some(value => value.startsWith("PATH=")), false);
  assert.match(f.w.created[0][f.w.created[0].indexOf("--cwd") + 1], /^\/srv\/debian/);

  const pure = remoteTerminalArgv({ command: "printf '%s' \"$HOME\" | cat", cwd: "~/remote" }, "/remote/base");
  assert.equal(pure[5], "~/remote");
  assert.equal(pure[6], "shell");
  assert.equal(pure.at(-1), "printf '%s' \"$HOME\" | cat");
  assert.equal(pure.some(value => value.includes(localCwd)), false);
  assert.throws(() => remoteProcessDirectory({ foreground: { cwd: "relative/local-looking" } }), /invalid process cwd/);
});

test("selected remote hosts work while explicit local remains compatible and does not change selection", async t => {
  const f = await fixture(t, { selected: true });
  const selected = f.selection.snapshot();
  const tools = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    getSettings() { return {}; }, getCommands() { return []; }, registerCommand() {},
  };
  registerTerminalFeatures(pi, () => ({ runtime: f.a.runtime, terminal: new TerminalOpener(f.a.runtime),
    remoteTerminal: f.opener, hostSelection: f.selection }), f.a.ctx);
  const tool = tools.get("rexpi_open_terminal");
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(),
    ["bounds", "command", "cwd", "focus", "host", "keepOpen", "placement", "title"]);
  assert.ok(tool.parameters.properties.placement.anyOf.some(value => value.const === "session"));
  const toolCtx = { cwd: f.a.root, sessionManager: { getSessionId: () => "test-session" } };

  const remote = await tool.execute("selected-remote", { command: ["/bin/echo"] }, undefined, undefined, toolCtx);
  assert.equal(remote.details.executionHost.alias, "debian");
  assert.strictEqual(f.selection.snapshot(), selected);
  const local = await tool.execute("explicit-local", { command: ["/bin/echo"], host: "local" }, undefined, undefined, toolCtx);
  assert.equal(local.details.executionHost.kind, "local");
  assert.equal(local.details.executionHost.serverHostId, f.a.runtime.snapshot().server.hostId);
  assert.equal(local.details.localOrigin.serverHostId, f.a.runtime.snapshot().server.hostId);
  assert.strictEqual(f.selection.snapshot(), selected);
  assert.equal(f.transport.operationRequests.length, 1, "explicit local did not use the remote transport");
  assert.equal(f.a.w.created.length, 1);
});

test("request IDs stay fenced to their original runtime across tree replacement", async t => {
  const original = await fixture(t, { selected: true });
  const replacement = await fixture(t, { selected: true });
  let current = original;
  const tools = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    getSettings() { return {}; }, getCommands() { return []; }, registerCommand() {},
  };
  const state = value => ({ runtime: value.a.runtime, terminal: new TerminalOpener(value.a.runtime),
    remoteTerminal: value.opener, hostSelection: value.selection });
  registerTerminalFeatures(pi, () => state(current), original.a.ctx);
  const tool = tools.get("rexpi_open_terminal");
  const toolCtx = { cwd: original.a.root, sessionManager: { getSessionId: () => "test-session" } };
  const pending = tool.execute("tree-fence", { command: "true" }, undefined, undefined, toolCtx);
  current = replacement;
  original.a.runtime.stop();
  await assert.rejects(pending, /No verified|conversation changed/);
  await assert.rejects(tool.execute("tree-fence", { command: "true" }, undefined, undefined,
    { ...toolCtx, cwd: replacement.a.root }), /No verified|conversation changed/);
  assert.equal(original.transport.operationRequests.length, 0);
  assert.equal(replacement.transport.operationRequests.length, 0);
});

test("disconnected, unknown, and ambiguous hosts fail before any Rex mutation", async t => {
  const disconnected = await fixture(t, { selected: true });
  disconnected.transport.disconnect();
  await assert.rejects(disconnected.opener.open("disconnected", { command: "true" }), /disconnected|reconnection/);
  assert.equal(disconnected.transport.operationRequests.length, 0);
  assert.equal(disconnected.w.created.length, 0);

  const unknown = await fixture(t);
  await assert.rejects(unknown.opener.open("unknown", { command: "true" }, "unknown"), /Unknown configured/);
  assert.equal(unknown.transport.operationRequests.length, 0);
  assert.equal(unknown.a.w.created.length, 0);

  const ambiguousHost = await fixture(t);
  ambiguousHost.setHosts([configured(), configured()]);
  await assert.rejects(ambiguousHost.opener.open("ambiguous-host", { command: "true" }, "debian"), /ambiguous/);
  assert.equal(ambiguousHost.transport.operationRequests.length, 0);

  const ambiguousAnchor = await fixture(t);
  ambiguousAnchor.w.blocks.set(rid("block"), {
    sessionId: ambiguousAnchor.w.source.sessionId, windowId: ambiguousAnchor.w.source.windowId,
    blockId: ambiguousAnchor.w.next.blockId,
  });
  await assert.rejects(ambiguousAnchor.opener.open("ambiguous-anchor", { command: "true" }, "debian"), /anchor is ambiguous/);
  assert.equal(ambiguousAnchor.w.created.length, 0);
});

test("selection replacement and cancellation during preparation fail before creation", async t => {
  for (const kind of ["selection", "cancellation"]) {
    await t.test(kind, async child => {
      const f = await fixture(child, { selected: true });
      let entered, release;
      const waiting = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const exec = f.w.exec;
      f.w.exec = async (binary, args, options) => {
        if (args.includes("process")) { entered(); await gate; }
        return exec(binary, args, options);
      };
      const controller = new AbortController();
      const pending = f.opener.open("preparation-" + kind, { command: "true" }, undefined, controller.signal);
      await waiting;
      if (kind === "selection") await f.selection.connect("local");
      else controller.abort();
      release();
      await assert.rejects(pending);
      assert.equal(f.w.created.length, 0);
      assert.equal(f.transport.operationRequests.length, 1, "the operation callback was never retried");
    });
  }
});

test("post-dispatch cancellation and lost replies are unknown with no retry or cleanup", async t => {
  for (const kind of ["cancellation", "lost-reply"]) {
    await t.test(kind, async child => {
      const f = await fixture(child, { selected: true });
      const controller = new AbortController();
      if (kind === "cancellation") f.w.onCreate = () => controller.abort();
      else f.w.failCreate = true;
      const first = await f.opener.open("uncertain-" + kind, { command: ["/bin/echo"], placement: "floating" },
        undefined, controller.signal);
      assert.equal(first.creation, "unknown");
      assert.match(first.reason, /no retry or cleanup/);
      assert.equal(first.executionHost.configuredHostId, CONFIGURED_ID);
      assert.equal(first.executionHost.serverHostId, REMOTE_HOST);
      assert.equal(f.w.created.length, 1);
      assert.equal(f.transport.operationRequests.length, 1);
      assert.equal(f.transport.closeRequests.length, 0);
      const repeated = await f.opener.open("uncertain-" + kind, { command: ["different"] }, undefined, controller.signal);
      assert.deepEqual(repeated, first);
      assert.equal(f.w.created.length, 1);
      assert.equal(f.transport.operationRequests.length, 1);
    });
  }
});
