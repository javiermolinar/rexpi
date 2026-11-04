import test from "node:test";
import assert from "node:assert/strict";
import { ReceiverWorker } from "../lib/messaging/worker.ts";

function fixture(reconcile, extra = {}) {
  const timers = [], diagnostics = [];
  const worker = new ReceiverWorker({ current: () => true, reconcile, diagnostic: text => diagnostics.push(text),
    setTimer(callback, delay) { const t = { callback, delay, unref() {} }; timers.push(t); return t; },
    clearTimer(timer) { timer.cleared = true; }, ...extra });
  return { worker, timers, diagnostics };
}

test("construction is inert, start idempotent, normal polling is two seconds, kicks do not accelerate", async () => {
  let calls = 0;
  const { worker, timers } = fixture(async () => { calls++; });
  assert.equal(calls, 0); worker.start(); worker.start(); await worker.drain();
  assert.equal(calls, 1); assert.equal(timers.length, 1); assert.equal(timers[0].delay, 2000);
  worker.kick(); worker.kick(); assert.equal(timers.length, 1);
  timers.at(-1).callback(); await worker.drain(); assert.equal(calls, 2);
  worker.stop(); assert.equal(timers.at(-1).cleared, true);
});

test("overlapping ticks join one bounded reconciliation", async () => {
  let release, calls = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const { worker, timers } = fixture(async () => { calls++; await barrier; });
  worker.start();
  const a = worker.tick(), b = worker.tick(); assert.equal(a, b);
  await Promise.resolve(); assert.equal(calls, 1); assert.equal(timers.length, 0);
  worker.kick(); release(); await a;
  assert.equal(timers.length, 1); assert.equal(timers[0].delay, 2000); worker.stop();
});

test("bounded exponential read backoff caps at thirty seconds and resets on success", async () => {
  let fail = true;
  const { worker, timers, diagnostics } = fixture(async () => { if (fail) throw new Error("secret peer body"); });
  worker.start(); await worker.drain();
  const observed = [timers.at(-1).delay];
  for (let i = 0; i < 5; i++) { await worker.tick(); observed.push(timers.at(-1).delay); }
  assert.deepEqual(observed, [2000, 4000, 8000, 16000, 30000, 30000]);
  worker.kick(); assert.equal(timers.at(-1).delay, 30000);
  assert.equal(diagnostics.some(x => x.includes("secret")), false);
  fail = false; await worker.tick(); assert.equal(timers.at(-1).delay, 2000); worker.stop();
});

test("stop aborts in-flight work, waits for quiescence via drain, and cannot restart", async () => {
  let release, signal, calls = 0;
  const { worker, timers } = fixture(async s => {
    calls++; signal = s;
    await new Promise(resolve => { release = resolve; });
    s.throwIfAborted();
  });
  worker.start(); await Promise.resolve(); worker.stop(); assert.equal(signal.aborted, true);
  let settled = false; const drain = worker.drain().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  release(); await drain; assert.equal(settled, true); assert.equal(timers.length, 0);
  worker.start(); await worker.tick(); assert.equal(calls, 1);
});

test("lost current ownership prevents reconciliation and advisory callback errors cannot break serialization", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; }, { current: () => false });
  f.worker.start(); await f.worker.drain(); assert.equal(calls, 0); assert.equal(f.timers.length, 0);
  const g = fixture(async () => { throw Error("read busy"); }, { diagnostic() { throw Error("status failed"); } });
  g.worker.start(); await g.worker.drain(); assert.equal(g.timers.at(-1).delay, 2000); g.worker.stop();
});
