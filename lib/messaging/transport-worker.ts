import { Worker } from "node:worker_threads";
import type { Server } from "../state.ts";
import type { Endpoint, Envelope } from "./protocol.ts";
import type { SendResult } from "./file-transport.ts";

export interface MailboxPage { messages: Envelope[]; next?: string }
interface Pending { resolve(value: unknown): void; reject(error: Error): void }
interface Response { id: number; value?: unknown; error?: { message: string; code?: string } }
class WorkerOutcomeError extends Error {}

/** Lazy, serialized filesystem transport. The synchronous atomic primitive stays in its worker. */
export class WorkerMailboxTransport {
  private readonly agentDirectory: string;
  private readonly stateDirectory: string;
  private readonly server: Server;
  private worker?: Worker;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;

  constructor(agentDirectory: string, stateDirectory: string, server: Server) {
    this.agentDirectory = agentDirectory; this.stateDirectory = stateDirectory; this.server = server;
  }
  mailbox(recipient: Endpoint): {
    page(after?: string): Promise<MailboxPage>;
    publish(envelope: Envelope): Promise<SendResult>;
  } {
    return {
      page: after => this.call("page", recipient, after) as Promise<MailboxPage>,
      publish: async envelope => {
        try { return await this.call("publish", recipient, envelope) as SendResult; }
        catch (error) {
          if (error instanceof WorkerOutcomeError)
            return { id: envelope.id, state: "unknown", durability: "unknown" };
          throw error;
        }
      },
    };
  }
  private start(): Worker {
    if (this.closed) throw new Error("Mailbox transport is closed");
    if (this.worker) return this.worker;
    // The worker needs only Node's native TypeScript support, not Pi/test-runner process flags.
    const worker = new Worker(new URL("./transport-thread.ts", import.meta.url), {
      execArgv: [], workerData: { agentDirectory: this.agentDirectory,
        stateDirectory: this.stateDirectory, server: this.server },
    });
    this.worker = worker;
    worker.unref();
    worker.on("message", (response: Response) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) {
        const error = new Error(response.error.message) as NodeJS.ErrnoException;
        error.code = response.error.code;
        pending.reject(error);
      } else pending.resolve(response.value);
      if (!this.pending.size) worker.unref();
    });
    const fail = (error: Error) => {
      const uncertain = new WorkerOutcomeError("Mailbox worker outcome is unknown: " + error.message);
      for (const pending of this.pending.values()) pending.reject(uncertain);
      this.pending.clear();
      if (this.worker === worker) this.worker = undefined;
      worker.unref();
    };
    worker.on("error", fail);
    worker.on("exit", () => {
      if (this.pending.size) fail(new Error("Mailbox worker exited before returning an operation outcome"));
      else if (this.worker === worker) this.worker = undefined;
    });
    return worker;
  }
  private call(operation: "page" | "publish", recipient: Endpoint, value: unknown): Promise<unknown> {
    const worker = this.start(), id = ++this.sequence;
    worker.ref();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, operation, recipient, value });
      } catch (error) {
        this.pending.delete(id);
        if (!this.pending.size) worker.unref();
        reject(new WorkerOutcomeError(error instanceof Error ? error.message : String(error)));
      }
    });
  }
  /** Reject new work; queued operations finish before the worker port closes. */
  close(): void {
    this.closed = true;
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    try { worker.postMessage({ operation: "close" }); } catch { /* an exited worker is already closed */ }
    if (!this.pending.size) worker.unref();
  }
}
