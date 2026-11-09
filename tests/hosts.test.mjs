import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HOST_REGISTRY_SETTINGS,
  HostRegistry,
  normalizeHostAlias,
  parseHostRegistrySettings,
} from "../lib/hosts.ts";

function rexHost(id = "host-a", label = "Build Box", endpoints = ["/tmp/rex-a.sock"]) {
  return { from: "test", held: true, host: { id, label, endpoints } };
}
function rexText(hosts = []) { return JSON.stringify({ home: { label: "", endpoint: "unix:///tmp/rex-home.sock", this_machine: true, reached: true }, hosts }); }
function make(options = {}) {
  const calls = [], reads = [];
  const hosts = options.hosts ?? [];
  const exec = options.exec ?? (async (command, args, execOptions) => {
    calls.push({ command, args, options: execOptions });
    if (command === "/usr/bin/rex") return { code: 0, stdout: options.rexText ?? rexText(hosts), stderr: "" };
    if (command === "/usr/bin/tailscale")
      return { code: 0, stdout: options.tailscaleText ?? JSON.stringify({ Peer: {} }), stderr: "" };
    throw new Error("unexpected executable");
  });
  const registry = new HostRegistry(exec, {
    rexBinary: "/usr/bin/rex", tailscaleBinary: "/usr/bin/tailscale", settings: options.settings,
    readText: async (path, readOptions) => {
      reads.push({ path, options: readOptions });
      return options.openSshText ?? "Host from-file\n";
    },
  });
  return { registry, calls, reads };
}

test("construction is inert; rex uses literal argv and resolution is exact after normalization", async () => {
  const h = make({ hosts: [rexHost()] });
  assert.equal(h.calls.length, 0);
  assert.equal(h.reads.length, 0);
  assert.deepEqual(h.registry.snapshot(), { configured: [], candidates: [] });
  assert.equal(h.registry.resolve("build-box"), undefined);

  const result = await h.registry.discover({ tailscale: false });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].command, "/usr/bin/rex");
  assert.deepEqual(h.calls[0].args, ["--autostart=false", "--timeout", "5s", "hosts", "--json"]);
  assert.equal(h.calls[0].args.includes("--autostart=false"), true);
  assert.equal(h.calls[0].args.includes("--timeout"), true);
  assert.equal(result.configured.length, 1);
  const host = result.configured[0];
  assert.equal(host.alias, "build-box");
  assert.equal(host.state, "configured");
  assert.equal(host.rexConfigured, true);
  assert.equal(host.ready, false);
  assert.equal(host.readiness, "unverified");
  assert.equal(host.rexInstalled, "unknown");
  assert.equal(host.rexReachable, "unknown");
  assert.equal(h.registry.resolve("  BUILD__BOX "), host);
  assert.equal(h.registry.resolve("build box"), host);
  assert.equal(h.registry.resolve("build"), undefined);
  assert.equal(h.registry.resolve("build-box-extra"), undefined);
  assert.equal(h.registry.resolve("localhost"), undefined);
  assert.equal(normalizeHostAlias("Ｆｕｌｌｗｉｄｔｈ_Name"), "fullwidth-name");
});

test("identical configured rows and endpoint order deduplicate deterministically", async () => {
  const first = rexHost("host-a", "Same Host", ["/tmp/z.sock", "/tmp/a.sock"]);
  const duplicate = { ...rexHost("host-a", "Same Host", ["/tmp/a.sock", "/tmp/z.sock", "/tmp/a.sock"]), from: "another" };
  const h = make({ hosts: [first, duplicate] });
  const result = await h.registry.discover({ tailscale: false });
  assert.equal(result.configured.length, 1);
  assert.deepEqual(result.configured[0].endpoints, ["/tmp/a.sock", "/tmp/z.sock"]);
});

