import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerLayoutTool } from '../extensions/layout-tool.ts';
import { LayoutStore } from '../lib/layout-store.ts';
import { builtInLayout } from '../lib/layouts.ts';
function fixture(t) {
  const directory=mkdtempSync(join(realpathSync(tmpdir()),'layout-tool-')); t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const abort=new AbortController(); const own={state:{piSessionId:'pi-session'},signal:abort.signal,blockId:'block:00000000-0000-0000-0000-000000000001'};
  const runtime={ snapshot:()=>own, assert:s=>{assert.equal(s,own);abort.signal.throwIfAborted();}, source:async()=>({}) };
  const opens=[]; const state={runtime,store:new LayoutStore(directory),opener:{open:async(...args)=>{opens.push(args);return {state:'confirmed',name:args[1],windowId:'test-window'};}}};
  let tool; registerLayoutTool({registerTool:definition=>tool=definition},()=>state);
  const ctx={cwd:directory,sessionManager:{getSessionId:()=>own.state.piSessionId}};
  let next=0; const call=(params,id=String(++next),signal=abort.signal)=>tool.execute(id,params,signal,undefined,ctx);
  return {tool,call,state,opens,ctx,own,abort};
}
const spec=()=>{const layout=builtInLayout('observe'); return {version:1,root:layout.root};};
test('tool registers sequential actions and save/list/show share portable catalog',async t=>{
  const f=fixture(t); assert.equal(f.tool.name,'rexpi_layout'); assert.equal(f.tool.executionMode,'sequential');
  await f.call({action:'save',name:'my-observe',layout:spec()}); assert.equal(f.opens.length,0);
  const list=await f.call({action:'list'});assert.deepEqual(list.details.map(x=>x.name),['build','inspect','observe','my-observe']);
  const show=await f.call({action:'show',name:'my-observe'}); assert.equal(show.details.root.before.before.source,'current');
  assert.match(show.content[0].text,/Shell/); assert.match(show.content[0].text,/Monitor shell/);
});
test('tool commands are opt-in user customizations, saved without execution',async t=>{
  const f=fixture(t), builtin=builtInLayout('inspect');
  builtin.root.after.command=['my-diff','--literal'];
  await f.call({action:'save',name:'my-review',layout:{version:1,root:builtin.root}});
  const saved=await f.call({action:'show',name:'my-review'});
  assert.deepEqual(saved.details.root.after.command,['my-diff','--literal']);
  saved.details.root.after.command.push('changed');
  assert.deepEqual(f.state.store.get('my-review').root.after.command,['my-diff','--literal']);
  assert.equal(builtInLayout('inspect').root.after.command,undefined);
  assert.equal(f.opens.length,0);
});
test('open uses same materializer; save duplicate call IDs never overwrite or open',async t=>{
  const f=fixture(t);const params={action:'save',name:'ops',layout:spec()};
  const first=await f.call(params,'same');assert.equal(await f.call(params,'same'),first);
  assert.equal(f.opens.length,0);
  await f.call({action:'open',name:'ops'},'open');await f.call({action:'open',name:'ops'},'open');
  assert.equal(f.opens.length,1);assert.deepEqual(Object.keys(f.opens[0][2]).sort(),['root','version']);
});
test('invalid specs, action arguments, built-ins and duplicate names fail closed',async t=>{
  const f=fixture(t);
  await f.call({action:'save',name:'ops',layout:spec()});
  for(const params of [
    {action:'save',name:'observe',layout:spec(),overwrite:true}, {action:'delete',name:'inspect'},
    {action:'save',name:'ops',layout:spec()}, {action:'save',name:'bad',layout:{...spec(),token:'secret'}},
    {action:'list',name:'ops'}, {action:'show',name:'ops',layout:spec()}, {action:'show',name:'ops',overwrite:true},
    {action:'save',name:'../bad',layout:spec()}, {action:'save',name:'bad'},
  ]) await assert.rejects(f.call(params));
  await f.call({action:'save',name:'ops',layout:{version:1,root:{type:'terminal',title:'Replacement'}},overwrite:true});
  assert.equal((await f.call({action:'show',name:'ops'})).details.root.title,'Replacement');
  await f.call({action:'delete',name:'ops'});await assert.rejects(f.call({action:'show',name:'ops'}));
});
test('capture reads current window and saves without launching panes',async t=>{
  const f=fixture(t), block=f.own.blockId, window='window:00000000-0000-0000-0000-000000000001';
  f.state.runtime.rex={locate:async()=>({sessionId:'session',blockId:block}),view:async()=>({active_window_id:window,
    windows:[{window_id:window,focused_block_id:block,layers:[{kind:'tiled',blocks:[{block_id:block,creator_name:'com.superlogical.terminal',flavor:'com.superlogical.terminal.shell',label:'Pi'}],layout:{rect:[0,0,1,1],block_id:block}}]}]})};
  await f.call({action:'capture',name:'captured'}); assert.equal(f.opens.length,0);
  assert.equal(f.state.store.get('captured').root.source,'current');
});
test('cancellation, absent capability state and stale session reject before mutation',async t=>{
  const f=fixture(t); f.abort.abort();await assert.rejects(f.call({action:'save',name:'ops',layout:spec()}));
  assert.throws(()=>f.state.store.get('ops'));
  const g=fixture(t);g.ctx.sessionManager.getSessionId=()=> 'other';await assert.rejects(g.call({action:'open',name:'observe'}));assert.equal(g.opens.length,0);
  const h=fixture(t);h.state.runtime=undefined;await assert.rejects(h.call({action:'list'}));
});
test('uncertain opening retains evidence and reports an error without retry',async t=>{
  const f=fixture(t);f.state.opener.open=async()=>({state:'unknown',name:'observe',piMove:'unknown',reason:'lost reply'});
  const result=await f.call({action:'open',name:'observe'});assert.equal(result.isError,true);assert.equal(result.details.state,'unknown');
});
