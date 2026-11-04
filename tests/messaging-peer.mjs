// Node IPC fixture only: not a Pi CLI/model/native Rex process.
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { Rex } from "../lib/rex.ts";
import { Runtime } from "../lib/runtime.ts";
import { BindingStore } from "../lib/store.ts";
import { MessagingRuntime } from "../lib/messaging/runtime.ts";
import { FileMailbox } from "../lib/messaging/file-transport.ts";
import { endpointFromBinding } from "../lib/messaging/protocol.ts";
import { ReceiptLedger, FOLLOWUP_INTENT } from "../lib/messaging/receipts.ts";
import { world, rid, uuid } from "./fixtures.mjs";

globalThis.fetch = () => { throw Error("Network forbidden in messaging fixture"); };
let f;
process.on("message", async message => {
  const { id, op } = message;
  try {
    let value;
    if (op === "init") {
      const c = message.config, w = world(); w.server = { ...c.server };
      w.source.blockId = c.blockId ?? rid("block"); w.callerBlock = w.source.blockId;
      w.blocks.clear(); w.blocks.set(w.source.blockId, w.source);
      for (const peer of c.peers ?? []) {
        w.blocks.set(peer.blockId, { sessionId: w.source.sessionId, windowId: rid("window"), blockId: peer.blockId });
        w.processPids.set(peer.blockId, peer.pid);
      }
      mkdirSync(join(c.root, "sessions"), { recursive: true, mode: 0o700 });
      const sm = c.sessionFile ? SessionManager.open(c.sessionFile)
        : SessionManager.create(c.root, join(c.root, "sessions"), { id: c.sessionId ?? uuid() });
      if (!c.sessionFile) sm.appendMessage({ role: "user", content: "authorized test delegation", timestamp: Date.now() });
      const store = new BindingStore(join(c.root, "bindings"));
      const rex = new Rex("/fixture-must-not-execute-rex", w.exec);
      const runtime = new Runtime(rex, store, w.source.blockId);
      const ctx = { mode: "tui", cwd: c.root, hasUI: true, sessionManager: sm,
        isIdle: () => true, hasPendingMessages: () => false,
        ui: { setStatus() {}, notify() {}, getEditorText: () => "" } };
      await runtime.start(ctx, state => sm.appendCustomEntry("pi-rex.orientation", state), c.seed);
      const own = runtime.snapshot(), owner = endpointFromBinding(store.find(own.state, own.server));
      let crash;
      const pi = {
        appendEntry(type, data) { sm.appendCustomEntry(type, data); if (type === FOLLOWUP_INTENT && crash === "intent") process.exit(71); },
        sendMessage(message, options) {
          if (crash === "enqueue-before") process.exit(72);
          sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
          if (crash === "enqueue-after") process.exit(73);
          process.send({ event: "enqueue", message, options });
        },
      };
      const m = new MessagingRuntime(pi, runtime, c.root, {
        setTimer: () => ({ unref() {} }), clearTimer() {},
        mailbox: recipient => new FileMailbox(c.root, recipient, store, own.server, {
          ...(c.limits ? { limits: c.limits } : {}),
          checkpoint(phase) {
            if (crash === phase) process.exit(70);
          },
        }),
      });
      m.attach(ctx);
      f = { c, w, sm, store, runtime, own, owner, m, tickets: new Map(), setCrash: v => { crash = v; } };
      value = { endpoint: owner, state: own.state, sessionFile: sm.getSessionFile(), branch: sm.getBranch() };
    } else if (op === "send") value = await f.m.send(message.params);
    else if (op === "crash") { f.setCrash(message.phase); value = true; }
    else if (op === "prepare") { const ticket = await f.m.prepareReturn(); f.tickets.set(ticket.requestId, ticket); value = ticket; }
    else if (op === "register") {
      const peer = message.endpoint;
      f.w.blocks.set(peer.blockId, { sessionId: f.w.source.sessionId, windowId: rid("window"), blockId: peer.blockId });
      f.w.processPids.set(peer.blockId, peer.pid);
      await f.m.registerReturn(f.tickets.get(message.requestId), peer); await f.m.poll(); value = true;
    } else if (op === "poll") { await f.m.poll(); value = f.m.snapshot(); }
    else if (op === "enable") { f.m.enable(); await f.m.poll(); value = f.m.snapshot(); }
    else if (op === "inspect") value = { snapshot: f.m.snapshot(), entries: f.sm.getEntries(),
      status: message.envelope ? new ReceiptLedger(f.owner, f.sm, () => {}).inspect(message.envelope) : undefined };
    else if (op === "branch") { f.sm.branch(message.entryId); value = true; }
    else if (op === "disk") value = readFileSync(f.sm.getSessionFile(), "utf8");
    else if (op === "stop") { f.m.detach(); f.runtime.stop(); value = true; }
    else throw Error("Unknown fixture operation");
    process.send({ id, value });
  } catch (error) { process.send({ id, error: error.message, code: error.code }); }
});
