import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import piRex, { returnKey } from "../extensions/index.ts";
import { sandbox, world, uuid, binding } from "./fixtures.mjs";
import { BindingStore } from "../lib/store.ts";
import { BOOTSTRAP_ENV, decodeBootstrap } from "../lib/state.ts";

function fixture(t, overrides = {}, settings = {}) {
  const root = sandbox(t), w = world(), events = new Map(), tools = new Map(), commands = new Map(), shortcuts = [], entries = [], notices = [];
  const changes = { REX_SESSION: w.source.sessionId, REX_BLOCK: w.source.blockId, PI_REX_CLI: "/bin/echo",
    PI_REX_STATE_DIR: join(root, "bindings"), PI_REX_BINARY: "/bin/echo", PI_REX_BOOTSTRAP: undefined, ...overrides };
  const old = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) value === undefined ? delete process.env[key] : process.env[key] = value;
  t.after(() => {
    events.get("session_shutdown")?.({}, ctx);
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  const ctx = { cwd: root, mode: "tui", hasUI: true,
    sessionManager: { getSessionId: () => "factory-session", getBranch: () => entries },
    ui: { setStatus() {}, notify: (...args) => notices.push(args) } };
  const pi = { on: (name, handler) => events.set(name, handler), exec: w.exec,
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
    registerShortcut: (key, action) => shortcuts.push({ key, action }),
    getSettings: () => settings,
    getCommands: () => [...commands.keys()].map(name => ({ name, source: "extension" })) };
  piRex(pi);
  return { root, w, events, tools, commands, shortcuts, entries, notices, ctx };
}
test("factory has no background IO; verified TUI startup registers the Pi tool", async t => {
  const f = fixture(t);
  assert.equal(f.w.calls.length, 0);
  assert.equal(f.tools.size, 0);
  await f.events.get("session_start")({}, f.ctx);
  assert.ok(f.tools.has("rex_start_pi"));
  assert.ok(f.tools.has("rex_open_terminal"));
  assert.ok(f.tools.has("rex_jump"));
  assert.ok(f.tools.has("rex_open_session"));
  assert.ok(f.tools.get("rex_start_pi").parameters.properties.sessionName);
  assert.equal(f.tools.get("rex_start_pi").executionMode, "sequential");
  assert.deepEqual([...f.commands.keys()].sort(), ["rxagents", "rxbk", "rxh", "rxn", "rxt", "rxv", "rxwho"]);
  assert.equal(f.shortcuts[0].key, "ctrl+alt+b");
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
test("session metadata is injected without copying history or starting a model turn", async t => {
  const f = fixture(t);
  await f.events.get("session_start")({}, f.ctx);
  const event = { systemPromptOptions: { sections: {} } };
  f.events.get("before_agent_start")(event, f.ctx);
  assert.match(event.systemPromptOptions.sections.pi_rex, /metadata, not permission/);
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
test("rex_jump opens a path in a fresh Pi tab without adding slash commands or needing zoxide", async t => {
  const f = fixture(t);
  await f.events.get("session_start")({}, f.ctx);
  const store = new BindingStore(join(f.root, "bindings"));
  f.w.onCreate = args => {
    const raw = args.find(arg => arg.startsWith(BOOTSTRAP_ENV + "="));
    store.write(binding(decodeBootstrap(raw.slice(raw.indexOf("=") + 1)), { blockId: f.w.next.blockId }));
  };
  const result = await f.tools.get("rex_jump").execute("project", { query: f.root, focus: false },
    new AbortController().signal, undefined, f.ctx);
  assert.equal(result.details.matchedBy, "path");
  assert.equal(result.details.launch.placement, "tab");
  assert.equal(result.details.launch.startup.state, "bound");
  assert.equal(f.w.created.length, 1);
  assert.deepEqual([...f.commands.keys()].sort(), ["rxagents", "rxbk", "rxh", "rxn", "rxt", "rxv", "rxwho"]);
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
test("return shortcut supports opt-out and rejects malformed modifier strings", () => {
  assert.equal(returnKey(), "ctrl+alt+b");
  assert.equal(returnKey("off"), undefined);
  assert.equal(returnKey("ctrl+shift+x"), "ctrl+shift+x");
  for (const key of ["b", "cmd+q", "ctrl+alt+cmd+b", "invalid", "alt+ctrl+b"]) assert.throws(() => returnKey(key));
});
