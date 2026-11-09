import test from "node:test";
import assert from "node:assert/strict";
import {
  HOST_SELECTION_ENTRY,
  HostSelection,
  parseHostSettings,
} from "../lib/host-selection.ts";
import { rootOrientation } from "../lib/state.ts";
import { createRemoteRexHealthProbe, registerHostTools } from "../extensions/hosts.ts";
import { registerConversationTools } from "../extensions/conversation.ts";
import { active } from "./fixtures.mjs";

const LOCAL_HOST = "11111111-1111-4111-8111-111111111111";
const LOCAL_INSTANCE = "22222222-2222-4222-8222-222222222222";
const REMOTE_HOST = "33333333-3333-4333-8333-333333333333";
const REMOTE_INSTANCE = "44444444-4444-4444-8444-444444444444";
const CONFIGURED_ID = "host:configured-debian";

function connection() {
  return {
    sshTarget: "rex-user@explicit.example",
    remoteSocketPath: "/run/user/1000/rex-remote.sock",
    expectedServerHostId: REMOTE_HOST,
    expectedServerInstanceId: REMOTE_INSTANCE,
  };
}
function settings() { return { connections: { debian: connection() } }; }
function configured(endpoints = ["unix:///tmp/rex-debian-forward.sock"]) {
  return Object.freeze({
    state: "configured", source: "rex hosts", rexConfigured: true,
    ready: false, readiness: "unverified", rexInstalled: "unknown", rexReachable: "unknown",
    id: CONFIGURED_ID, label: "Debian", alias: "debian", endpoints: Object.freeze(endpoints),
  });
}
function ticket(request) {
  return Object.freeze({
    hostId: request.hostId, hostAlias: request.hostAlias,
    endpoint: request.localSocketPath, ownership: "rexpi",
  });
}
function fakeRuntime(sessionId = "conversation-one") {
  let currentSession = sessionId;
  const lifecycle = new AbortController();
  let own = {
    state: rootOrientation(sessionId),
    server: { endpoint: "unix:///tmp/local-origin.sock", hostId: LOCAL_HOST, instanceId: LOCAL_INSTANCE },
    blockId: "block:local-origin", token: "local-lease-not-exposed", generation: 1, signal: lifecycle.signal,
  };
  const statuses = [];
  return {
    statuses,
    snapshot() { this.assert(own); return own; },
    assert(snapshot) {
      snapshot.signal.throwIfAborted();
      if (snapshot !== own || currentSession !== snapshot.state.piSessionId)
        throw new Error("Pi conversation changed; the operation was not continued");
    },
    setHostStatus(status) { statuses.push(status); },
    childStatus() { return []; },
    setSession(value) { currentSession = value; },
    replace() {
      own = { ...own, state: rootOrientation(currentSession), generation: own.generation + 1 };
    },
  };
}
function fixture(options = {}) {
  const runtime = fakeRuntime(options.sessionId);
  const host = options.host ?? configured();
  let current = options.discovered ?? { configured: [host], candidates: [] };
  const persisted = [...(options.persisted ?? [])];
  const registry = {
    requests: [],
    onDiscover: undefined,
    snapshot() { return current; },
    resolve(alias) { return current.configured.find(value => value.alias === alias); },
    async discover(request, signal) {
      signal?.throwIfAborted();
      this.requests.push(request);
      if (this.onDiscover) return this.onDiscover(request, signal);
      return current;
    },
  };
  const transport = {
    requests: [],
    closes: 0,
    closeRequests: [],
    disconnectListeners: new Set(),
    onConnect: undefined,
    async connect(request, signal) {
      signal?.throwIfAborted();
      this.requests.push(request);
      if (this.onConnect) return this.onConnect(request, signal);
      return ticket(request);
    },
    async close(binding) { this.closeRequests.push(binding); },
    async closeAll() { this.closes++; },
    onDisconnect(_ticket, listener) {
      this.disconnectListeners.add(listener);
      return () => this.disconnectListeners.delete(listener);
    },
    disconnect() { for (const listener of [...this.disconnectListeners]) listener(); },
  };
  const selection = new HostSelection(runtime, registry, transport, {
    settings: options.settings === undefined ? settings() : options.settings,
    entries: options.entries ?? persisted.map(data => ({ type: "custom", customType: HOST_SELECTION_ENTRY, data })),
    persist(intent) { persisted.push(intent); },
  });
  return { runtime, registry, transport, selection, persisted, host };
}
function remoteIntent(piSessionId = "conversation-one") {
  return {
    version: 1, piSessionId, kind: "remote", alias: "debian", configuredHostId: CONFIGURED_ID,
    expectedServerHostId: REMOTE_HOST, expectedServerInstanceId: REMOTE_INSTANCE,
  };
}

