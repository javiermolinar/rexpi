import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityPathToolDefinitions } from "../lib/capability-paths.ts";
import { CapabilityRuntime } from "../lib/capability-runtime.ts";
import { registerPeerTools } from "../extensions/peer.ts";

const pathFs = {
  realpath: path => fs.realpath(path), lstat: path => fs.lstat(path), stat: path => fs.stat(path),
  open: (path, flags, mode) => fs.open(path, flags, mode),
  mkdir: async (path, options) => { await fs.mkdir(path, options); },
  unlink: path => fs.unlink(path), rmdir: path => fs.rmdir(path),
};
function pathRuntime(root, change = {}) {
  const value = { tools: ["read", "write", "edit"], readPaths: [root], writePaths: [root],
    revoked: false, calls: [], ...change };
  return {
    ...value,
    allowsTool(name) { return this.tools.includes(name); },
    pathGrants() { return { readPaths: [...this.readPaths], writePaths: [...this.writePaths] }; },
    guardTool(name, input) {
      this.calls.push({ name, input });
      return this.revoked ? { block: true, reason: "Capability grant was revoked" } : undefined;
    },
    revoke() { this.revoked = true; },
  };
}
async function sandbox(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "rexpi-capability-paths-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function tools(root, runtime = pathRuntime(root), injectedFs = pathFs) {
  const definitions = capabilityPathToolDefinitions(root, runtime, { fs: injectedFs });
  return { runtime, definitions, tools: new Map(definitions.map(tool => [tool.name, tool])) };
}
const execute = (tool, params) => tool.execute("call", params, undefined, undefined);
async function symlink(t, target, path, type) {
  try { await fs.symlink(target, path, type); return true; }
  catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "EOPNOTSUPP"].includes(error.code)) { t.skip("symlinks unavailable"); return false; }
    throw error;
  }
}
async function hardlink(t, target, path) {
  try { await fs.link(target, path); return true; }
  catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "EOPNOTSUPP", "EXDEV"].includes(error.code)) { t.skip("hardlinks unavailable"); return false; }
    throw error;
  }
}

test("whitelisted built-ins alone are replaced and retain Pi schemas", async t => {
  const root = await sandbox(t), runtime = pathRuntime(root, { tools: ["read", "edit", "custom"] });
  const { tools: map } = await tools(root, runtime);
  assert.deepEqual([...map.keys()].sort(), ["edit", "read"]);
  for (const name of map.keys()) {
    assert.equal(map.get(name).name, name);
    assert.ok(map.get(name).parameters.properties.path);
    assert.equal(map.get(name).description.length > 0, true);
  }
  const none = pathRuntime(root, { tools: [], readPaths: [], writePaths: [] });
  assert.deepEqual(capabilityPathToolDefinitions(root, none), []);
});

test("exact files, descendants, new files, and absent parents are allowed", async t => {
  const root = await sandbox(t), exact = join(root, "exact.txt");
  await fs.writeFile(exact, "before");
  const runtime = pathRuntime(root, { readPaths: [exact, root], writePaths: [exact, root] });
  const { tools: map } = await tools(root, runtime);
  const read = await execute(map.get("read"), { path: exact });
  assert.match(read.content[0].text, /before/);
  await execute(map.get("write"), { path: exact, content: "after" });
  assert.equal(await fs.readFile(exact, "utf8"), "after");
  await execute(map.get("write"), { path: "new/deep/file.txt", content: "created" });
  assert.equal(await fs.readFile(join(root, "new/deep/file.txt"), "utf8"), "created");
  const descendant = await execute(map.get("read"), { path: "new/deep/file.txt" });
  assert.match(descendant.content[0].text, /created/);
});

