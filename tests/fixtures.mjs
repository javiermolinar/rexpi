import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rex } from "../lib/rex.ts";
import { BindingStore } from "../lib/store.ts";
import { Runtime } from "../lib/runtime.ts";
import { LEASE_MS } from "../lib/state.ts";

export const uuid = () => randomUUID();
export const rid = kind => kind + ":" + uuid();
export const server = { endpoint: "unix:///tmp/rex-test.sock", instanceId: uuid(), hostId: uuid() };
export function identity(role = "main") {
  return { taskId: uuid(), conversationId: uuid(), piSessionId: uuid(), role };
}
export function binding(who = identity(), overrides = {}) {
  return { version: 1, ...who, serverInstance: server.instanceId, hostId: server.hostId,
    blockId: rid("block"), token: uuid(), pid: process.pid, expiresAt: Date.now() + LEASE_MS, ...overrides };
}
export function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rexpi-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
export function world() {
  const w = { calls: [], server: { ...server }, blocks: new Map(), apps: [], created: [], failures: new Set(), processPids: new Map(),
    processData: new Map(), statuses: new Map(), titles: new Map(), windowLabels: new Map(), unreadable: new Set() };
  w.source = { sessionId: rid("session"), windowId: rid("window"), blockId: rid("block"), owner: rid("client") };
  w.next = { sessionId: rid("session"), windowId: rid("window"), blockId: rid("block") };
  w.sessionLabels = new Map([[w.source.sessionId, "Source"]]);
  w.callerBlock = w.source.blockId;
  w.blocks.set(w.source.blockId, w.source);
  w.apps.push({ client_id: w.source.owner, info: { kind: "app" } });
  w.selected = w.source;
  w.exec = async (_binary, args) => {
    w.calls.push(args);
    const json = value => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
    if (args.includes("whoami")) return json({ principal: { kind: w.remote ? "tailscale" : "peer", transport: w.remote ? "tcp" : "unix", uid: process.getuid() },
      endpoint: w.server.endpoint, instance_id: w.server.instanceId, host_id: w.server.hostId, block_id: w.callerBlock });
    if (args.includes("actions")) {
      w.onActions?.();
      return json([{ name: "session.select" }]);
    }
    if (args.includes("client") && args.includes("ls")) return json({ clients: w.apps });
    const api = args.indexOf("api");
    if (api >= 0) {
      const method = args[api + 2], input = JSON.parse(args[api + 3]);
      if (w.failures.has(method)) throw Error("simulated transport failure");
      if (method === "session.list") {
        w.onList?.();
        return json({ sessions: [...new Set([...w.blocks.values()].map(b => b.sessionId))].map(session_id => ({ session_id, label: w.sessionLabels.get(session_id) ?? "test" })) });
      }
      if (method === "session.view") {
        const blocks = [...w.blocks.values()].filter(b => b.sessionId === input.session_id);
        const windows = [...new Set(blocks.map(b => b.windowId))].map(window_id => ({
          window_id, label: w.windowLabels.get(window_id) ?? "Main", focused_block_id: w.selected.windowId === window_id ? w.selected.blockId : undefined,
          layers: [{ blocks: blocks.filter(b => b.windowId === window_id).map(b => ({
            block_id: b.blockId, label: b.label ?? "shell", host_id: b.hostId ?? w.server.hostId,
            creator_name: b.creator ?? "com.superlogical.terminal", owner: b.owner,
          })) }],
        }));
        return json({ session_id: input.session_id, label: w.sessionLabels.get(input.session_id), revision: 1, active_window_id: w.selected.windowId, windows });
      }
      if (method === "session.new_layer") {
        w.layerRequests ??= []; w.layerRequests.push(input); w.created.push(args);
        if (w.onCreate) await w.onCreate(args);
        if (w.failCreate) throw Error("lost floating creation reply");
        w.blocks.set(w.next.blockId, { sessionId: input.session_id, windowId: input.window_id, blockId: w.next.blockId });
        return json({ block_ids: [w.next.blockId], layer_id: rid("layer"), revision: 2 });
      }
      if (method === "session.focus_block") {
        w.selected = w.blocks.get(input.block_id);
        w.focusCalls = (w.focusCalls ?? 0) + 1;
        return json({ revision: 2 });
      }
      throw Error("Unhandled method " + method);
    }
    if (args.includes("block") && (args.includes("process") || args.includes("program_status") || args.includes("title"))) {
      const blockId = args[args.indexOf("-b") + 1], method = args.at(-1);
      await w.onTerminalData?.(blockId, method);
      if (w.unreadable.has(blockId + ":" + method)) throw Error("unreadable terminal");
      if (method === "program_status") return json(w.statuses.get(blockId) ?? { records: [] });
      if (method === "title") return json(w.titles.get(blockId) ?? { title: "" });
      return json(w.processData.get(blockId) ?? { foreground: { pid: w.processPids.get(blockId) ?? process.pid, name: "node", cwd: "/repo" }, child: null, ancestors: null, last_exit: null });
    }
    if (args.includes("do")) {
      w.selectCalls = (w.selectCalls ?? 0) + 1;
      w.onSelect?.();
      if (w.remoteControl === false) return { code: 1, stdout: "", stderr: "Error: Rex.app is not accepting actions. Turn on Remote Control in its Settings under Rex Server." };
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args.includes("new") || args.includes("split")) {
      w.created.push(args);
      if (w.onCreate) await w.onCreate(args);
      if (w.failCreate) throw Error("lost reply after possible creation");
      const isSession = args.includes("new") && !args.includes("window");
      const target = { ...w.next, sessionId: isSession ? w.next.sessionId : w.source.sessionId };
      w.blocks.set(target.blockId, target);
      if (isSession) w.sessionLabels.set(target.sessionId, args[args.indexOf("new") + 1]);
      return isSession ? json({ session_id: target.sessionId, initial_windows: [{ window_id: target.windowId, block_ids: [target.blockId] }] })
        : json({ window_id: args.includes("window") ? target.windowId : undefined, block_ids: [target.blockId] });
    }
    throw Error("Unhandled CLI args " + JSON.stringify(args));
  };
  return w;
}
export async function active(t, options = {}) {
  const root = sandbox(t), w = options.world ?? world();
  const store = new BindingStore(join(root, "bindings"));
  const rex = new Rex("/bin/echo", w.exec);
  const runtime = new Runtime(rex, store, w.source.blockId);
  const entries = options.entries ?? [];
  const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: {
    getSessionId: () => options.owner ?? "test-session", getBranch: () => entries,
  }, ui: { setStatus() {}, notify() {} } };
  t.after(() => runtime.stop());
  await runtime.start(ctx, state => entries.push({ type: "custom", customType: "pi-rex.orientation", data: state }), options.seed);
  return { root, w, store, rex, runtime, ctx, entries };
}