test("discovery and one-off lookup are read-only and never select a host", async () => {
  const f = fixture();
  const before = f.selection.snapshot();
  const discovered = await f.selection.discover({ tailscale: false });
  assert.equal(discovered.configured[0].alias, "debian");
  assert.deepEqual(f.registry.requests, [{ tailscale: false }]);
  assert.equal(f.selection.lookup("Debian").id, CONFIGURED_ID);
  assert.equal(f.selection.lookup("local"), undefined);
  assert.strictEqual(f.selection.snapshot(), before);
  assert.equal(f.transport.requests.length, 0);
  assert.equal(f.persisted.length, 0);
  assert.equal(f.runtime.statuses.at(-1), "local");
});

test("verified remote selection uses only explicit configuration and persists minimal intent", async () => {
  const f = fixture();
  const selected = await f.selection.connect("debian");
  assert.equal(selected.kind, "remote");
  assert.equal(selected.configuration, "configured");
  assert.equal(selected.state, "verified");
  assert.equal(selected.reconnectRequired, false);
  assert.equal(selected.configuredHostId, CONFIGURED_ID);
  assert.equal(selected.expectedServerHostId, REMOTE_HOST);
  assert.equal(selected.expectedServerInstanceId, REMOTE_INSTANCE);
  assert.deepEqual(f.registry.requests, [{ tailscale: false }]);
  assert.deepEqual(f.transport.requests, [{
    hostId: CONFIGURED_ID,
    hostAlias: "debian",
    sshTarget: "rex-user@explicit.example",
    localSocketPath: "/tmp/rex-debian-forward.sock",
    remoteSocketPath: "/run/user/1000/rex-remote.sock",
  }]);
  assert.deepEqual(f.persisted, [remoteIntent()]);
  const serialized = JSON.stringify(f.persisted[0]);
  for (const forbidden of ["sshTarget", "SocketPath", "endpoint", "ticket", "password", "explicit.example"])
    assert.equal(serialized.includes(forbidden), false);
  assert.ok(Object.isFrozen(selected));
  assert.ok(Object.isFrozen(selected.ticket));
  assert.throws(() => { selected.ticket.endpoint = "/tmp/replaced.sock"; }, TypeError);
  assert.equal(f.selection.snapshot().ticket.endpoint, "/tmp/rex-debian-forward.sock");
  assert.equal(f.runtime.statuses.at(-1), "debian verified");
});

test("percent-encoded configured Unix endpoints become exact local socket paths", async () => {
  const f = fixture({ host: configured(["unix:///tmp/rex%20debian.sock"]) });
  await f.selection.connect("debian");
  assert.equal(f.transport.requests[0].localSocketPath, "/tmp/rex debian.sock");
  const plain = fixture({ host: configured(["/tmp/rex%20debian.sock"]) });
  await plain.selection.connect("debian");
  assert.equal(plain.transport.requests[0].localSocketPath, "/tmp/rex%20debian.sock");
});

test("two conversations have isolated selections, intents, and tunnels", async () => {
  const first = fixture({ sessionId: "conversation-one" });
  const second = fixture({ sessionId: "conversation-two" });
  await first.selection.connect("debian");
  assert.equal(first.selection.snapshot().kind, "remote");
  assert.equal(second.selection.snapshot().kind, "local");
  assert.equal(second.registry.requests.length, 0);
  assert.equal(second.transport.requests.length, 0);
  assert.equal(second.persisted.length, 0);
  assert.equal(first.persisted[0].piSessionId, "conversation-one");
  await second.selection.connect("local");
  assert.equal(second.selection.snapshot().kind, "local");
  assert.equal(second.transport.requests.length, 0, "explicit local uses the already verified Runtime server");
  assert.deepEqual(second.persisted, [{ version: 1, piSessionId: "conversation-two", kind: "local" }]);
  assert.equal(first.selection.snapshot().kind, "remote");
});

