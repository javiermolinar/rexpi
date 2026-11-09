// Explicit live check: moves the invoking Pi to a new tab; never run as an automated unit test.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { Rex } from "../lib/rex.ts";
import { BindingStore } from "../lib/store.ts";
import { LayoutOpener } from "../lib/layout-open.ts";
import { builtInLayout } from "../lib/layouts.ts";
const exec = promisify(execFile);
const rex = new Rex(process.env.PI_REX_CLI ?? "rex", async (command, args, options) => {
  try { const result = await exec(command, args, options); return { code: 0, ...result }; }
  catch (error) { return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "", killed: error.killed }; }
}, process.env.PI_REX_SERVER);
const blockId = process.env.REX_BLOCK;
const server = await rex.initialize(blockId);
const store = new BindingStore(process.env.PI_REX_STATE_DIR ?? join(homedir(), ".pi", "agent", "pi-rex", "bindings"));
const bindings = store.all().filter(binding => binding.blockId === blockId && binding.serverInstance === server.instanceId
  && binding.expiresAt > Date.now());
if (bindings.length !== 1) throw Error("Expected one live binding for the invoking Pi");
const binding = bindings[0], controller = new AbortController();
const own = { state: binding, server, blockId, signal: controller.signal };
// Observe the existing runtime's live lease; do not create or adopt another binding.
const runtime = {
  rex,
  snapshot() { this.assert(own); return own; },
  assert(snapshot) {
    const actual = store.find(binding, server);
    if (snapshot !== own || !actual || actual.token !== binding.token || actual.pid !== binding.pid)
      throw Error("Invoking Pi binding changed");
  },
  async source(snapshot, signal) {
    this.assert(snapshot); await rex.checkServer(signal);
    const target = await rex.locate(blockId, signal);
    await rex.verifyProcess(target, binding.pid, signal); this.assert(snapshot); return target;
  },
};
const before = await runtime.source(own);
const layout = builtInLayout("observe");
layout.root.before.after.command = ["/bin/cat"];
layout.root.after.command = ["/bin/cat"];
const result = await new LayoutOpener(runtime).open("layout-live-smoke", "layout-smoke",
  { version: 1, root: layout.root }, process.cwd());
console.log(JSON.stringify({ result, piPid: binding.pid, piSessionId: binding.piSessionId, before,
  after: await runtime.source(own) }, null, 2));
if (result.state !== "confirmed") throw Error("Live layout is not confirmed; no cleanup attempted");
// Only the two exact smoke-created cat panes, never Pi, its old window, or unrelated resources.
for (const id of result.createdBlockIds.slice(1)) {
  const target = await rex.locate(id);
  if (target.windowId !== result.windowId || id === blockId) throw Error("Smoke resource moved; stop cleanup");
  await runtime.source(own);
  await rex.api("block.close", { session_id: result.sessionId, block_id: id });
}
console.log(JSON.stringify({ cleanup: "closed only two confirmed cat panes", pi: await runtime.source(own) }));
