import { parentPort, workerData } from "node:worker_threads";
import { BindingStore } from "../store.ts";
import { FileMailbox } from "./file-transport.ts";
import type { Server } from "../state.ts";
import type { Endpoint } from "./protocol.ts";

interface Request {
  id: number;
  operation: "page" | "publish";
  recipient: Endpoint;
  value?: unknown;
}
type Message = Request | { operation: "close" };

if (!parentPort) throw new Error("Mailbox transport requires a worker thread");
const port = parentPort, config = workerData as { agentDirectory: string; stateDirectory: string; server: Server };
const store = new BindingStore(config.stateDirectory);
port.on("message", (request: Message) => {
  if (request.operation === "close") { port.close(); return; }
  try {
    const mailbox = new FileMailbox(config.agentDirectory, request.recipient, store, config.server);
    const value = request.operation === "page" ? mailbox.page(request.value as string | undefined)
      : mailbox.publish(request.value as Parameters<FileMailbox["publish"]>[0]);
    port.postMessage({ id: request.id, value });
  } catch (error) {
    port.postMessage({ id: request.id, error: {
      message: error instanceof Error ? error.message : String(error),
      code: (error as NodeJS.ErrnoException).code,
    } });
  }
});