test("Unix endpoint forms canonicalize for deduplication and cross-owner conflict detection", async () => {
  const duplicate = make({ hosts: [
    rexHost("host-a", "Same", ["/tmp/rex.sock"]),
    rexHost("host-a", "Same", ["unix:///tmp/rex.sock"]),
  ] });
  const result = await duplicate.registry.discover({ tailscale: false });
  assert.deepEqual(result.configured[0].endpoints, ["/tmp/rex.sock"]);
  assert.equal(result.configured[0].unsupportedEndpoints, 0);

  const conflict = make({ hosts: [
    rexHost("host-a", "One", ["/tmp/rex.sock"]),
    rexHost("host-b", "Two", ["unix:///tmp/rex.sock"]),
  ] });
  await assert.rejects(conflict.registry.discover({ tailscale: false }), /endpoint ownership/);
});

test("unsupported remote endpoints remain bounded metadata without disabling host listing", async () => {
  const h = make({ hosts: [rexHost("host-a", "Mixed", [
    "tailscale://user:secret@example.test", "example.test:443", "unix:///tmp/rex.sock",
  ])] });
  const result = await h.registry.discover({ tailscale: false });
  assert.deepEqual(result.configured[0].endpoints, ["/tmp/rex.sock"]);
  assert.equal(result.configured[0].unsupportedEndpoints, 2);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("configured alias, identity, and endpoint conflicts fail closed", async t => {
  const cases = [
    ["alias", [rexHost("host-a", "Same"), rexHost("host-b", "same")]],
    ["identity", [rexHost("host-a", "One"), rexHost("host-a", "Two")]],
    ["endpoints", [rexHost("host-a", "Same", ["/tmp/a.sock"]), rexHost("host-a", "Same", ["/tmp/b.sock"])]],
    ["endpoint ownership", [rexHost("host-a", "One", ["/tmp/shared.sock"]), rexHost("host-b", "Two", ["/tmp/shared.sock"])]],
  ];
  for (const [name, hosts] of cases) await t.test(name, async () => {
    const h = make({ hosts });
    await assert.rejects(h.registry.discover({ tailscale: false }), /conflict/i);
    assert.deepEqual(h.registry.snapshot(), { configured: [], candidates: [] });
    assert.equal(h.registry.resolve("same"), undefined);
  });
});

test("malformed rex responses and entries are rejected without partial registry state", async t => {
  const cases = [
    ["invalid JSON", { rexText: "{" }],
    ["missing home", { rexText: JSON.stringify({ hosts: [] }) }],
    ["invalid hosts", { rexText: JSON.stringify({ home: "home", hosts: {} }) }],
    ["missing host", { hosts: [{ from: "test", held: true }] }],
    ["missing entry metadata", { hosts: [{ host: rexHost().host }] }],
    ["bad identity", { hosts: [rexHost("bad/id")] }],
    ["bad label", { hosts: [rexHost("host-a", "user@example.com")] }],
    ["missing endpoints", { hosts: [rexHost("host-a", "Valid", [])] }],
    ["relative endpoint", { hosts: [rexHost("host-a", "Valid", ["tmp/rex.sock"])] }],
    ["non-string endpoint", { hosts: [rexHost("host-a", "Valid", [42])] }],
  ];
  for (const [name, options] of cases) await t.test(name, async () => {
    const h = make(options);
    await assert.rejects(h.registry.discover({ tailscale: false }), /malformed|invalid|no endpoint|local unix/i);
    assert.deepEqual(h.registry.snapshot(), { configured: [], candidates: [] });
  });
});

test("OpenSSH candidates require explicit input and expose no directives or credential material", async () => {
  const secretValues = [
    "/keys/id_ed25519", "private-certificate", "agent-secret", "vault-token",
    "ssh user@jump", "touch /tmp/should-not-run", "pkcs11-secret", "/socket/with/token",
  ];
  const config = `
Host "Work_Box" other-alias
  HostName work.example.com
  User alice
  IdentityFile ${secretValues[0]}
  CertificateFile ${secretValues[1]}
  IdentityAgent ${secretValues[2]}
  ProxyCommand ${secretValues[4]}
  RemoteCommand ${secretValues[5]}
  LocalCommand ${secretValues[5]}
  PKCS11Provider ${secretValues[6]}
  ControlPath ${secretValues[7]}
  SetEnv TOKEN=${secretValues[3]}
Host *.wildcard
  HostName ignored.example.com
Host alias-only
`;
  const h = make();
  const result = await h.registry.discover({ tailscale: false, openSsh: { configText: config } });
  assert.deepEqual(result.candidates.map(candidate => candidate.alias), ["alias-only", "other-alias", "work-box"]);
  assert.ok(result.candidates.every(candidate => candidate.source === "openssh"));
  assert.ok(result.candidates.every(candidate => candidate.state === "candidate" && candidate.rexConfigured === false));
  assert.ok(result.candidates.every(candidate => candidate.ready === false && candidate.rexInstalled === "unknown"));
  assert.equal(h.registry.resolve("work-box"), undefined);
  const serialized = JSON.stringify(result);
  for (const secret of secretValues) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("work.example.com"), false);
  assert.equal(serialized.includes("alice"), false);
  assert.equal(h.reads.length, 0);
});

test("OpenSSH keyword=value forms are parsed as data", async () => {
  const h = make();
  const result = await h.registry.discover({ tailscale: false,
    openSsh: { configText: "Host=box\nHostName=box.example.com\n" } });
  assert.deepEqual(result.candidates.map(candidate => candidate.alias), ["box"]);
});

test("OpenSSH files are read only for an explicit request, with an exact path and abort signal", async () => {
  const path = "/tmp/config; touch /tmp/not-a-command";
  const h = make({ openSshText: "Host from-file\n  HostName host.example.com\n" });
  await h.registry.discover({ tailscale: false });
  assert.equal(h.reads.length, 0);
  const result = await h.registry.discover({ tailscale: false, openSsh: { configPath: path } });
  assert.equal(h.reads.length, 1);
  assert.equal(h.reads[0].path, path);
  assert.ok(h.reads[0].options.signal instanceof AbortSignal);
  assert.ok(h.reads[0].options.maxBytes > 0);
  assert.deepEqual(result.candidates.map(candidate => candidate.alias), ["from-file"]);
  assert.equal(h.calls.filter(call => call.command !== "/usr/bin/rex").length, 0);
});

test("OpenSSH patterns are not candidates; duplicates dedupe and malformed or conflicting entries fail", async t => {
  await t.test("duplicate equivalent stanzas", async () => {
    const h = make();
    const config = "Host box\nHostName box.example.com\nHost box\nHostName box.example.com\n";
    const result = await h.registry.discover({ tailscale: false, openSsh: { configText: config } });
    assert.deepEqual(result.candidates.map(candidate => candidate.alias), ["box"]);
  });
  const cases = [
    ["conflicting HostName", "Host box\nHostName one.example.com\nHost box\nHostName two.example.com\n", /conflict/i],
    ["unterminated quote", "Host \"box\n", /malformed/i],
    ["empty Host", "Host\n", /malformed/i],
    ["credential-like alias", "Host user@example.com\n", /invalid/i],
    ["credential-like HostName", "Host box\nHostName user@example.com\n", /unsupported/i],
  ];
  for (const [name, configText, expected] of cases) await t.test(name, async () => {
    const h = make();
    await assert.rejects(h.registry.discover({ tailscale: false, openSsh: { configText } }), expected);
    assert.deepEqual(h.registry.snapshot().candidates, []);
  });
});

test("Tailscale supplies connectivity candidates only and never Rex readiness", async () => {
  const node = {
    ID: "node-a", DNSName: "Tail-Box.example.ts.net.", TailscaleIPs: ["100.64.0.2", "fd7a::2"],
    Online: true, Secret: "do-not-copy", Authorized: true,
  };
  const h = make({ tailscaleText: JSON.stringify({ Self: node, Peer: { duplicate: node } }) });
  const result = await h.registry.discover();
  assert.deepEqual(h.calls.map(call => call.args), [["--autostart=false", "--timeout", "5s", "hosts", "--json"], ["status", "--json"]]);
  assert.equal(result.configured.length, 0);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.alias, "tail-box");
  assert.equal(candidate.source, "tailscale");
  assert.equal(candidate.rexConfigured, false);
  assert.equal(candidate.ready, false);
  assert.equal(candidate.rexInstalled, "unknown");
  assert.equal(candidate.rexReachable, "unknown");
  assert.equal("endpoints" in candidate, false);
  assert.deepEqual(candidate.connectivity.addresses, ["100.64.0.2", "fd7a::2"]);
  assert.equal(candidate.connectivity.online, true);
  assert.equal(JSON.stringify(result).includes("do-not-copy"), false);
  assert.equal(h.registry.resolve("tail-box"), undefined);
});

