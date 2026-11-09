import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { LayoutOpener } from "../lib/layout-open.ts";
import { builtInLayout } from "../lib/layouts.ts";
const rid = (kind, n) => `${kind}:00000000-0000-0000-0000-${String(n).padStart(12,"0")}`;
const cwd = realpathSync(tmpdir());
function harness(options = {}) {
  const controller = new AbortController(), calls = [], pi = rid("block",1), unrelated = rid("block",2);
  const session = rid("session",1), oldWindow = rid("window",1), newWindow = rid("window",2);
  const own = { blockId: pi, signal: controller.signal, state: { piSessionId: "same-session" } };
  const locations = new Map([[pi,oldWindow],[unrelated,oldWindow]]);
  let tree, active = oldWindow, focused = pi, next = 10, assertions = 0;
  function view() {
    return { active_window_id: active, windows: [oldWindow,newWindow].filter(w => [...locations.values()].includes(w)).map(w => ({
      window_id: w, focused_block_id: focused, layers: [{ kind:"tiled",
        layout: w === newWindow ? tree : { block_id: pi },
        blocks: [...locations].filter(([,window]) => window === w).map(([block_id]) => ({ block_id })) }],
    })) };
  }
  function replace(node, a, b) {
    if (node.block_id) { if (node.block_id === a) node.block_id = b; return; }
    replace(node.split.before,a,b); replace(node.split.after,a,b);
  }
  const runtime = {
    snapshot() { return own; },
    assert(value) { assertions++; if(value !== own) throw Error("wrong snapshot"); controller.signal.throwIfAborted(); },
    async source() { this.assert(own); return { sessionId:session,windowId:locations.get(pi),blockId:pi }; },
    rex: {
      async view() { return view(); },
      async locate(blockId) { if(!locations.has(blockId)) throw Error("missing"); return {sessionId:session,windowId:locations.get(blockId),blockId}; },
      async api(method,args) {
        calls.push([method,args]);
        if(options.fail === method && !options.afterEffect) throw Error("lost reply");
        let result = {revision:1};
        if(method === "session.new_window") {
          const ids = [];
          function make(node) {
            if(node.block) { const block_id = rid("block",next++); ids.push(block_id); locations.set(block_id,newWindow); return {block_id}; }
            return {split:{...node.split,before:make(node.split.before),after:make(node.split.after)}};
          }
          tree = make(args.layout);
          result = {window_id:newWindow,block_ids:ids};
        } else if(method === "session.swap_blocks") {
          const a=locations.get(args.block_id), b=locations.get(args.other_block_id);
          locations.set(args.block_id,b); locations.set(args.other_block_id,a);
          replace(tree,args.other_block_id,args.block_id);
        } else if(method === "block.close") { locations.delete(args.block_id); result={block_id:args.block_id}; }
        else if(method === "session.focus_block") { focused=args.block_id; active=locations.get(focused); }
        if(options.cancel === method) controller.abort();
        if(options.fail === method) throw Error("lost reply after effect");
        return result;
      },
    },
  };
  const opener = new LayoutOpener(runtime,process.env.PATH,"/bin/sh");
  const builtin = builtInLayout("observe");
  builtin.root.after.command=["/bin/cat"];
  const spec={version:1,root:builtin.root};
  return {runtime,opener,calls,pi,unrelated,locations,oldWindow,newWindow,spec,controller,own};
}
test("opening materializes exact tree, swaps the same Pi, and closes only its placeholder", async () => {
  const h=harness(), result=await h.opener.open("one","ops",h.spec,cwd);
  assert.equal(result.state,"confirmed"); assert.equal(result.piMove,"confirmed");
  assert.equal(result.currentPiBlockId,h.pi); assert.equal(result.placeholderClosed,true);
  assert.equal(h.locations.get(h.pi),h.newWindow); assert.equal(h.locations.get(h.unrelated),h.oldWindow);
  assert.deepEqual(h.calls.map(([m])=>m),["session.new_window","session.swap_blocks","block.close","session.focus_block"]);
  const layout=h.calls[0][1].layout;
  assert.equal(layout.split.ratio,0.5); assert.equal(layout.split.before.split.ratio,0.65);
  assert.deepEqual(layout.split.before.split.before.block.options.command,["/bin/cat"]);
  assert.equal(layout.split.after.block.options.cwd,cwd);
  assert.ok(!JSON.stringify(layout).includes('"pi"'));
  const repeated=await h.opener.open("one","ops",h.spec,cwd);
  assert.equal(repeated,result); assert.equal(h.calls.length,4);
});
test("all built-ins open shells with empty PATH and preserve current Pi", async () => {
  for (const name of ["build", "inspect", "observe"]) {
    const h = harness(), layout = builtInLayout(name);
    const opener = new LayoutOpener(h.runtime, "", "/bin/sh");
    const result = await opener.open(name, name, { version: layout.version, root: layout.root }, cwd);
    assert.equal(result.state, "confirmed"); assert.equal(result.piMove, "confirmed");
    assert.equal(h.locations.get(h.pi), h.newWindow);
    assert.equal(h.locations.get(h.unrelated), h.oldWindow);
    const root = h.calls[0][1].layout;
    assert.equal(root.split.ratio, 0.5);
    if (name === "build") assert.equal(root.split.after.split.ratio, 0.65);
    if (name === "observe") assert.equal(root.split.before.split.ratio, 0.65);
    const terminals = node => node.block ? [node.block] : [...terminals(node.split.before), ...terminals(node.split.after)];
    const blocks = terminals(root);
    assert.equal(blocks.length, name === "inspect" ? 2 : 3);
    for (const block of blocks) {
      assert.equal(block.options.cwd, cwd);
      assert.deepEqual(block.options.command, block.label === "Rexpi layout placeholder"
        ? ["/bin/cat"] : ["/usr/bin/env", "PATH=", realpathSync("/bin/sh"), "-l"]);
    }
  }
});