test("image detection uses the same verified read buffer", async t => {
  const root = await sandbox(t), target = join(root, "pixel.png");
  await fs.writeFile(target, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  let opens = 0;
  const injected = { ...pathFs, open: async (path, flags, mode) => { opens++; return fs.open(path, flags, mode); } };
  const { tools: map } = await tools(root, pathRuntime(root), injected);
  const result = await execute(map.get("read"), { path: "pixel.png" });
  assert.equal(result.structuredContent.type, "image");
  assert.equal(result.structuredContent.mimeType, "image/png");
  assert.equal(opens, 1);
});

test("traversal, absolute escapes, prefix confusion, and outside root aliases deny without effects", async t => {
  const parent = await sandbox(t), root = join(parent, "grant"), prefix = join(parent, "grant-other");
  await fs.mkdir(root); await fs.mkdir(prefix);
  await fs.writeFile(join(root, "inside"), "inside"); await fs.writeFile(join(prefix, "outside"), "outside");
  const alias = join(parent, "alias");
  if (!await symlink(t, root, alias, "dir")) return;
  const runtime = pathRuntime(root), { tools: map } = await tools(root, runtime);
  const denied = [
    ["read", { path: "../grant-other/outside" }],
    ["read", { path: join(prefix, "outside") }],
    ["read", { path: join(alias, "inside") }],
    ["read", { path: "sub/../../grant-other/outside" }],
    ["write", { path: "../escape/new/file", content: "no" }],
    ["write", { path: join(prefix, "new"), content: "no" }],
  ];
  for (const [name, params] of denied) await assert.rejects(execute(map.get(name), params), /Capability path denied/);
  assert.equal(existsSync(join(parent, "escape")), false);
  assert.equal(existsSync(join(prefix, "new")), false);
  assert.equal(await fs.readFile(join(prefix, "outside"), "utf8"), "outside");
});

test("intermediate escapes, final symlinks, and symlinked new-file ancestors deny", async t => {
  const parent = await sandbox(t), root = join(parent, "grant"), outside = join(parent, "outside");
  await fs.mkdir(root); await fs.mkdir(outside); await fs.writeFile(join(outside, "secret"), "secret");
  await fs.writeFile(join(root, "target"), "target");
  if (!await symlink(t, outside, join(root, "escape"), "dir")) return;
  if (!await symlink(t, join(root, "target"), join(root, "final"), "file")) return;
  const { tools: map } = await tools(root, pathRuntime(root));
  await assert.rejects(execute(map.get("read"), { path: "escape/secret" }), /Capability path denied/);
  await assert.rejects(execute(map.get("read"), { path: "final" }), /Capability path denied/);
  await assert.rejects(execute(map.get("write"), { path: "escape/new/file", content: "no" }), /Capability path denied/);
  assert.equal(existsSync(join(outside, "new")), false);
  assert.equal(await fs.readFile(join(root, "target"), "utf8"), "target");
});

test("target replacement after open denies before descriptor read or write", async t => {
  for (const operation of ["read", "write"]) await t.test(operation, async t => {
    const root = await sandbox(t), target = join(root, "target"), moved = join(root, "moved");
    await fs.writeFile(target, "original");
    let replaced = false;
    const injected = { ...pathFs, open: async (path, flags, mode) => {
      const handle = await fs.open(path, flags, mode);
      if (path === target && !replaced) {
        replaced = true;
        await fs.rename(target, moved); await fs.writeFile(target, "replacement");
      }
      return handle;
    } };
    const { tools: map } = await tools(root, pathRuntime(root), injected);
    const params = operation === "read" ? { path: "target" } : { path: "target", content: "changed" };
    await assert.rejects(execute(map.get(operation), params), /replaced between authorization and open/);
    assert.equal(replaced, true);
    assert.equal(await fs.readFile(target, "utf8"), "replacement");
    assert.equal(await fs.readFile(moved, "utf8"), "original");
  });
});

test("grant-root replacement after target open denies before I/O", async t => {
  for (const operation of ["read", "write"]) await t.test(operation, async t => {
    const parent = await sandbox(t), root = join(parent, "grant"), moved = join(parent, "moved"), target = join(root, "target");
    await fs.mkdir(root); await fs.writeFile(target, "original");
    let replaced = false;
    const injected = { ...pathFs, open: async (path, flags, mode) => {
      const handle = await fs.open(path, flags, mode);
      if (path === target && !replaced) {
        replaced = true; await fs.rename(root, moved); await fs.symlink(moved, root, "dir");
      }
      return handle;
    } };
    const { tools: map } = await tools(root, pathRuntime(root), injected);
    const params = operation === "read" ? { path: "target" } : { path: "target", content: "changed" };
    await assert.rejects(execute(map.get(operation), params), /grant root/);
    assert.equal(replaced, true);
    assert.equal(await fs.readFile(join(moved, "target"), "utf8"), "original");
  });
});

test("edit target replacement after its read denies before truncation", async t => {
  const root = await sandbox(t), target = join(root, "target"), moved = join(root, "moved");
  await fs.writeFile(target, "original-long-suffix");
  let replaced = false;
  const injected = { ...pathFs, open: async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode), readFile = handle.readFile.bind(handle);
    if (path === target) handle.readFile = async (...args) => {
      const content = await readFile(...args);
      if (!replaced) {
        replaced = true; await fs.rename(target, moved); await fs.writeFile(target, "replacement");
      }
      return content;
    };
    return handle;
  } };
  const { tools: map } = await tools(root, pathRuntime(root), injected);
  await assert.rejects(execute(map.get("edit"), { path: "target", edits: [{ oldText: "original-long-suffix", newText: "x" }] }),
    /replaced between authorization and open/);
  assert.equal(await fs.readFile(target, "utf8"), "replacement");
  assert.equal(await fs.readFile(moved, "utf8"), "original-long-suffix");
});