test("Tailscale empty DNS names and null address lists use bounded fallback data", async () => {
  const h = make({ tailscaleText: JSON.stringify({ Self: {
    ID: "node-a", DNSName: "", HostName: "fallback.example.ts.net", TailscaleIPs: null,
  } }) });
  const result = await h.registry.discover();
  assert.equal(result.candidates[0].alias, "fallback");
  assert.deepEqual(result.candidates[0].connectivity.addresses, []);
});

test("Tailscale duplicates, identity conflicts, and malformed connectivity fail closed", async t => {
  await t.test("different nodes cannot share an alias", async () => {
    const text = JSON.stringify({ Peer: {
      a: { ID: "a", DNSName: "same.example.ts.net", TailscaleIPs: ["100.64.0.1"] },
      b: { ID: "b", DNSName: "same.example.ts.net", TailscaleIPs: ["100.64.0.2"] },
    } });
    const h = make({ tailscaleText: text });
    await assert.rejects(h.registry.discover(), /conflict/i);
  });
  await t.test("one identity cannot change names", async () => {
    const text = JSON.stringify({ Peer: {
      a: { ID: "same", DNSName: "one.example.ts.net" },
      b: { ID: "same", DNSName: "two.example.ts.net" },
    } });
    const h = make({ tailscaleText: text });
    await assert.rejects(h.registry.discover(), /conflict/i);
  });
  for (const [name, node] of [
    ["bad address", { ID: "a", DNSName: "a.example.ts.net", TailscaleIPs: ["not-an-ip"] }],
    ["bad online state", { ID: "a", DNSName: "a.example.ts.net", Online: "yes" }],
    ["missing name", { ID: "a", TailscaleIPs: [] }],
    ["bad DNS name", { ID: "a", DNSName: "user@example.com" }],
  ]) await t.test(name, async () => {
    const h = make({ tailscaleText: JSON.stringify({ Peer: { a: node } }) });
    await assert.rejects(h.registry.discover(), /malformed|no name/i);
    assert.deepEqual(h.registry.snapshot().candidates, []);
  });
});