test("owned disconnects revoke verified status and host switches close prior tunnels", async () => {
  const f = fixture();
  await f.selection.connect("debian");
  assert.equal(f.selection.snapshot().monitoring, "process");
  f.transport.disconnect();
  assert.equal(f.selection.snapshot().state, "disconnected");
  assert.equal(f.selection.snapshot().reconnectRequired, true);
  assert.equal(f.selection.snapshot().ticket, undefined);
  assert.equal(f.runtime.statuses.at(-1), "debian disconnected/reconnect-required");

  await f.selection.connect("debian");
  await f.selection.connect("local");
  assert.equal(f.transport.closeRequests.at(-1).hostId, CONFIGURED_ID);
  assert.equal(f.selection.snapshot().kind, "local");
  assert.equal(f.transport.disconnectListeners.size, 0);
});

test("external selections report point-in-time verification rather than process monitoring", async () => {
  const f = fixture();
  f.transport.onConnect = async request => ({ ...ticket(request), ownership: "external" });
  await f.selection.connect("debian");
  assert.equal(f.selection.snapshot().monitoring, "external");
  assert.equal(f.runtime.statuses.at(-1), "debian last-verified");
  assert.equal(f.transport.disconnectListeners.size, 0);
});

test("resume and tree restoration are disconnected and never probe or reconnect; forks exclude intent", () => {
  const entries = [{ type: "custom", customType: HOST_SELECTION_ENTRY, data: remoteIntent() }];
  const resumed = fixture({ entries });
  assert.equal(resumed.registry.requests.length, 0);
  assert.equal(resumed.transport.requests.length, 0);
  assert.equal(resumed.selection.snapshot().kind, "remote");
  assert.equal(resumed.selection.snapshot().state, "disconnected");
  assert.equal(resumed.selection.snapshot().reconnectRequired, true);
  assert.equal(resumed.selection.snapshot().ticket, undefined);
  assert.equal(resumed.selection.snapshot().expectedServerHostId, REMOTE_HOST);
  assert.equal(resumed.selection.snapshot().expectedServerInstanceId, REMOTE_INSTANCE);
  assert.equal(resumed.runtime.statuses.at(-1), "debian disconnected/reconnect-required");

  const tree = fixture({ entries });
  assert.equal(tree.selection.snapshot().state, "disconnected");
  assert.equal(tree.transport.requests.length, 0);
  const fork = fixture({ sessionId: "forked-session", entries });
  assert.equal(fork.selection.snapshot().kind, "local");
  assert.equal(fork.transport.requests.length, 0);

  const localEntries = [...entries,
    { type: "custom", customType: HOST_SELECTION_ENTRY,
      data: { version: 1, piSessionId: "conversation-one", kind: "local" } }];
  assert.equal(fixture({ entries: localEntries }).selection.snapshot().kind, "local");
});

test("a stale remote completion cannot overwrite a newer explicit local selection", async () => {
  const f = fixture();
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.transport.onConnect = async request => { entered(); await gate; return ticket(request); };
  const pending = f.selection.connect("debian");
  await waiting;
  await f.selection.connect("local");
  release();
  await assert.rejects(pending, /Host selection changed/);
  assert.equal(f.selection.snapshot().kind, "local");
  assert.deepEqual(f.persisted, [{ version: 1, piSessionId: "conversation-one", kind: "local" }]);
  assert.equal(f.runtime.statuses.at(-1), "local");
});

test("runtime/session replacement rejects a late completion before persistence or publication", async () => {
  for (const kind of ["runtime", "session"]) {
    const f = fixture();
    let entered, release;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    f.transport.onConnect = async request => { entered(); await gate; return ticket(request); };
    const pending = f.selection.connect("debian");
    await waiting;
    if (kind === "runtime") f.runtime.replace();
    else f.runtime.setSession("different-session");
    release();
    await assert.rejects(pending, /conversation changed/);
    assert.equal(f.persisted.length, 0);
    assert.equal(f.runtime.statuses.at(-1), "local");
  }
});

