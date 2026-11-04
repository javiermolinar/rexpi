import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionOpener } from "../lib/sessions.ts";
import { SessionClaim, canonicalName, sessionName } from "../lib/session-name.ts";
import { Launcher } from "../lib/launch.ts";
import { BOOTSTRAP_ENV, decodeBootstrap } from "../lib/state.ts";
import { active, binding, rid } from "./fixtures.mjs";

const extension = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
function launcher(a) {
  return new Launcher(a.runtime, { extension, piBinary: "/bin/echo", agentDirectory: a.root,
    stateDirectory: a.store.directory, path: process.env.PATH, startupTimeoutMs: 30 });
}
function acknowledge(a, args) {
  const raw = args.find(arg => arg.startsWith(BOOTSTRAP_ENV + "="));
  a.store.write(binding(decodeBootstrap(raw.slice(raw.indexOf("=") + 1)), { blockId: a.w.next.blockId }));
}
function named(a, label, target = { sessionId: rid("session"), windowId: rid("window"), blockId: rid("block") }) {
  a.w.blocks.set(target.blockId, target); a.w.sessionLabels.set(target.sessionId, label);
  return target;
}
test("session names are exact display text with case-insensitive NFC lookup", () => {
  assert.equal(sessionName("  Tempo Workspace  "), "Tempo Workspace");
  assert.equal(canonicalName("TÉMPO"), canonicalName("TÉMPO"));
  for (const value of ["", " ", "-option", "line\nfeed", "x".repeat(121), 3]) assert.throws(() => sessionName(value));
});
test("existing named sessions are selected without directory lookup, Pi launch or input", async t => {
  const a = await active(t), target = named(a, "Tempo");
  const opener = new SessionOpener(a.runtime, launcher(a), async () => assert.fail("must not resolve creation query"));
  const result = await opener.open("existing", { sessionName: "tempo", query: "/missing/ignored", title: "ignored" }, a.root);
  assert.equal(result.outcome, "existing");
  assert.equal(result.session.sessionId, target.sessionId);
  assert.equal(result.session.name, "Tempo");
  assert.equal(a.w.selectCalls, 1);
  assert.equal(a.w.created.length, 0);
  assert.equal(a.w.calls.some(args => args.includes("send") || args.includes("send-key")), false);
});
test("existing background lookup requires no app or Remote Control", async t => {
  const a = await active(t); named(a, "Tempo");
  a.w.apps = []; a.w.remoteControl = false;
  const opener = new SessionOpener(a.runtime, launcher(a), async () => assert.fail("no lookup"));
  const result = await opener.open("background", { sessionName: "Tempo", focus: false }, a.root);
  assert.equal(result.focused, false);
  assert.equal(a.w.selectCalls ?? 0, 0);
  assert.equal(a.w.created.length, 0);
});
test("ambiguous labels fail without selection, lookup, rename or creation", async t => {
  const a = await active(t); named(a, "Tempo"); named(a, "TEMPO");
  const opener = new SessionOpener(a.runtime, launcher(a), async () => assert.fail("no lookup"));
  await assert.rejects(opener.open("duplicate", { sessionName: "tempo" }, a.root), /Multiple/);
  assert.equal(a.w.created.length, 0);
  assert.equal(a.w.selectCalls ?? 0, 0);
});
test("missing sessions require a creation directory and reject task injection", async t => {
  const a = await active(t);
  const opener = new SessionOpener(a.runtime, launcher(a), async () => assert.fail("no lookup"));
  await assert.rejects(opener.open("missing", { sessionName: "Tempo" }, a.root), /Supply query/);
  await assert.rejects(opener.open("task", { sessionName: "Tempo", prompt: "do work" }, a.root), /never receive prompts/);
  assert.equal(a.w.created.length, 0);
});
test("missing workspaces get an exact session name and an independent tab title; later opens reuse", async t => {
  const a = await active(t); let lookups = 0;
  a.w.onCreate = args => acknowledge(a, args);
  const opener = new SessionOpener(a.runtime, launcher(a), async () => { lookups++; return { directory: a.root, matchedBy: "path" }; });
  const created = await opener.open("create", { sessionName: "Tempo", query: a.root, title: "Main", focus: false }, a.root);
  assert.equal(created.outcome, "created");
  assert.equal(created.launch.startup.state, "bound");
  const args = a.w.created[0];
  assert.equal(args[args.indexOf("new") + 1], "Tempo");
  assert.equal(args[args.indexOf("--window") + 1], "Main");
  assert.equal(args.includes("Pi · Tempo"), false);
  assert.ok(args.includes("--keep-open"));
  const reused = await opener.open("reuse", { sessionName: "TEMPO", focus: false }, a.root);
  assert.equal(reused.outcome, "existing");
  assert.equal(reused.session.sessionId, created.launch.target.sessionId);
  assert.equal(lookups, 1);
  assert.equal(a.w.created.length, 1);
  assert.equal(readdirSync(a.store.directory).some(name => name.endsWith(".claim.json")), false);
});
test("workspace appearing during lookup is reused without creating", async t => {
  const a = await active(t);
  const opener = new SessionOpener(a.runtime, launcher(a), async () => {
    named(a, "Tempo"); return { directory: a.root, matchedBy: "path" };
  });
  assert.equal((await opener.open("appeared", { sessionName: "Tempo", query: a.root, focus: false }, a.root)).outcome, "existing");
  assert.equal(a.w.created.length, 0);
});
test("workspace appearing after reservation is reused and the preflight claim is released", async t => {
  const a = await active(t); let appeared = false;
  a.w.onList = () => {
    if (!appeared && readdirSync(a.store.directory).some(name => name.endsWith(".claim.json"))) {
      appeared = true; named(a, "Tempo");
    }
  };
  const opener = new SessionOpener(a.runtime, launcher(a), async () => ({ directory: a.root, matchedBy: "path" }));
  assert.equal((await opener.open("race", { sessionName: "Tempo", query: a.root, focus: false }, a.root)).outcome, "existing");
  assert.equal(a.w.created.length, 0);
  assert.equal(readdirSync(a.store.directory).some(name => name.endsWith(".claim.json")), false);
});
test("fresh launches never reuse or duplicate an existing named workspace", async t => {
  const a = await active(t); named(a, "Tempo");
  await assert.rejects(launcher(a).launch("fresh", { sessionName: "tempo", cwd: a.root, focus: false }, a.root), /rex_open_session/);
  await assert.rejects(launcher(a).launch("tab", { sessionName: "New", placement: "tab" }, a.root), /session placement/);
  await assert.rejects(launcher(a).launch("split", { sessionName: "New", related: true }, a.root), /session placement/);
  assert.equal(a.w.created.length, 0);
});
test("unknown named creation retains its reservation and cannot be automatically recreated", async t => {
  const a = await active(t); a.w.failCreate = true;
  const opener = new SessionOpener(a.runtime, launcher(a), async () => ({ directory: a.root, matchedBy: "path" }));
  const result = await opener.open("unknown", { sessionName: "Tempo", query: a.root, focus: false }, a.root);
  assert.equal(result.outcome, "unknown");
  assert.match(result.launch.startup.reason, /reservation retained/);
  const claims = readdirSync(a.store.directory).filter(name => name.endsWith(".claim.json"));
  assert.equal(claims.length, 1);
  await assert.rejects(opener.open("again", { sessionName: "Tempo", query: a.root, focus: false }, a.root), /in progress or uncertain/);
  assert.equal(a.w.created.length, 1);
});
test("concurrent cooperative creates cannot duplicate the same name", async t => {
  const a = await active(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const dispatched = new Promise(resolve => { entered = resolve; });
  a.w.onCreate = async args => { entered(); await gate; acknowledge(a, args); };
  const resolver = async () => ({ directory: a.root, matchedBy: "path" });
  const first = new SessionOpener(a.runtime, launcher(a), resolver).open("one", { sessionName: "Tempo", query: a.root, focus: false }, a.root);
  await dispatched;
  try {
    await assert.rejects(new SessionOpener(a.runtime, launcher(a), resolver).open("two", { sessionName: "TEMPO", query: a.root, focus: false }, a.root), /in progress or uncertain/);
  } finally { release(); await first; }
  assert.equal(a.w.created.length, 1);
});
test("reservations are private, are not stolen, and release only their own token", async t => {
  const a = await active(t), claim = new SessionClaim(a.store.directory, a.w.server.instanceId, "Tempo");
  assert.equal(statSync(claim.path).mode & 0o777, 0o600);
  assert.throws(() => new SessionClaim(a.store.directory, a.w.server.instanceId, "TEMPO"), /uncertain/);
  const metadata = JSON.parse(readFileSync(claim.path, "utf8"));
  writeFileSync(claim.path, JSON.stringify({ ...metadata, token: "changed", pid: 99999999 }));
  assert.equal(claim.release(), false);
  assert.equal(existsSync(claim.path), true);
  assert.throws(() => new SessionClaim(a.store.directory, a.w.server.instanceId, "Tempo"), /uncertain/);
});
test("rename or Remote Control denial never turns reuse into creation", async t => {
  const a = await active(t), target = named(a, "Tempo");
  const opener = new SessionOpener(a.runtime, launcher(a), async () => assert.fail("no lookup"));
  a.w.remoteControl = false;
  await assert.rejects(opener.open("denied", { sessionName: "Tempo" }, a.root), /Remote Control/);
  a.w.remoteControl = true; a.w.onActions = () => a.w.sessionLabels.set(target.sessionId, "Other");
  await assert.rejects(opener.open("renamed", { sessionName: "Tempo" }, a.root), /changed before selection/);
  assert.equal(a.w.created.length, 0);
});
test("repeated reuse IDs do not repeat app actions", async t => {
  const a = await active(t); named(a, "Tempo");
  const opener = new SessionOpener(a.runtime, launcher(a), async () => assert.fail("no lookup"));
  const first = opener.open("same", { sessionName: "Tempo" }, a.root);
  assert.equal(opener.open("same", { sessionName: "Tempo" }, a.root), first);
  await first;
  assert.equal(a.w.selectCalls, 1);
});
