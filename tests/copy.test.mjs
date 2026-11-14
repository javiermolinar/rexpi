import test from "node:test";
import assert from "node:assert/strict";
import { MessageCopyRuntime, latestRexpiMessageText } from "../lib/copy.ts";
import { FOLLOWUP_CONTEXT } from "../lib/messaging/receipts.ts";
import { PEER_MESSAGE_TYPE } from "../lib/peer.ts";

const assistant = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "LLM response" }] } };
const rexpiMessage = (text = "Rexpi result", customType = PEER_MESSAGE_TYPE) => ({
  type: "custom_message", customType, display: true, content: text,
});

function fixture(entries, copy = async () => {}) {
  let editor = "/copy", handler, unsubscribed = 0;
  const notices = [];
  const ctx = {
    sessionManager: { getBranch: () => entries },
    ui: {
      onTerminalInput: callback => { handler = callback; return () => { unsubscribed++; handler = undefined; }; },
      getEditorText: () => editor,
      setEditorText: value => { editor = value; },
      notify: (...args) => notices.push(args),
    },
  };
  const runtime = new MessageCopyRuntime(copy);
  runtime.attach(ctx);
  return { runtime, ctx, notices, submit: data => handler?.(data), get editor() { return editor; },
    setEditor: value => { editor = value; }, get unsubscribed() { return unsubscribed; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("/copy copies a trailing Rexpi message instead of the preceding assistant response", async () => {
  const copied = [];
  const f = fixture([assistant, rexpiMessage("Rexpi result\nwith details")], async text => { copied.push(text); });
  assert.deepEqual(f.submit("\r"), { consume: true });
  await settle();
  assert.deepEqual(copied, ["Rexpi result\nwith details"]);
  assert.equal(f.editor, "");
  assert.deepEqual(f.notices, [["Copied last Rexpi message to clipboard", "info"]]);
  f.runtime.detach();
  assert.equal(f.unsubscribed, 1);
  assert.equal(f.submit("\r"), undefined);
});

test("copy interception supports text blocks and ignores non-message state entries", async () => {
  const copied = [];
  const entries = [assistant, {
    type: "custom_message", customType: FOLLOWUP_CONTEXT, display: true,
    content: [{ type: "text", text: " first " }, { type: "image", data: "ignored" }, { type: "text", text: "second " }],
  }, { type: "custom", customType: "pi-rex.orientation", data: {} }];
  const f = fixture(entries, async text => { copied.push(text); });
  assert.deepEqual(f.submit("\n"), { consume: true });
  await settle();
  assert.deepEqual(copied, ["first second"]);
});

test("all other input and latest-message types retain Pi's built-in /copy behavior", async t => {
  const cases = [
    ["assistant is latest", [assistant]],
    ["another extension's custom message is latest", [assistant, rexpiMessage("other", "other.message")]],
    ["hidden Rexpi message is latest", [assistant, { ...rexpiMessage(), display: false }]],
    ["Rexpi message has no text", [assistant, rexpiMessage([{ type: "image", data: "x" }])]],
  ];
  for (const [name, entries] of cases) await t.test(name, () => {
    const f = fixture(entries, async () => { assert.fail("unexpected clipboard write"); });
    assert.equal(f.submit("\r"), undefined);
    assert.equal(f.editor, "/copy");
    f.runtime.detach();
  });
  const f = fixture([assistant, rexpiMessage()], async () => { assert.fail("unexpected clipboard write"); });
  assert.equal(f.submit("x"), undefined);
  assert.equal(f.submit("\x1b[13;2u"), undefined);
  f.runtime.detach();
});

test("non-/copy editor text is never consumed", () => {
  const f = fixture([assistant, rexpiMessage()], async () => { assert.fail("unexpected clipboard write"); });
  f.setEditor("/copy now");
  assert.equal(f.submit("\r"), undefined);
  assert.equal(f.editor, "/copy now");
  f.runtime.detach();
});

test("clipboard errors are reported without throwing from terminal input", async () => {
  const f = fixture([assistant, rexpiMessage()], async () => { throw new Error("clipboard unavailable"); });
  assert.deepEqual(f.submit("\r"), { consume: true });
  await settle();
  assert.deepEqual(f.notices, [["clipboard unavailable", "error"]]);
  f.runtime.detach();
});

test("detachment suppresses stale completion notices and replacement removes the old listener", async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture([assistant, rexpiMessage()], () => pending);
  f.submit("\r");
  f.runtime.detach();
  finish(); await settle();
  assert.deepEqual(f.notices, []);

  f.runtime.attach(f.ctx);
  assert.equal(f.unsubscribed, 1, "replacement unsubscribes the previous raw-input listener");
  f.runtime.detach();
  assert.equal(f.unsubscribed, 2);
});

test("latestRexpiMessageText returns undefined for an empty history", () => {
  assert.equal(latestRexpiMessageText([]), undefined);
});