test("existing hardlink writes and edits deny and leave both aliases unchanged", async t => {
  const parent = await sandbox(t), root = join(parent, "grant"), target = join(root, "target"), alias = join(parent, "alias");
  await fs.mkdir(root); await fs.writeFile(target, "original");
  if (!await hardlink(t, target, alias)) return;
  const { tools: map } = await tools(root, pathRuntime(root));
  await assert.rejects(execute(map.get("write"), { path: "target", content: "changed" }), /hardlinked/);
  await assert.rejects(execute(map.get("edit"), { path: "target", edits: [{ oldText: "original", newText: "changed" }] }), /hardlinked/);
  assert.equal(await fs.readFile(target, "utf8"), "original");
  assert.equal(await fs.readFile(alias, "utf8"), "original");
});

test("a post-creation denial preserves created paths and reports incomplete cleanup", async t => {
  const root = await sandbox(t), target = join(root, "new/deep/file");
  let fail = false;
  const injected = { ...pathFs, realpath: async path => {
    if (path === target && fail) throw new Error("injected post-create replacement fence");
    return fs.realpath(path);
  }, open: async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode);
    if (path === target) fail = true;
    return handle;
  } };
  const { tools: map } = await tools(root, pathRuntime(root), injected);
  await assert.rejects(execute(map.get("write"), { path: "new/deep/file", content: "no effects" }), /cleanup was incomplete/);
  assert.equal(await fs.readFile(target, "utf8"), "");
  assert.equal(existsSync(join(root, "new/deep")), true);
});

test("known-identity creation failures never delete a later replacement", async t => {
  const root = await sandbox(t), target = join(root, "file"), moved = join(root, "original");
  let replace = false;
  const injected = { ...pathFs, realpath: async path => {
    if (path === target && replace) {
      await fs.rename(target, moved);
      await fs.writeFile(target, "post-check replacement");
      throw new Error("forced post-open failure");
    }
    return fs.realpath(path);
  }, open: async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode);
    if (path === target) replace = true;
    return handle;
  } };
  const { tools: map } = await tools(root, pathRuntime(root), injected);
  await assert.rejects(execute(map.get("write"), { path: "file", content: "new" }), /cleanup was incomplete/);
  assert.equal(await fs.readFile(target, "utf8"), "post-check replacement");
  assert.equal(existsSync(moved), true);
});

test("unknown new-file identity preserves replacements and reports incomplete cleanup", async t => {
  const root = await sandbox(t), target = join(root, "new/deep/file"), moved = join(root, "moved-original");
  const injected = { ...pathFs, open: async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode);
    if (path === target) {
      await fs.rename(target, moved);
      await fs.writeFile(target, "external replacement");
      handle.stat = async () => { throw new Error("injected post-create stat failure"); };
    }
    return handle;
  } };
  const { tools: map } = await tools(root, pathRuntime(root), injected);
  await assert.rejects(execute(map.get("write"), { path: "new/deep/file", content: "no effects" }), /cleanup was incomplete/);
  assert.equal(await fs.readFile(target, "utf8"), "external replacement");
  assert.equal(existsSync(moved), true, "unknown original is preserved rather than retargeted");
});

test("unknown parent identity preserves replacement directories and reports incomplete cleanup", async t => {
  const root = await sandbox(t), deep = join(root, "new/deep"), moved = join(root, "moved-deep");
  let fail = false;
  const injected = { ...pathFs,
    mkdir: async (path, options) => { await fs.mkdir(path, options); if (path === deep) fail = true; },
    lstat: async path => {
      if (path === deep && fail) {
        fail = false;
        await fs.rename(deep, moved);
        await fs.mkdir(deep);
        await fs.writeFile(join(deep, "owned"), "external replacement");
        throw new Error("injected post-mkdir lstat failure");
      }
      return fs.lstat(path);
    } };
  const { tools: map } = await tools(root, pathRuntime(root), injected);
  await assert.rejects(execute(map.get("write"), { path: "new/deep/file", content: "no effects" }), /cleanup was incomplete/);
  assert.equal(await fs.readFile(join(deep, "owned"), "utf8"), "external replacement");
  assert.equal(existsSync(moved), true);
});

