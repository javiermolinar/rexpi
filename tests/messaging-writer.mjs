// Isolated subprocess fixture: never launches Pi/Rex or invokes a model.
import { FileMailbox } from "../lib/messaging/file-transport.ts";
import { BindingStore } from "../lib/store.ts";
const p = JSON.parse(process.argv[2]);
const mailbox = new FileMailbox(p.root, p.envelope.to, new BindingStore(p.bindings), p.server, {
  limits: p.limits,
  checkpoint(phase) {
    if (phase === p.pause) {
      process.send?.({ phase });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (phase === p.crash) process.exit(17);
  },
});
try { process.send?.({ result: mailbox.publish(p.envelope) }); }
catch (e) { process.send?.({ error: e.code ?? e.message }); }