test("aliases cannot collide across configured, OpenSSH, and Tailscale sources", async t => {
  await t.test("configured versus OpenSSH", async () => {
    const h = make({ hosts: [rexHost("host-a", "Shared")] });
    await assert.rejects(h.registry.discover({ tailscale: false, openSsh: { configText: "Host shared\n" } }), /conflict/i);
  });
  await t.test("configured versus Tailscale", async () => {
    const h = make({ hosts: [rexHost("host-a", "Shared")],
      tailscaleText: JSON.stringify({ Self: { ID: "a", DNSName: "shared.example.ts.net" } }) });
    await assert.rejects(h.registry.discover(), /conflict/i);
  });
  await t.test("OpenSSH versus Tailscale", async () => {
    const h = make({ tailscaleText: JSON.stringify({ Self: { ID: "a", DNSName: "shared.example.ts.net" } }) });
    await assert.rejects(h.registry.discover({ openSsh: { configText: "Host shared\n" } }), /conflict/i);
  });
});

test("entry and aggregate output limits are enforced independently of the executor", async t => {
  await t.test("configured entries and endpoints share an entry budget", async () => {
    const h = make({ hosts: [rexHost("a", "One"), rexHost("b", "Two")], settings: { discovery: { maxEntries: 3 } } });
    await assert.rejects(h.registry.discover({ tailscale: false }), /entry limit/i);
  });
  await t.test("OpenSSH aliases are bounded", async () => {
    const h = make({ settings: { discovery: { maxEntries: 2 } } });
    await assert.rejects(h.registry.discover({ tailscale: false, openSsh: { configText: "Host one two three\n" } }), /entry limit/i);
  });
  await t.test("input bytes are bounded", async () => {
    const h = make({ settings: { discovery: { maxOutputBytes: 128 } } });
    const configText = "Host one\n" + "#" + "x".repeat(200) + "\n";
    await assert.rejects(h.registry.discover({ tailscale: false, openSsh: { configText } }), /output limit/i);
  });
  await t.test("executor truncation is fatal", async () => {
    const h = make({ exec: async () => ({ code: 0, stdout: "", stderr: "", truncated: true }) });
    await assert.rejects(h.registry.discover({ tailscale: false }), /output limit/i);
  });
});