test("complete preflight rejects bad cwd or command before creating anything",async()=>{
  for(const leaf of [{command:["rexpi-executable-does-not-exist"]},{cwd:"/rexpi/missing/path"}]) {
    const h=harness(); Object.assign(h.spec.root.after,leaf);
    await assert.rejects(h.opener.open("bad","ops",h.spec,cwd)); assert.equal(h.calls.length,0);
  }
});
test("failure before or after create/swap/close never retries or closes pre-existing panes",async()=>{
  for(const method of ["session.new_window","session.swap_blocks","block.close","session.focus_block"]) {
    for(const afterEffect of [false,true]) {
      const h=harness({fail:method,afterEffect});
      const result=await h.opener.open("uncertain","ops",h.spec,cwd);
      assert.equal(result.state,"unknown");
      assert.equal(h.calls.filter(([m])=>m===method).length,1);
      assert.ok(h.locations.has(h.pi)); assert.ok(h.locations.has(h.unrelated));
      assert.ok(h.calls.filter(([m])=>m==="block.close").every(([,args])=>args.block_id!==h.pi&&args.block_id!==h.unrelated));
      await h.opener.open("uncertain","ops",h.spec,cwd);
      assert.equal(h.calls.filter(([m])=>m===method).length,1);
    }
  }
});
test("cancellation after create or swap stops further mutations",async()=>{
  for(const method of ["session.new_window","session.swap_blocks"]) {
    const h=harness({cancel:method}); const result=await h.opener.open("cancel","ops",h.spec,cwd);
    assert.equal(result.state,"unknown"); assert.equal(h.calls.at(-1)[0],method);
    assert.ok(h.locations.has(h.pi)); assert.ok(h.locations.has(h.unrelated));
  }
});
test("layouts without a Pi slot leave the current conversation in its original window",async()=>{
  const h=harness(); const result=await h.opener.open("shell","shells",{version:1,root:{type:"terminal",title:"Shell"}},cwd);
  assert.equal(result.state,"confirmed"); assert.equal(result.piMove,"not-requested");
  assert.equal(h.locations.get(h.pi),h.oldWindow); assert.equal(h.calls.length,2);
});