test("cancellation and transport failure preserve the prior selection with no local fallback", async () => {
  const cancelled = fixture();
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  cancelled.transport.onConnect = (_request, signal) => {
    entered();
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const controller = new AbortController();
  const before = cancelled.selection.snapshot();
  const pending = cancelled.selection.connect("debian", controller.signal);
  await waiting;
  controller.abort();
  await assert.rejects(pending);
  assert.strictEqual(cancelled.selection.snapshot(), before);
  assert.equal(cancelled.persisted.length, 0);
  assert.equal(cancelled.runtime.statuses.at(-1), "local");

  const failed = fixture();
  const failedBefore = failed.selection.snapshot();
  failed.transport.onConnect = async () => { throw new Error("identity mismatch or SSH failure"); };
  await assert.rejects(failed.selection.connect("debian"), /identity mismatch/);
  assert.strictEqual(failed.selection.snapshot(), failedBefore);
  assert.equal(failed.persisted.length, 0);
  assert.equal(failed.runtime.statuses.at(-1), "local");
});

test("discovery conflicts, unknown aliases, and ambiguous endpoints fail closed without transport", async () => {
  const conflict = fixture();
  conflict.registry.onDiscover = async () => { throw new Error("Conflicting configured Rex host alias or identity"); };
  await assert.rejects(conflict.selection.connect("debian"), /Conflicting/);
  assert.equal(conflict.transport.requests.length, 0);
  assert.equal(conflict.selection.snapshot().kind, "local");

  const unknown = fixture();
  await assert.rejects(unknown.selection.connect("unknown"), /Unknown configured Rex host/);
  assert.equal(unknown.transport.requests.length, 0);
  assert.equal(unknown.persisted.length, 0);

  const endpoints = fixture({ host: configured(["/tmp/one.sock", "/tmp/two.sock"]) });
  await assert.rejects(endpoints.selection.connect("debian"), /exactly one local Unix endpoint/);
  assert.equal(endpoints.transport.requests.length, 0);
  assert.equal(endpoints.selection.snapshot().kind, "local");

  const reserved = fixture({ discovered: { configured: [configured()], candidates: [{ alias: "local" }] } });
  await assert.rejects(reserved.selection.discover({ tailscale: false }), /reserved/);
  assert.equal(reserved.selection.snapshot().kind, "local");
});

test("missing explicit settings and mismatched transport tickets never persist or select", async () => {
  const missing = fixture({ settings: {} });
  await assert.rejects(missing.selection.connect("debian"), /No explicit pi-rex.hosts.connections entry/);
  assert.equal(missing.transport.requests.length, 0);
  assert.equal(missing.selection.snapshot().kind, "local");

  const mismatched = fixture();
  mismatched.transport.onConnect = async request => ({ ...ticket(request), hostId: "host:different" });
  await assert.rejects(mismatched.selection.connect("debian"), /different configured host/);
  assert.equal(mismatched.persisted.length, 0);
  assert.equal(mismatched.selection.snapshot().kind, "local");
});

test("whoami health accepts only exact expected server UUIDs and ignores remote endpoint/caller metadata", async () => {
  const parsed = parseHostSettings(settings());
  const calls = [];
  let response = {
    host_id: REMOTE_HOST,
    instance_id: REMOTE_INSTANCE,
    endpoint: "unix:///must-not-be-adopted.sock",
    block_id: "block:must-not-be-checked",
    principal: { kind: "remote-not-peer", transport: "tcp", uid: -1 },
  };
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: JSON.stringify(response), stderr: "" };
  };
  const probe = createRemoteRexHealthProbe(exec, "/explicit/rex", parsed);
  const request = {
    hostId: CONFIGURED_ID, hostAlias: "debian", sshTarget: "rex-user@explicit.example",
    localSocketPath: "/tmp/rex-debian-forward.sock", remoteSocketPath: "/run/user/1000/rex-remote.sock",
  };
  const options = { signal: new AbortController().signal, timeoutMs: 100 };
  assert.equal(await probe(request, options), true);
  assert.deepEqual(calls[0].args, ["--autostart=false", "--timeout", "5s", "-S",
    "/tmp/rex-debian-forward.sock", "whoami", "--json"]);
  response = { ...response, host_id: LOCAL_HOST };
  assert.equal(await probe(request, options), false, "exact host_id mismatch is unhealthy");
  response = { ...response, host_id: REMOTE_HOST, instance_id: LOCAL_INSTANCE };
  assert.equal(await probe(request, options), false, "exact instance_id mismatch is unhealthy");
  assert.equal(calls.every(call => call.args.includes("/tmp/local-origin.sock") === false), true,
    "there is no local-Rex probe fallback");
});