test("overlapping discoveries serialize rather than failing spuriously", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let active = 0, maximum = 0, attempts = 0;
  const h = make({ exec: async () => {
    attempts++;
    active++; maximum = Math.max(maximum, active);
    if (active === 1) await gate;
    active--;
    return { code: 0, stdout: rexText(), stderr: "" };
  } });
  const first = h.registry.discover({ tailscale: false });
  const second = h.registry.discover({ tailscale: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(maximum, 1);
  assert.equal(attempts, 2);
});

test("a whole-discovery deadline rejects even when an executor ignores AbortSignal", async () => {
  let observed;
  const h = make({
    settings: { discovery: { timeoutMs: 20 } },
    exec: async (_command, _args, options) => {
      observed = options;
      return new Promise(() => {});
    },
  });
  await assert.rejects(h.registry.discover({ tailscale: false }), /timed out/i);
  assert.ok(observed.signal.aborted);
  assert.ok(observed.timeout <= 20);
  assert.ok(observed.maxBuffer > 0);
});

test("external cancellation is prompt, propagated, and does no work when already aborted", async () => {
  const controller = new AbortController();
  let observed;
  const h = make({ exec: async (_command, _args, options) => {
    observed = options;
    return new Promise(() => {});
  } });
  const pending = h.registry.discover({ tailscale: false }, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /cancelled/i);
  assert.ok(observed.signal.aborted);

  const already = new AbortController();
  already.abort();
  const inert = make();
  await assert.rejects(inert.registry.discover({ tailscale: false }, already.signal), /cancelled/i);
  assert.equal(inert.calls.length, 0);
});

test("failed refresh clears old authority; empty and unknown names never fall back", async () => {
  let fail = false;
  const h = make({ exec: async () => fail
    ? { code: 1, stdout: "", stderr: "sensitive process output" }
    : { code: 0, stdout: rexText([rexHost()]), stderr: "" } });
  await h.registry.discover({ tailscale: false });
  assert.ok(h.registry.resolve("build-box"));
  fail = true;
  await assert.rejects(h.registry.discover({ tailscale: false }), error => {
    assert.equal(error.message.includes("sensitive"), false);
    return /exit 1/.test(error.message);
  });
  assert.equal(h.registry.resolve("build-box"), undefined);
  assert.equal(h.registry.resolve("localhost"), undefined);
  assert.deepEqual(h.registry.snapshot(), { configured: [], candidates: [] });
});

test("settings schema has bounded defaults and rejects unknown or invalid values", () => {
  assert.deepEqual(parseHostRegistrySettings(), DEFAULT_HOST_REGISTRY_SETTINGS);
  assert.deepEqual(parseHostRegistrySettings({ discovery: { maxEntries: 8, maxOutputBytes: 1024, timeoutMs: 50 } }),
    { discovery: { maxEntries: 8, maxOutputBytes: 1024, timeoutMs: 50 } });
  for (const settings of [
    { selected: "host-a" },
    { discovery: { openSshConfig: "~/.ssh/config" } },
    { discovery: { maxEntries: 0 } },
    { discovery: { maxOutputBytes: 1.5 } },
    { discovery: { timeoutMs: 31_000 } },
  ]) assert.throws(() => parseHostRegistrySettings(settings), /setting/i);
});
