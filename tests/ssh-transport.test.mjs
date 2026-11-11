import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  SshTransportError,
  SshUnixSocketTransport,
} from "../lib/ssh-transport.ts";
import {
  createUnixSocketStaging,
  publishUnixSocket,
  removeUnixSocketStaging,
} from "../extensions/hosts.ts";

const REQUEST = Object.freeze({
  hostId: "host-1",
  hostAlias: "builder-1",
  sshTarget: "rex@example.test",
  localSocketPath: "/tmp/rexpi-builder-1.sock",
  remoteSocketPath: "/run/user/1000/rex.sock",
});
const TEST_SETTINGS = {
  connectTimeoutMs: 5000,
  startupTimeoutMs: 60,
  probeTimeoutMs: 20,
  inspectionTimeoutMs: 20,
  cleanupTimeoutMs: 20,
  pollIntervalMs: 1,
  serverAliveIntervalSeconds: 15,
  serverAliveCountMax: 3,
};

let processSequence = 0;
class FakeProcess {
  constructor(autoExit = true) {
    this.pid = ++processSequence;
    this.startToken = "process-start-" + this.pid;
    this.autoExit = autoExit;
    this.exited = false;
    this.kills = [];
    this.exitListeners = new Set();
    this.stderrListeners = new Set();
  }
  onExit(listener) {
    if (this.exited) queueMicrotask(() => listener(this.exitCode ?? null, this.exitSignal ?? null));
    else this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  onStderr(listener) {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }
  kill(signal = "SIGTERM") {
    this.kills.push(signal);
    if (this.autoExit) this.exit(null, signal);
  }
  stderr(chunk) {
    for (const listener of [...this.stderrListeners]) listener(chunk);
  }
  exit(code = 0, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.exitSignal = signal;
    for (const listener of [...this.exitListeners]) listener(code, signal);
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let stagingSequence = 0;
function makeHarness(options = {}) {
  const sockets = options.sockets instanceof Map ? options.sockets : new Map(Object.entries(options.sockets ?? {}));
  const stagingDirectories = new Set();
  const processes = [];
  const spawnCalls = [];
  const probeCalls = [];
  const unlinkCalls = [];
  const spawnImplementation = options.spawn ?? ((_command, args) => {
    const child = new FakeProcess(options.autoExit ?? true);
    const forward = args[args.indexOf("-L") + 1];
    const localPath = forward.slice(0, forward.indexOf(":"));
    sockets.set(localPath, "owned-" + (++stagingSequence));
    return child;
  });
  const inspectImplementation = options.inspect ?? (async path => {
    const identity = sockets.get(path);
    return identity === undefined ? { kind: "missing" } : { kind: "socket", identity };
  });
  const probeImplementation = options.probe ?? (async () => true);
  const unlinkImplementation = options.unlink ?? (async (path, { expectedIdentity }) => {
    if (sockets.get(path) !== expectedIdentity) return false;
    sockets.delete(path);
    return true;
  });
  const journalRecords = options.journalRecords ?? [];
  const processIdentities = options.processIdentities ?? new Map();
  const existingProcess = options.existingProcess;
  const transport = new SshUnixSocketTransport({
    spawn(command, args, spawnOptions) {
      spawnCalls.push({ command, args: [...args], options: spawnOptions });
      const child = spawnImplementation(command, args, spawnOptions);
      processes.push(child);
      return child;
    },
    async probe(request, probeOptions) {
      probeCalls.push({ request, options: probeOptions });
      return probeImplementation(request, probeOptions);
    },
    inspectSocket: inspectImplementation,
    async unlinkSocket(path, unlinkOptions) {
      unlinkCalls.push({ path, options: unlinkOptions });
      return unlinkImplementation(path, unlinkOptions);
    },
    async createSocketStaging() {
      const directory = "/tmp/.rexpi-test-" + (++stagingSequence);
      stagingDirectories.add(directory);
      return { directory, path: directory + "/forward.sock" };
    },
    async publishStagedSocket(staging, configuredPath) {
      if (sockets.has(configuredPath)) return "exists";
      const identity = sockets.get(staging.path);
      if (identity === undefined) throw new Error("missing staged socket");
      sockets.set(configuredPath, identity);
      return "published";
    },
    async removeSocketStaging(staging) {
      for (const path of sockets.keys())
        if (path.startsWith(staging.directory + "/")) throw new Error("staging directory is not empty");
      stagingDirectories.delete(staging.directory);
    },
    journal: {
      async create(record) {
        if (journalRecords.some(value => value.attemptId === record.attemptId)) throw new Error("duplicate attempt");
        journalRecords.push(record);
      },
      async update(record) {
        const index = journalRecords.findIndex(value => value.attemptId === record.attemptId);
        if (index < 0) throw new Error("missing attempt");
        journalRecords[index] = record;
      },
      async read(hostId) { return journalRecords.filter(value => value.hostId === hostId); },
      async remove(record) {
        const index = journalRecords.findIndex(value => value.attemptId === record.attemptId);
        if (index >= 0) journalRecords.splice(index, 1);
      },
    },
    async processStartToken(pid) {
      if (processIdentities.has(pid)) return processIdentities.get(pid);
      if (pid === process.pid) return options.controllerAlive === false ? undefined : "controller-current";
      const child = processes.find(value => value.pid === pid) ?? existingProcess;
      return child && !child.exited ? child.startToken : undefined;
    },
    attachProcess(pid) {
      if (options.attachProcess) return options.attachProcess(pid);
      if (existingProcess) return existingProcess;
      return new FakeProcess(false);
    },
    settings: { ...TEST_SETTINGS, ...(options.settings ?? {}) },
    environment: {
      HOME: "/home/test",
      PATH: "/usr/bin:/bin",
      SSH_AUTH_SOCK: "/tmp/test-agent.sock",
      SSH_ASKPASS: "/unsafe/askpass",
      LD_PRELOAD: "/unsafe/inject.so",
      REX_PASSWORD: "do-not-forward",
    },
  });
  return { transport, sockets, stagingDirectories, processes, journalRecords, processIdentities,
    spawnCalls, probeCalls, unlinkCalls };
}

function transportError(predicate) {
  return error => {
    assert.ok(error instanceof SshTransportError);
    assert.ok(predicate(error), error.code + ": " + error.message);
    return true;
  };
}

test("healthy external sockets are probed and borrowed without adoption or cleanup", async () => {
  const h = makeHarness({ sockets: { [REQUEST.localSocketPath]: "external-1" } });
  const first = await h.transport.connect(REQUEST);
  assert.equal(first.ownership, "external");
  assert.equal(first.endpoint, REQUEST.localSocketPath);
  assert.ok(Object.isFrozen(first));
  let callbacks = 0;
  const result = await h.transport.withOperation(REQUEST, async ticket => {
    callbacks += 1;
    assert.equal(ticket.ownership, "external");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(callbacks, 1);
  assert.equal(h.probeCalls.length, 2);
  assert.equal(h.spawnCalls.length, 0);
  await h.transport.close(REQUEST);
  assert.equal(h.processes.length, 0);
  assert.equal(h.unlinkCalls.length, 0);
  assert.equal(h.sockets.get(REQUEST.localSocketPath), "external-1");
});

test("point-in-time health probes never connect, adopt, spawn, or retry", async () => {
  let healthy = true;
  const h = makeHarness({
    sockets: { [REQUEST.localSocketPath]: "external-1" },
    probe: async () => healthy,
  });
  const ticket = await h.transport.connect(REQUEST);
  assert.equal(await h.transport.probe(ticket), true);
  healthy = false;
  assert.equal(await h.transport.probe(ticket), false);
  assert.equal(h.probeCalls.length, 3, "initial verification plus two explicit health checks");
  assert.equal(h.spawnCalls.length, 0);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.transport.probe(ticket, controller.signal),
    transportError(error => error.code === "cancelled"));
  assert.equal(h.probeCalls.length, 3, "an already cancelled probe performs no I/O");
});

test("owned health probes require the same live process and socket identity", async () => {
  const h = makeHarness();
  const ticket = await h.transport.connect(REQUEST);
  const identity = h.sockets.get(REQUEST.localSocketPath);
  assert.equal(await h.transport.probe(ticket), true);
  h.sockets.set(REQUEST.localSocketPath, "external-replacement");
  assert.equal(await h.transport.probe(ticket), false);
  h.sockets.set(REQUEST.localSocketPath, identity);
  assert.equal(await h.transport.probe(ticket), true);
  h.processes[0].exit(1);
  assert.equal(await h.transport.probe(ticket), false);
  assert.equal(h.spawnCalls.length, 1, "a failed health check never starts a replacement tunnel");
  await h.transport.close(REQUEST);
});

test("owned startup uses literal bounded OpenSSH argv, reuses health, and cleans only its socket", async () => {
  const h = makeHarness();
  const ticket = await h.transport.connect(REQUEST);
  assert.equal(ticket.ownership, "rexpi");
  assert.equal(h.spawnCalls.length, 1);
  const call = h.spawnCalls[0];
  assert.equal(call.command, "ssh");
  const stagedPath = call.args[call.args.indexOf("-L") + 1].split(":")[0];
  assert.notEqual(stagedPath, REQUEST.localSocketPath);
  assert.match(stagedPath, /^\/tmp\/\.rexpi-test-\d+\/forward\.sock$/);
  assert.deepEqual(call.args, [
    "-N", "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ControlPersist=no",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=5",
    "-L", stagedPath + ":" + REQUEST.remoteSocketPath,
    "--", REQUEST.sshTarget,
  ]);
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.env, {
    HOME: "/home/test", PATH: "/usr/bin:/bin", SSH_AUTH_SOCK: "/tmp/test-agent.sock",
  });
  assert.equal(call.args.some(arg => /(?:^|:)\d+(?::|$)/.test(arg)), false);
  assert.equal(call.args.some(arg => arg === "-R" || arg === "-D" || arg === "-W"), false);

  assert.equal((await h.transport.connect(REQUEST)).ownership, "rexpi");
  assert.equal(h.spawnCalls.length, 1);
  await h.transport.close(REQUEST);
  assert.deepEqual(h.processes[0].kills, ["SIGTERM"]);
  assert.equal(h.unlinkCalls.length, 2);
  assert.equal(h.unlinkCalls[0].path, REQUEST.localSocketPath);
  assert.equal(h.unlinkCalls[1].path, stagedPath);
  assert.equal(h.unlinkCalls[0].options.expectedIdentity, h.unlinkCalls[1].options.expectedIdentity);
  assert.equal(h.sockets.has(REQUEST.localSocketPath), false);
  assert.equal(h.stagingDirectories.size, 0);
  assert.equal(h.journalRecords.length, 0, "successful close removes the attempt journal");
});

test("spawn failure and early exit sanitize arbitrary process errors and stderr", async () => {
  const secret = "password=hunter2; secret task arguments";
  const failedSpawn = makeHarness({ spawn: () => { throw new Error(secret); } });
  await assert.rejects(failedSpawn.transport.connect(REQUEST), transportError(error =>
    error.code === "spawn_failed" && !error.message.includes(secret)));

  const earlyExit = makeHarness({ spawn: () => {
    const child = new FakeProcess();
    setImmediate(() => { child.stderr(secret); child.exit(23); });
    return child;
  } });
  await assert.rejects(earlyExit.transport.connect(REQUEST), transportError(error =>
    error.code === "startup_failed" && error.message.includes("23")
      && !error.message.includes(secret) && error.operationStarted === false));
  assert.equal(earlyExit.processes[0].kills.length, 0);
  assert.equal(earlyExit.unlinkCalls.length, 0, "unidentified startup socket is not blindly removed");
});

test("stale external sockets and non-socket paths fail closed without spawning or unlinking", async () => {
  const stale = makeHarness({
    sockets: { [REQUEST.localSocketPath]: "stale-1" },
    probe: async () => false,
  });
  await assert.rejects(stale.transport.connect(REQUEST), transportError(error =>
    error.code === "stale_socket" && error.retryable && !error.operationStarted));
  assert.equal(stale.spawnCalls.length, 0);
  assert.equal(stale.unlinkCalls.length, 0);
  assert.equal(stale.sockets.get(REQUEST.localSocketPath), "stale-1");

  const other = makeHarness({ inspect: async () => ({ kind: "other" }) });
  await assert.rejects(other.transport.connect(REQUEST), transportError(error => error.code === "stale_socket"));
  assert.equal(other.probeCalls.length, 0);
  assert.equal(other.spawnCalls.length, 0);
  assert.equal(other.unlinkCalls.length, 0);
});

test("an exited owned tunnel is cleaned by identity and is not reported as reusable", async () => {
  const h = makeHarness();
  await h.transport.connect(REQUEST);
  h.processes[0].exit(1);
  await assert.rejects(h.transport.connect(REQUEST), transportError(error => error.code === "disconnected"));
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.processes[0].kills.length, 0, "an already exited child is not signalled again");
  assert.equal(h.unlinkCalls.length, 2);
  assert.equal(h.sockets.has(REQUEST.localSocketPath), false);
  assert.equal(h.stagingDirectories.size, 0);

  await h.transport.connect(REQUEST);
  assert.equal(h.spawnCalls.length, 2, "a later explicit pre-operation connection may establish a new tunnel");
  await h.transport.closeAll();
});

test("owned socket replacement is never unlinked, even during owned-process cleanup", async () => {
  const h = makeHarness();
  await h.transport.connect(REQUEST);
  h.sockets.set(REQUEST.localSocketPath, "external-replacement");
  await h.transport.close(REQUEST);
  assert.deepEqual(h.processes[0].kills, ["SIGTERM"]);
  assert.equal(h.unlinkCalls.length, 1, "only the private staging link is removed");
  assert.notEqual(h.unlinkCalls[0].path, REQUEST.localSocketPath);
  assert.equal(h.sockets.get(REQUEST.localSocketPath), "external-replacement");
  assert.equal(h.stagingDirectories.size, 0);
});

test("public cleanup failures do not strand the private staging attempt", async () => {
  const h = makeHarness();
  await h.transport.connect(REQUEST);
  const inspect = h.transport.inspectPath;
  h.transport.inspectPath = async (path, options) => {
    if (path === REQUEST.localSocketPath) throw new Error("public inspection failed");
    return inspect(path, options);
  };
  await assert.rejects(h.transport.close(REQUEST), transportError(error => error.code === "cleanup_failed"));
  assert.equal(h.stagingDirectories.size, 0);
  assert.ok(h.sockets.has(REQUEST.localSocketPath), "an uninspectable public path is left untouched");
});

test("cross-transport startup races never adopt or unlink the winner's public socket", async () => {
  const sockets = new Map();
  const first = makeHarness({ sockets });
  const second = makeHarness({ sockets });
  const outcomes = await Promise.allSettled([first.transport.connect(REQUEST), second.transport.connect(REQUEST)]);
  const fulfilled = outcomes.findIndex(result => result.status === "fulfilled");
  const rejected = fulfilled === 0 ? 1 : 0;
  assert.notEqual(fulfilled, -1);
  assert.equal(outcomes[rejected].status, "rejected");
  assert.equal(outcomes[rejected].reason.code, "conflict");
  assert.match(outcomes[rejected].reason.message, /left untouched/);

  const winner = fulfilled === 0 ? first : second;
  const loser = fulfilled === 0 ? second : first;
  const winningIdentity = sockets.get(REQUEST.localSocketPath);
  assert.equal(outcomes[fulfilled].value.ownership, "rexpi");
  assert.ok(winningIdentity);
  assert.deepEqual(loser.processes[0].kills, ["SIGTERM"]);
  assert.equal(loser.stagingDirectories.size, 0, "the loser cleaned only its private attempt");
  await loser.transport.closeAll();
  assert.equal(sockets.get(REQUEST.localSocketPath), winningIdentity,
    "loser cleanup cannot unlink the other transport's socket");

  await winner.transport.close(REQUEST);
  assert.equal(sockets.has(REQUEST.localSocketPath), false);
  assert.equal(winner.stagingDirectories.size, 0);
});

test("journal creation precedes SSH spawn and failed startup removes it", async () => {
  const journalRecords = [];
  const h = makeHarness({ journalRecords, spawn: (_command, args) => {
    assert.equal(journalRecords.length, 1);
    assert.equal(journalRecords[0].ssh, undefined, "the write-ahead record exists before the child");
    const child = new FakeProcess();
    const forward = args[args.indexOf("-L") + 1];
    h.sockets.set(forward.slice(0, forward.indexOf(":")), "write-ahead-socket");
    return child;
  } });
  await h.transport.connect(REQUEST);
  assert.equal(journalRecords[0].publicIdentity, "write-ahead-socket");
  await h.transport.close(REQUEST);
  assert.equal(journalRecords.length, 0);

  const failed = makeHarness({ spawn: () => { throw new Error("no child"); } });
  await assert.rejects(failed.transport.connect(REQUEST), transportError(error => error.code === "spawn_failed"));
  assert.equal(failed.journalRecords.length, 0);
});

test("a dead controller's matching healthy journal reclaims its SSH tunnel", async () => {
  const sockets = new Map(), journalRecords = [], processIdentities = new Map();
  const first = makeHarness({ sockets, journalRecords, processIdentities });
  await first.transport.connect(REQUEST);
  const child = first.processes[0], record = journalRecords[0];
  processIdentities.set(child.pid, child.startToken);
  record.controller = { pid: 999999, startToken: "dead-controller" };
  const second = makeHarness({ sockets, journalRecords, processIdentities, existingProcess: child });
  const recovered = await second.transport.connect(REQUEST);
  assert.equal(recovered.ownership, "rexpi");
  assert.equal(second.spawnCalls.length, 0);
  assert.strictEqual(journalRecords[0], record);
  await second.transport.close(REQUEST);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(sockets.has(REQUEST.localSocketPath), false);
  assert.equal(journalRecords.length, 0);
});

test("a live controller's journal is only borrowed and never cleaned by the borrower", async () => {
  const sockets = new Map(), journalRecords = [], processIdentities = new Map();
  const first = makeHarness({ sockets, journalRecords, processIdentities });
  await first.transport.connect(REQUEST);
  const child = first.processes[0];
  processIdentities.set(child.pid, child.startToken);
  const second = makeHarness({ sockets, journalRecords, processIdentities, existingProcess: child });
  const borrowed = await second.transport.connect(REQUEST);
  assert.equal(borrowed.ownership, "external");
  assert.equal(second.spawnCalls.length, 0);
  await second.transport.closeAll();
  assert.equal(child.kills.length, 0);
  assert.equal(journalRecords.length, 1);
  assert.ok(sockets.has(REQUEST.localSocketPath));
  await first.transport.close(REQUEST);
});

test("dead or replaced journaled children are never signalled before owned-path cleanup", async () => {
  for (const mode of ["dead", "replaced"]) {
    const sockets = new Map(), journalRecords = [], processIdentities = new Map();
    const first = makeHarness({ sockets, journalRecords, processIdentities });
    await first.transport.connect(REQUEST);
    const child = first.processes[0];
    if (mode === "dead") child.exit(1);
    processIdentities.set(child.pid, mode === "dead" ? undefined : "different-process-start");
    journalRecords[0].controller = { pid: 999999, startToken: "dead-controller" };
    const second = makeHarness({ sockets, journalRecords, processIdentities, existingProcess: child });
    await second.transport.connect(REQUEST);
    assert.equal(child.kills.length, 0, "a reused PID is never signalled");
    assert.equal(second.spawnCalls.length, 1, "cleanup permits a fresh owned attempt");
    await second.transport.closeAll();
  }
});

test("real Unix-socket publication is atomic and a loser leaves the winner untouched", async t => {
  const root = realpathSync(mkdtempSync("/tmp/rexpi-socket-publish-"));
  const configuredPath = join(root, "rex.sock");
  const options = { signal: new AbortController().signal, timeoutMs: 1000 };
  const servers = [];
  const listen = (server, path) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  const close = server => new Promise(resolve => {
    if (server.listening) server.close(() => resolve()); else resolve();
  });
  t.after(async () => {
    for (const server of servers) await close(server);
    rmSync(root, { recursive: true, force: true });
  });

  const first = await createUnixSocketStaging(configuredPath, options);
  const firstServer = createServer(); servers.push(firstServer);
  await listen(firstServer, first.path);
  assert.equal(await publishUnixSocket(first, configuredPath, options), "published");
  const published = await lstat(configuredPath);
  const staged = await lstat(first.path);
  assert.equal(published.dev, staged.dev);
  assert.equal(published.ino, staged.ino);

  const second = await createUnixSocketStaging(configuredPath, options);
  const secondServer = createServer(); servers.push(secondServer);
  await listen(secondServer, second.path);
  assert.equal(await publishUnixSocket(second, configuredPath, options), "exists");
  await unlink(second.path);
  await close(secondServer);
  await removeUnixSocketStaging(second, options);
  const remaining = await lstat(configuredPath);
  assert.equal(remaining.ino, staged.ino, "the losing publication did not replace or remove the winner");

  await unlink(configuredPath);
  await unlink(first.path);
  await close(firstServer);
  await removeUnixSocketStaging(first, options);
});

test("disconnect during a mutation is uncertain and never causes callback retry", async () => {
  const h = makeHarness();
  const started = deferred();
  let callbacks = 0;
  const operation = h.transport.withOperation(REQUEST, (_ticket, signal) => {
    callbacks += 1;
    assert.equal(signal.aborted, false);
    started.resolve();
    return new Promise(() => {});
  });
  await started.promise;
  h.processes[0].exit(null, "SIGHUP");
  await assert.rejects(operation, transportError(error =>
    error.code === "operation_uncertain" && error.phase === "operation"
      && error.operationStarted && error.retryable === false));
  assert.equal(callbacks, 1);
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.probeCalls.length, 1);
  await h.transport.close(REQUEST);
});

test("post-dispatch callback failure is sanitized, uncertain, and never retried", async () => {
  const secret = "sensitive mutation response";
  const h = makeHarness({ sockets: { [REQUEST.localSocketPath]: "external-1" } });
  let callbacks = 0;
  await assert.rejects(h.transport.withOperation(REQUEST, () => {
    callbacks += 1;
    throw new Error(secret);
  }), transportError(error => error.code === "operation_uncertain" && !error.retryable
    && error.operationStarted && !error.message.includes(secret)));
  assert.equal(callbacks, 1);
  assert.equal(h.probeCalls.length, 1);
  assert.equal(h.spawnCalls.length, 0);
});

test("startup and uncooperative process cleanup remain bounded", async () => {
  const startup = makeHarness({
    probe: () => new Promise(() => {}),
    settings: { startupTimeoutMs: 20, probeTimeoutMs: 1000, cleanupTimeoutMs: 5 },
  });
  const started = Date.now();
  await assert.rejects(startup.transport.connect(REQUEST), transportError(error => error.code === "timeout"));
  assert.ok(Date.now() - started < 500, "an ignored probe signal cannot extend startup indefinitely");
  assert.deepEqual(startup.processes[0].kills, ["SIGTERM"]);

  const cleanup = makeHarness({ autoExit: false, settings: { cleanupTimeoutMs: 10 } });
  await cleanup.transport.connect(REQUEST);
  const closeStarted = Date.now();
  await assert.rejects(cleanup.transport.close(REQUEST), transportError(error =>
    error.code === "cleanup_failed" && error.phase === "cleanup"));
  assert.ok(Date.now() - closeStarted < 500, "an ignored process exit cannot extend cleanup indefinitely");
  assert.deepEqual(cleanup.processes[0].kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(cleanup.unlinkCalls.length, 0, "a live process is not left with an unlinked active socket");

  const inspection = makeHarness({
    inspect: () => new Promise(() => {}),
    settings: { inspectionTimeoutMs: 10 },
  });
  await assert.rejects(inspection.transport.connect(REQUEST), transportError(error => error.code === "timeout"));
  assert.equal(inspection.spawnCalls.length, 0);
});

test("AbortSignal cancels shared startup and post-dispatch cancellation is uncertain", async () => {
  const probeStarted = deferred();
  let probeSignal;
  const startup = makeHarness({ probe: (_request, { signal }) => {
    probeSignal = signal;
    probeStarted.resolve();
    return new Promise(() => {});
  } });
  const controller = new AbortController();
  const connecting = startup.transport.connect(REQUEST, controller.signal);
  await probeStarted.promise;
  controller.abort();
  await assert.rejects(connecting, transportError(error => error.code === "cancelled" && !error.operationStarted));
  assert.equal(probeSignal.aborted, true);
  await startup.transport.close(REQUEST); // Wait for the shared startup's bounded cleanup.
  assert.deepEqual(startup.processes[0].kills, ["SIGTERM"]);

  const operationHarness = makeHarness({ sockets: { [REQUEST.localSocketPath]: "external-1" } });
  const operationStarted = deferred();
  const operationController = new AbortController();
  let operationSignal;
  const operation = operationHarness.transport.withOperation(REQUEST, (_ticket, signal) => {
    operationSignal = signal;
    operationStarted.resolve();
    return new Promise(() => {});
  }, operationController.signal);
  await operationStarted.promise;
  operationController.abort();
  await assert.rejects(operation, transportError(error =>
    error.code === "operation_uncertain" && error.operationStarted && !error.retryable));
  assert.equal(operationSignal.aborted, true);
});

test("identical concurrent connects deduplicate startup and conflicting configurations fail", async () => {
  const probeStarted = deferred();
  const healthy = deferred();
  const h = makeHarness({ probe: () => {
    probeStarted.resolve();
    return healthy.promise;
  } });
  const first = h.transport.connect(REQUEST);
  const second = h.transport.connect({ ...REQUEST });
  await probeStarted.promise;
  assert.equal(h.spawnCalls.length, 1);
  await assert.rejects(h.transport.connect({ ...REQUEST, remoteSocketPath: "/tmp/other-rex.sock" }),
    transportError(error => error.code === "conflict"));
  await assert.rejects(h.transport.connect({ ...REQUEST, hostAlias: "other-alias" }),
    transportError(error => error.code === "conflict"));
  await assert.rejects(h.transport.connect({ ...REQUEST, hostId: "host-2" }),
    transportError(error => error.code === "conflict"));
  healthy.resolve(true);
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(a, b);
  assert.equal(h.spawnCalls.length, 1);
  await h.transport.close(REQUEST);
});

test("new callers do not inherit an abandoned pending connection's cancellation", async () => {
  let probes = 0;
  const h = makeHarness({ probe: async () => ++probes === 1 ? new Promise(() => {}) : true });
  const controller = new AbortController();
  const first = h.transport.connect(REQUEST, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(first, transportError(error => error.code === "cancelled"));
  const second = await h.transport.connect(REQUEST);
  assert.equal(second.ownership, "rexpi");
  assert.equal(h.spawnCalls.length, 2);
  await h.transport.closeAll();
});

test("closeAll signals every owned process before awaiting sequential cleanup", async () => {
  const h = makeHarness();
  await h.transport.connect(REQUEST);
  await h.transport.connect({ ...REQUEST,
    hostId: "host-2", hostAlias: "builder-2", localSocketPath: "/tmp/rexpi-builder-2.sock" });
  const closing = h.transport.closeAll();
  assert.deepEqual(h.processes.map(process => process.kills[0]), ["SIGTERM", "SIGTERM"]);
  await closing;
});

test("request validation requires explicit identity, target, and absolute Unix-socket paths", () => {
  const h = makeHarness();
  const invalid = [
    { ...REQUEST, hostId: "" },
    { ...REQUEST, hostAlias: "Builder-1" },
    { ...REQUEST, sshTarget: undefined },
    { ...REQUEST, localSocketPath: "relative.sock" },
    { ...REQUEST, remoteSocketPath: "rex.sock" },
    { ...REQUEST, localSocketPath: "/tmp/rex:22.sock" },
    { ...REQUEST, remoteSocketPath: "/run/rex:22.sock" },
    { ...REQUEST, remoteSocketPath: "/run/[rex].sock" },
    { ...REQUEST, unexpected: true },
  ];
  for (const value of invalid)
    assert.throws(() => h.transport.connect(value), transportError(error => error.code === "invalid_request"));
  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.probeCalls.length, 0);
});