test("edit uses one descriptor, requires both grants, and truncates old suffixes", async t => {
  const root = await sandbox(t), target = join(root, "target");
  await fs.writeFile(target, "prefix-old-long-suffix");
  let opens = 0;
  const injected = { ...pathFs, open: async (path, flags, mode) => { opens++; return fs.open(path, flags, mode); } };
  const { tools: map, runtime } = await tools(root, pathRuntime(root), injected);
  await execute(map.get("edit"), { path: "target", edits: [{ oldText: "prefix-old-long-suffix", newText: "x" }] });
  assert.equal(await fs.readFile(target, "utf8"), "x");
  assert.equal(opens, 1);
  assert.equal(runtime.calls.filter(call => call.name === "read").length, 0,
    "edit does not require separate read tool whitelist authority");

  const writeOnly = pathRuntime(root, { tools: ["edit"], readPaths: [], writePaths: [root] });
  const restricted = await tools(root, writeOnly);
  await assert.rejects(execute(restricted.tools.get("edit"), { path: "target", edits: [{ oldText: "x", newText: "y" }] }),
    /exact granted file/);
  assert.equal(await fs.readFile(target, "utf8"), "x");
});

test("direct and nested execution share the gate, and stale revocation wins without effects", async t => {
  const root = await sandbox(t), runtime = pathRuntime(root), { tools: map } = await tools(root, runtime);
  assert.equal(runtime.guardTool("read", { nested: true }), undefined);
  const nested = await execute(map.get("write"), { path: "nested/file", content: "ok", nested: { toolName: "write" } });
  assert.ok(nested.content);
  runtime.revoke();
  assert.equal(runtime.guardTool("write", {}).block, true);
  await assert.rejects(execute(map.get("write"), { path: "stale/file", content: "no" }), /revoked/);
  assert.equal(existsSync(join(root, "stale")), false);
  assert.equal(await fs.readFile(join(root, "nested/file"), "utf8"), "ok");
});

test("peer reads keep exact tool and related-target fences, never a filesystem path mapping", async t => {
  const related = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const grant = change => ({ tools: ["rex_read_conversation"], readPaths: ["/not/a/filesystem/route"], writePaths: [],
    delegation: { maxDepth: 0 }, returnResults: false, turns: 2, timeoutMs: 10_000, ...change });
  const capability = new CapabilityRuntime(grant()); t.after(() => capability.revoke());
  const registered = new Map(), calls = [];
  const pi = { registerTool: definition => registered.set(definition.name, definition) };
  const filtered = Object.create(pi);
  filtered.registerTool = definition => { if (capability.allowsTool(definition.name)) pi.registerTool(definition); };
  const runtime = { snapshot: () => ({ state: { piSessionId: "session" } }) };
  const peer = { read: async (target, input) => {
    if (!/^[0-9a-f-]{36}$/.test(target)) throw new Error("Invalid target conversation ID");
    if (target !== related) throw new Error("Target conversation is not uniquely live in this related task");
    calls.push({ target, input });
    return { target: { conversationId: related }, view: input.view ?? "branch", entries: [{ text: "peer" }] };
  } };
  registerPeerTools(filtered, () => ({ runtime, peer }));
  const tool = registered.get("rex_read_conversation");
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["cursor", "direction", "limit", "since", "target", "textOnly", "types", "view"]);
  assert.equal(tool.parameters.properties.path, undefined);
  assert.equal(capability.guardTool("rex_read_conversation", { target: related }), undefined);
  const result = await tool.execute("peer", { target: related }, undefined, undefined,
    { sessionManager: { getSessionId: () => "session" } });
  assert.equal(result.details.entries[0].text, "peer");
  await assert.rejects(tool.execute("other", { target: other }, undefined, undefined,
    { sessionManager: { getSessionId: () => "session" } }), /related task/);
  await assert.rejects(tool.execute("file", { target: "/etc/passwd", path: "/etc/passwd" }, undefined, undefined,
    { sessionManager: { getSessionId: () => "session" } }), /Invalid target conversation ID/);
  assert.equal(calls.length, 1, "peer reads expose no caller-selected filesystem read");

  const deniedCapability = new CapabilityRuntime(grant({ tools: [] })); t.after(() => deniedCapability.revoke());
  assert.equal(deniedCapability.guardTool("rex_read_conversation", { target: related }).block, true);
  const deniedTools = new Map(), deniedPi = { registerTool: definition => deniedTools.set(definition.name, definition) };
  const deniedFiltered = Object.create(deniedPi);
  deniedFiltered.registerTool = definition => { if (deniedCapability.allowsTool(definition.name)) deniedPi.registerTool(definition); };
  registerPeerTools(deniedFiltered, () => ({ runtime, peer }));
  assert.equal(deniedTools.has("rex_read_conversation"), false);
});