test("strict connection settings reject credentials, first-use identity, aliases, and unbounded paths", () => {
  const valid = connection();
  const cases = [
    { unknown: true },
    { connections: { debian: { ...valid, password: "secret" } } },
    { connections: { debian: { ...valid, identityFile: "/tmp/key" } } },
    { connections: { debian: { sshTarget: valid.sshTarget, remoteSocketPath: valid.remoteSocketPath } } },
    { connections: { debian: { ...valid, remoteSocketPath: "relative/rex.sock" } } },
    { connections: { debian: { ...valid, remoteSocketPath: "/run/rex:22.sock" } } },
    { connections: { debian: { ...valid, expectedServerHostId: "not-a-uuid" } } },
    { connections: { debian: { ...valid, sshTarget: " padded " } } },
    { connections: { local: valid } },
    { connections: { Debian: valid, debian: valid } },
  ];
  for (const value of cases) assert.throws(() => parseHostSettings(value));
  const parsed = parseHostSettings(settings());
  assert.equal(parsed.connections.get("debian").sshTarget, valid.sshTarget);
  assert.ok(Object.isFrozen(parsed.connections.get("debian")));
});

test("stop is idempotent and returns the pending transport cleanup", async () => {
  const f = fixture();
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  f.transport.closeAll = () => { calls++; return gate; };
  let settled = false;
  const first = f.selection.stop().then(() => { settled = true; });
  const second = f.selection.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(calls, 1, "repeated stop shares the same cleanup");
  release();
  await Promise.all([first, second]);
  assert.equal(settled, true);
  await assert.rejects(f.selection.connect("local"));
});

test("Runtime renders concise selected-host state in the Rexpi status line", async t => {
  const a = await active(t);
  const statuses = [];
  a.ctx.ui.setStatus = (key, text) => statuses.push({ key, text });
  a.runtime.setHostStatus("local");
  assert.equal(statuses.at(-1).key, "rexpi");
  assert.match(statuses.at(-1).text, / · host local$/);
  a.runtime.setHostStatus("debian verified");
  assert.match(statuses.at(-1).text, / · host debian verified$/);
  a.runtime.setHostStatus("debian disconnected/reconnect-required");
  assert.match(statuses.at(-1).text, / · host debian disconnected\/reconnect-required$/);
});

test("host tools and inspect expose verified selection without confusing the local origin", async () => {
  const f = fixture();
  const tools = new Map();
  const pi = { registerTool(tool) { tools.set(tool.name, tool); } };
  registerHostTools(pi, () => ({ runtime: f.runtime, hostSelection: f.selection }));
  registerConversationTools(pi, () => ({ runtime: f.runtime, hostSelection: f.selection }));
  const ctx = { sessionManager: { getSessionId: () => "conversation-one" } };
  assert.deepEqual(Object.keys(tools.get("rexpi_hosts").parameters.properties).sort(), ["openSsh", "tailscale"]);
  assert.equal(tools.get("rexpi_hosts").parameters.additionalProperties, false);
  assert.equal(tools.get("rexpi_connect_host").parameters.additionalProperties, false);

  const listed = await tools.get("rexpi_hosts").execute("list", {}, undefined, undefined, ctx);
  assert.equal(listed.details.configured[0].alias, "debian");
  assert.deepEqual(f.registry.requests[0], { tailscale: false });
  assert.equal(f.selection.snapshot().kind, "local");
  await tools.get("rexpi_hosts").execute("list-candidates", { openSsh: true, tailscale: true },
    undefined, undefined, ctx);
  assert.equal(f.registry.requests[1].tailscale, true);
  assert.match(f.registry.requests[1].openSsh.configPath, /\.ssh[\\/]config$/);
  assert.equal(f.selection.snapshot().kind, "local");
  const connected = await tools.get("rexpi_connect_host").execute("connect", { host: "debian" },
    undefined, undefined, ctx);
  assert.match(connected.content[0].text, /Verified and selected configured host 'debian'/);
  assert.match(connected.content[0].text, new RegExp(REMOTE_HOST));
  const inspected = await tools.get("rexpi_inspect").execute("inspect", {}, undefined, undefined, ctx);
  assert.equal(inspected.details.localOrigin.serverHostId, LOCAL_HOST);
  assert.equal(inspected.details.localOrigin.serverInstanceId, LOCAL_INSTANCE);
  assert.equal(inspected.details.executionHost.kind, "remote");
  assert.equal(inspected.details.executionHost.alias, "debian");
  assert.equal(inspected.details.executionHost.expectedServerHostId, REMOTE_HOST);
  assert.equal(inspected.details.executionHost.expectedServerInstanceId, REMOTE_INSTANCE);
  assert.equal(f.runtime.statuses.at(-1), "debian verified");
});
