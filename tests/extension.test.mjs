import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, symlinkSync } from "node:fs";
import piRex, { agentsKey, returnKey, messagesStopKey } from "../extensions/index.ts";
import { sandbox, world, uuid, binding } from "./fixtures.mjs";
import { BindingStore } from "../lib/store.ts";
import { BOOTSTRAP_ENV, decodeBootstrap } from "../lib/state.ts";

function fixture(t, overrides = {}, settings = {}) {
  const root = sandbox(t), w = world(), events = new Map(), tools = new Map(), commands = new Map(), shortcuts = [], entries = [], notices = [];
  const changes = { REX_SESSION: w.source.sessionId, REX_BLOCK: w.source.blockId, PI_REX_CLI: "/bin/echo",
    PI_REX_STATE_DIR: join(root, "bindings"), PI_REX_BINARY: "/bin/echo", PI_REX_BOOTSTRAP: undefined,
    PI_REX_RETURN_KEY: undefined, PI_REX_AGENTS_KEY: undefined, PI_REX_MESSAGES_STOP_KEY: undefined, ...overrides };
  const old = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) value === undefined ? delete process.env[key] : process.env[key] = value;
  t.after(() => {
    events.get("session_shutdown")?.({}, ctx);
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  const ctx = { cwd: root, mode: "tui", hasUI: true,
    sessionManager: { getSessionId: () => "factory-session", getBranch: () => entries,
      getSessionFile: () => undefined, getLeafId: () => null },
    ui: { setStatus() {}, notify: (...args) => notices.push(args) } };
  const pi = { on: (name, handler) => events.set(name, handler), exec: w.exec,
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
    registerShortcut: (key, action) => shortcuts.push({ key, action }),
    getSettings: () => settings,
    getCommands: () => [...commands.keys()].map(name => ({ name, source: "extension" })) };
  piRex(pi);
  return { root, w, events, tools, commands, shortcuts, entries, notices, ctx, pi };
}
test("factory has no background IO; verified TUI startup registers the Pi tool", async t => {
  const f = fixture(t);
  assert.equal(f.w.calls.length, 0);
  assert.equal(f.tools.size, 0);
  await f.events.get("session_start")({}, f.ctx);
  assert.ok(f.tools.has("rex_start_pi"));
  assert.ok(f.tools.has("rex_message_send"));
  assert.ok(f.tools.get("rex_start_pi").parameters.properties.returnResults);
  assert.ok(f.tools.has("rex_message_inbox"));
  assert.ok(f.tools.get("rex_start_pi").parameters.properties.project);
  assert.equal(f.tools.has("rex_jump"), false);
  assert.ok(f.tools.has("rex_open_terminal"));
  assert.ok(f.tools.has("rex_open_session"));
  assert.ok(f.tools.get("rex_start_pi").parameters.properties.sessionName);
  assert.equal(f.tools.get("rex_start_pi").executionMode, "sequential");
  assert.ok(f.tools.has("rex_return_to_parent"));
  assert.ok(f.tools.has("rex_inspect"));
  assert.ok(f.tools.has("rex_message_control"));
  assert.deepEqual([...f.commands.keys()].sort(), ["rxa", "rxagents", "rxh", "rxn", "rxt", "rxv", "rxw", "rxworktrees"]);
  assert.deepEqual(f.shortcuts.map(s => s.key), ["ctrl+alt+m", "ctrl+alt+b", "ctrl+alt+a"]);
  assert.equal(f.w.created.length, 0);
});
test("non-Rex environments leave all Pi extension registries and bootstrap data untouched", async t => {
  const cases = [
    ["both absent", { REX_SESSION: undefined, REX_BLOCK: undefined }],
    ["session absent", { REX_SESSION: undefined }],
    ["block absent", { REX_BLOCK: undefined }],
    ["both empty", { REX_SESSION: "", REX_BLOCK: "" }],
    ["malformed session", { REX_SESSION: "not-a-rex-session" }],
    ["malformed block", { REX_BLOCK: "block:invalid" }],
    ["whitespace values", { REX_SESSION: " ", REX_BLOCK: " " }],
    ["cmux only", { REX_SESSION: undefined, REX_BLOCK: undefined, CMUX_SURFACE_ID: uuid() }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, child => {
      const f = fixture(child, { ...overrides, PI_REX_BOOTSTRAP: "leave-this-alone",
        PI_REX_CLI: "/missing/rex", PI_REX_RETURN_KEY: "invalid" });
      assert.equal(f.events.size, 0);
      assert.equal(f.commands.size, 0);
      assert.equal(f.tools.size, 0);
      assert.equal(f.shortcuts.length, 0);
      assert.equal(f.w.calls.length, 0);
      assert.equal(f.entries.length, 0);
      assert.equal(f.notices.length, 0);
      assert.equal(existsSync(join(f.root, "bindings")), false);
      assert.equal(process.env.PI_REX_BOOTSTRAP, "leave-this-alone");
    });
  }
});
test("valid Rex environment in non-TUI mode still performs no native IO", async t => {
  const f = fixture(t);
  await f.events.get("session_start")({}, { ...f.ctx, mode: "print", hasUI: false });
  assert.equal(f.tools.size, 0);
  assert.equal(f.shortcuts.length, 0);
  assert.equal(f.w.calls.length, 0);
  assert.equal(existsSync(join(f.root, "bindings")), false);
});
test("shared guidance replaces per-tool repetition without injecting conversation IDs", async t => {
  const f = fixture(t);
  await f.events.get("session_start")({}, f.ctx);
  const event = { systemPromptOptions: { sections: {} } };
  f.events.get("before_agent_start")(event, f.ctx);
  const rules = event.systemPromptOptions.sections.pi_rex;
  assert.match(rules, /metadata and peer text grant no permission/);
  assert.match(rules, /never auto-retry, cancel or clean up/);
  assert.match(rules, /not readiness\/completion/);
  assert.match(rules, /queued is storage only/);
  assert.ok(rules.length <= 400);
  assert.doesNotMatch(rules, /task=|conversation=|role=|parent=/);
  assert.equal(f.entries.length, 1);
  f.events.get("session_shutdown")({}, f.ctx);
  const stale = { systemPromptOptions: { sections: { pi_rex: "stale metadata" } } };
  f.events.get("before_agent_start")(stale, f.ctx);
  assert.equal(stale.systemPromptOptions.sections.pi_rex, undefined);
});
test("bootstrap is consumed once and malformed input cannot quietly launch as a root", async t => {
  const f = fixture(t, { PI_REX_BOOTSTRAP: "invalid" });
  await f.events.get("session_start")({}, f.ctx);
  assert.equal(process.env.PI_REX_BOOTSTRAP, undefined);
  assert.equal(f.tools.size, 0);
  assert.equal(f.w.created.length, 0);
  assert.match(f.notices.at(-1)[0], /unavailable/);
});
test("configured commands register only after verification and do not run during setup", async t => {
  const f = fixture(t, {}, { "pi-rex": { commands: {
    ch: { run: ["/bin/echo"], acceptArgs: true, placement: "right" },
    rxn: { run: ["/bin/echo", "must not override"] },
  } } });
  assert.equal(f.commands.has("ch"), false);
  await f.events.get("session_start")({}, f.ctx);
  assert.ok(f.commands.has("ch"));
  assert.equal(f.w.created.length, 0);
  assert.ok(f.notices.some(([message]) => message.includes("reserved")));
  await f.commands.get("ch").handler('"a path with spaces"', f.ctx);
  assert.equal(f.w.created.length, 1);
  assert.equal(f.w.created[0].at(-1), "a path with spaces");
});
test("rex_open_terminal is independent from the configured command catalog", async t => {
  const f = fixture(t, {}, { "pi-rex": { commands: "invalid catalog" } });
  await f.events.get("session_start")({}, f.ctx);
  const tool = f.tools.get("rex_open_terminal");
  assert.ok(tool);
  const result = await tool.execute("generic", { command: ["/bin/echo", "not a catalog entry"], placement: "floating" },
    new AbortController().signal, undefined, f.ctx);
  assert.equal(result.details.creation, "confirmed");
  assert.ok(result.details.target.layerId);
  assert.equal(f.w.created.length, 1);
  assert.equal(f.w.layerRequests[0].layout.block.options.command.at(-1), "not a catalog entry");
});
test("rex_start_pi opens project paths with the requested placement and no extra slash commands", async t => {
  for (const placement of ["session", "right", "down", "tab"]) await t.test(placement, async t => {
    const f = fixture(t);
    await f.events.get("session_start")({}, f.ctx);
    const store = new BindingStore(join(f.root, "bindings"));
    f.w.onCreate = args => {
      const raw = args.find(arg => arg.startsWith(BOOTSTRAP_ENV + "="));
      store.write(binding(decodeBootstrap(raw.slice(raw.indexOf("=") + 1)), { blockId: f.w.next.blockId }));
    };
    const result = await f.tools.get("rex_start_pi").execute("project", { project: f.root, placement, focus: false },
      new AbortController().signal, undefined, f.ctx);
    assert.deepEqual(result.details.project, { directory: f.root, matchedBy: "path" });
    assert.equal(result.details.placement, placement);
    assert.equal(result.details.startup.state, "bound");
    assert.match(result.content[0].text, /Resolved .* via path/);
    assert.match(result.content[0].text, new RegExp("Created a fresh Pi " + placement));
    assert.equal(f.w.created.length, 1);
    assert.equal(f.w.created[0].filter(arg => arg === "--").length, 1, "No initial task prompt");
    assert.deepEqual([...f.commands.keys()].sort(), ["rxa", "rxagents", "rxh", "rxn", "rxt", "rxv", "rxw", "rxworktrees"]);
  });
});
test("rex_start_pi resolves zoxide projects without forcing new-tab placement", async t => {
  const bin = sandbox(t); symlinkSync("/bin/echo", join(bin, "zoxide"));
  const f = fixture(t, { PATH: bin });
  let lookups = 0;
  f.pi.exec = async (binary, args, options) => {
    if (args[0] !== "query") return f.w.exec(binary, args, options);
    lookups++;
    assert.deepEqual(args, ["query", "--", "pr-inbox"]);
    assert.equal(options.cwd, f.root); assert.equal(options.timeout, 5000);
    return { code: 0, stdout: f.root + "\n", stderr: "" };
  };
  await f.events.get("session_start")({}, f.ctx);
  const store = new BindingStore(join(f.root, "bindings"));
  f.w.onCreate = args => {
    const raw = args.find(arg => arg.startsWith(BOOTSTRAP_ENV + "="));
    store.write(binding(decodeBootstrap(raw.slice(raw.indexOf("=") + 1)), { blockId: f.w.next.blockId }));
  };
  const result = await f.tools.get("rex_start_pi").execute("pr-inbox", { project: "pr-inbox", focus: false },
    undefined, undefined, f.ctx);
  assert.equal(result.details.project.matchedBy, "zoxide");
  assert.equal(result.details.placement, "session");
  assert.equal(result.details.target.sessionId, f.w.next.sessionId);
  assert.equal(result.details.startup.state, "bound");
  assert.match(result.content[0].text, /via zoxide/);
  assert.equal(lookups, 1); assert.equal(f.w.created.length, 1);
});
test("pending project lookup cannot transfer to a replacement runtime or repeat under the same call ID", async t => {
  const bin = sandbox(t); symlinkSync("/bin/echo", join(bin, "zoxide"));
  const f = fixture(t, { PATH: bin });
  let entered, release, lookups = 0;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.pi.exec = async (binary, args, options) => {
    if (args[0] !== "query") return f.w.exec(binary, args, options);
    lookups++; entered(); await gate;
    return { code: 0, stdout: f.root + "\n", stderr: "" };
  };
  await f.events.get("session_start")({}, f.ctx);
  const call = () => f.tools.get("rex_start_pi").execute("pending-project", { project: "pr-inbox" }, undefined, undefined, f.ctx)
    .then(value => ({ value }), error => ({ error }));
  const first = call();
  await waiting;
  await f.events.get("session_tree")({}, f.ctx);
  const second = call();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.ok(a.error); assert.equal(b.error, a.error);
  assert.equal((await call()).error, a.error);
  assert.equal(lookups, 1); assert.equal(f.w.created.length, 0);
});
test("rex_open_session reuses existing workspaces without Pi launch or task parameters", async t => {
  const f = fixture(t);
  await f.events.get("session_start")({}, f.ctx);
  const tool = f.tools.get("rex_open_session");
  assert.equal(tool.parameters.properties.prompt, undefined);
  const result = await tool.execute("reuse", { sessionName: "Source", focus: false },
    new AbortController().signal, undefined, f.ctx);
  assert.equal(result.details.outcome, "existing");
  assert.equal(f.w.created.length, 0);
  assert.equal(f.entries.length, 1);
});
test("creation tool outcomes survive tree replacement without new native work", async t => {
  const cases = [
    ["terminal", "rex_open_terminal", () => ({ command: ["/bin/echo"] })],
    ["project launch", "rex_start_pi", f => ({ project: f.root, focus: false })],
    ["named session", "rex_open_session", f => ({ sessionName: "New workspace", query: f.root, focus: false })],
  ];
  for (const [name, tool, input] of cases) await t.test(name, async t => {
    const f = fixture(t);
    await f.events.get("session_start")({}, f.ctx);
    f.w.failCreate = true;
    const call = () => f.tools.get(tool).execute("stable-create", input(f), undefined, undefined, f.ctx);
    const first = await call();
    assert.equal(first.details.creation ?? first.details.launch.creation, "unknown");
    const attempts = f.w.created.length;
    await f.events.get("session_tree")({}, f.ctx);
    assert.deepEqual(await call(), first);
    assert.equal(f.w.created.length, attempts);
    f.events.get("session_shutdown")({}, f.ctx);
    assert.deepEqual(await call(), first, "historical evidence needs no replacement runtime");
  });
});
test("creation tool rejections survive tree replacement", async t => {
  const cases = [
    ["terminal", "rex_open_terminal", { command: "" }],
    ["project launch", "rex_start_pi", { project: "" }],
    ["named session", "rex_open_session", { sessionName: "" }],
  ];
  for (const [name, tool, input] of cases) await t.test(name, async t => {
    const f = fixture(t);
    await f.events.get("session_start")({}, f.ctx);
    const call = () => f.tools.get(tool).execute("stable-rejection", input, undefined, undefined, f.ctx);
    const first = await call().then(() => assert.fail("Invalid input must reject"), error => error);
    await f.events.get("session_tree")({}, f.ctx);
    await assert.rejects(call(), error => error === first);
    assert.equal(f.w.created.length, 0);
  });
});
test("a pending terminal creation keeps its original outcome fence across tree replacement", async t => {
  const f = fixture(t);
  await f.events.get("session_start")({}, f.ctx);
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.w.failCreate = true;
  f.w.onCreate = async () => { entered(); await gate; };
  const call = () => f.tools.get("rex_open_terminal").execute("pending-create", { command: ["/bin/echo"] }, undefined, undefined, f.ctx)
    .then(value => ({ value }), error => ({ error }));
  const first = call();
  await waiting;
  await f.events.get("session_tree")({}, f.ctx);
  const second = call();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(b, a);
  assert.equal(a.value.details.creation, "unknown");
  assert.equal(f.w.created.length, 1);
});
test("agents shortcut opens directly, registers once and becomes inert after shutdown", async t => {
  const f = fixture(t);
  let opened = 0;
  f.ctx.ui.custom = async () => { opened++; return undefined; };
  assert.equal(f.shortcuts.length, 0);
  await f.events.get("session_start")({}, f.ctx);
  const shortcut = f.shortcuts.find(s => s.key === "ctrl+alt+a");
  await shortcut.action.handler(f.ctx);
  assert.equal(opened, 1);
  assert.equal(f.w.created.length, 0);
  await f.events.get("session_tree")({}, f.ctx);
  assert.equal(f.shortcuts.length, 3);
  await shortcut.action.handler(f.ctx);
  assert.equal(opened, 2);
  await shortcut.action.handler({ ...f.ctx, mode: "rpc" });
  await shortcut.action.handler({ ...f.ctx, sessionManager: { getSessionId: () => "changed" } });
  assert.equal(opened, 2);
  f.events.get("session_shutdown")({}, f.ctx);
  const before = f.w.calls.length;
  await shortcut.action.handler(f.ctx);
  assert.equal(opened, 2);
  assert.equal(f.w.calls.length, before);
});
test("agents shortcut customization, opt-out, invalid keys and return-key conflicts", async t => {
  for (const [key, expected] of [["alt+shift+a", ["ctrl+alt+m", "ctrl+alt+b", "alt+shift+a"]],
    ["off", ["ctrl+alt+m", "ctrl+alt+b"]], ["invalid", ["ctrl+alt+m", "ctrl+alt+b"]],
    ["ctrl+alt+b", ["ctrl+alt+m", "ctrl+alt+b"]], ["ctrl+alt+m", ["ctrl+alt+m", "ctrl+alt+b"]]]) {
    await t.test(key, async t => {
      const f = fixture(t, { PI_REX_AGENTS_KEY: key });
      await f.events.get("session_start")({}, f.ctx);
      assert.deepEqual(f.shortcuts.map(s => s.key), expected);
      assert.ok(f.commands.has("rxa"));
      assert.ok(f.commands.has("rxagents"));
    });
  }
});
test("agents shortcut key validation uses the same format as the return key", () => {
  assert.equal(agentsKey(), "ctrl+alt+a");
  assert.equal(agentsKey("off"), undefined);
  assert.equal(agentsKey("ctrl+shift+x"), "ctrl+shift+x");
  for (const key of ["a", "cmd+q", "ctrl+alt+cmd+a", "invalid", "alt+ctrl+a"])
    assert.throws(() => agentsKey(key), /PI_REX_AGENTS_KEY/);
});
test("return shortcut supports opt-out and rejects malformed modifier strings", () => {
  assert.equal(returnKey(), "ctrl+alt+b");
  assert.equal(returnKey("off"), undefined);
  assert.equal(returnKey("ctrl+shift+x"), "ctrl+shift+x");
  for (const key of ["b", "cmd+q", "ctrl+alt+cmd+b", "invalid", "alt+ctrl+b"]) assert.throws(() => returnKey(key));
});
test("inspection replaces identity/status commands and follows current state without enabling returns", async t => {
  const f = fixture(t);
  await f.events.get("session_start")({}, f.ctx);
  const inspect = () => f.tools.get("rex_inspect").execute("inspect", {}, undefined, undefined, f.ctx);
  const before = f.w.calls.length, result = await inspect();
  assert.equal(result.details.piSessionId, "factory-session");
  assert.equal(result.details.blockId, f.w.source.blockId);
  assert.deepEqual(result.details.children, []);
  assert.equal(result.details.messaging.enabled, false);
  assert.equal(result.details.messaging.returnRequests, 0);
  assert.equal(result.details.token, undefined, "do not expose the local lease token");
  assert.equal(f.w.calls.length, before, "inspection is not a native process probe");
  assert.equal(f.tools.get("rex_inspect").annotations.readOnlyHint, true);
  const oldToken = new BindingStore(join(f.root, "bindings")).all()[0].token;
  await f.events.get("session_tree")({}, f.ctx);
  assert.notEqual(new BindingStore(join(f.root, "bindings")).all()[0].token, oldToken);
  assert.equal((await inspect()).details.conversationId, result.details.conversationId);
  const stale = { ...f.ctx, sessionManager: { getSessionId: () => "changed" } };
  for (const name of ["rex_inspect", "rex_return_to_parent"]) {
    await assert.rejects(f.tools.get(name).execute("stale", {}, undefined, undefined, stale), /conversation changed/);
  }
  f.events.get("session_shutdown")({}, f.ctx);
  await assert.rejects(inspect(), /No verified/);
});
test("direct messaging stop requires no model and remains usable while busy, idempotent and inert after shutdown", async t => {
  const f = fixture(t);
  f.ctx.isIdle = () => false;
  f.ctx.hasPendingMessages = () => false;
  await f.events.get("session_start")({}, f.ctx);
  const control = action => f.tools.get("rex_message_control").execute("control", { action }, undefined, undefined, f.ctx);
  const stop = f.shortcuts.find(s => s.key === "ctrl+alt+m").action;
  assert.equal((await control("observe")).details.enabled, true);
  const before = f.w.calls.length;
  await stop.handler(f.ctx);
  assert.match(f.notices.at(-1)[0], /Future return permissions revoked; worker stopped/);
  assert.equal((await control("status")).details.enabled, false);
  assert.equal(f.w.calls.length, before);
  assert.equal(f.w.created.length, 0);
  await stop.handler(f.ctx);
  await control("observe");
  await stop.handler({ ...f.ctx, sessionManager: { getSessionId: () => "changed" } });
  assert.equal((await control("status")).details.enabled, true, "a stale context cannot stop a replacement conversation");
  await f.events.get("session_tree")({}, f.ctx);
  await control("observe");
  await stop.handler(f.ctx);
  assert.equal((await control("status")).details.enabled, false);
  assert.equal(f.shortcuts.filter(s => s.key === "ctrl+alt+m").length, 1);
  f.events.get("session_shutdown")({}, f.ctx);
  await stop.handler(f.ctx);
  assert.match(f.notices.at(-1)[0], /No verified/);
});
test("messaging stop key validation and opt-out; stop wins collisions with navigation", async t => {
  assert.equal(messagesStopKey(), "ctrl+alt+m");
  assert.equal(messagesStopKey("off"), undefined);
  assert.equal(messagesStopKey("ctrl+shift+x"), "ctrl+shift+x");
  for (const key of ["m", "cmd+q", "alt+ctrl+m", "invalid"]) assert.throws(() => messagesStopKey(key), /PI_REX_MESSAGES_STOP_KEY/);
  for (const [key, expected] of [["off", ["ctrl+alt+b", "ctrl+alt+a"]],
    ["invalid", ["ctrl+alt+b", "ctrl+alt+a"]], ["ctrl+alt+b", ["ctrl+alt+b", "ctrl+alt+a"]],
    ["ctrl+alt+a", ["ctrl+alt+a", "ctrl+alt+b"]], ["alt+shift+m", ["alt+shift+m", "ctrl+alt+b", "ctrl+alt+a"]]]) {
    await t.test(key, async t => {
      const f = fixture(t, { PI_REX_MESSAGES_STOP_KEY: key });
      await f.events.get("session_start")({}, f.ctx);
      assert.deepEqual(f.shortcuts.map(s => s.key), expected);
      if (key !== "off" && key !== "invalid") assert.match(f.shortcuts[0].action.description, /Stop Rex result return/);
    });
  }
});
test("tool prose stays minimal without duplicate snippets or guidelines", async t => {
  const f = fixture(t);
  await f.events.get("session_start")({}, f.ctx);
  let total = 0;
  const descriptions = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "description" && typeof child === "string") total += child.length;
      else descriptions(child);
    }
  };
  for (const [name, tool] of f.tools) {
    assert.ok(tool.description.length <= 200, name + " description exceeds 200 characters");
    assert.equal(tool.promptSnippet, undefined, name + " duplicates its tool description");
    assert.equal(tool.promptGuidelines, undefined, name + " duplicates the shared rules");
    total += tool.description.length;
    descriptions(tool.parameters);
  }
  assert.ok(total <= 3000, "Tool and parameter prose exceeds 3000 characters: " + total);
});
test("every tool schema stays provider-portable: no draft tuple items or additionalItems", async t => {
  const f = fixture(t);
  await f.events.get("session_start")({}, f.ctx);
  assert.ok(f.tools.size >= 6);
  const walk = (value, path) => {
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, path + "[" + index + "]"));
    if (!value || typeof value !== "object") return;
    assert.equal(Array.isArray(value.items), false, path + ".items must be a schema object, not a tuple array");
    assert.equal(value.additionalItems, undefined, path + ".additionalItems is draft-7 tuple syntax");
    for (const [key, child] of Object.entries(value)) walk(child, path + "." + key);
  };
  for (const [name, tool] of f.tools) walk(tool.parameters, name);
  const bounds = f.tools.get("rex_open_terminal").parameters.properties.bounds;
  assert.equal(bounds.items.type, "number");
  assert.equal(bounds.minItems, 4);
  assert.equal(bounds.maxItems, 4);
});
