import { Worker } from "node:worker_threads";
import type { Server } from "../state.ts";
import { uuid } from "../state.ts";
import { BindingStore } from "../store.ts";
import { decodeEnvelope, MAX_BATCH, MAX_BATCH_BYTES, type Endpoint, type Envelope } from "./protocol.ts";
import { FileMailbox } from "./file-transport.ts";
import { unknownMessageDelivery } from "./delivery.ts";
import type { SendResult } from "./file-transport.ts";

export interface MailboxPage { messages: Envelope[]; next?: string }
interface Pending { worker: Worker; resolve(value: unknown): void; reject(error: Error): void }
interface Response { id: number; value?: unknown; error?: { message: string; code?: string } }
class WorkerOutcomeError extends Error {}
class StaleMailboxWorker extends Error {}
function currentPage(value: unknown): MailboxPage {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid worker page");
    const candidate = value as { messages: unknown[]; next?: unknown };
    if (!Array.isArray(candidate.messages) || candidate.messages.length > MAX_BATCH
        || (candidate.next !== undefined && !uuid(candidate.next))) throw new Error("Invalid worker page");
    let bytes = 0;
    const messages = candidate.messages.map(message => {
      const body = JSON.stringify(message); bytes += Buffer.byteLength(body);
      if (bytes > MAX_BATCH_BYTES) throw new Error("Worker page exceeds byte bound");
      return decodeEnvelope(body);
    });
    return { messages,
      ...(candidate.next === undefined ? {} : { next: candidate.next }) };
  } catch { throw new StaleMailboxWorker("Mailbox worker schema is stale"); }
}

/** Lazy, serialized filesystem transport. The synchronous atomic primitive stays in its worker. */
export class WorkerMailboxTransport {
  private readonly agentDirectory: string;
  private readonly stateDirectory: string;
  private readonly server: Server;
  private readonly workerFactory?: () => Worker;
  private worker?: Worker;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;
  private synchronousReads = false;

  constructor(agentDirectory: string, stateDirectory: string, server: Server, workerFactory?: () => Worker) {
    this.agentDirectory = agentDirectory; this.stateDirectory = stateDirectory; this.server = server;
    this.workerFactory = workerFactory;
  }
  mailbox(recipient: Endpoint): {
    page(after?: string): Promise<MailboxPage>;
    publish(envelope: Envelope): Promise<SendResult>;
  } {
    return {
      page: async after => {
        if (this.synchronousReads) return new FileMailbox(this.agentDirectory, recipient, new BindingStore(this.stateDirectory), this.server).page(after);
        const worker = this.start();
        try { return currentPage(await this.call("page", recipient, after)); }
        catch (error) {
          if (!(error instanceof StaleMailboxWorker)) throw error;
          // Read-only fallback is safe. Retire the old worker after already-queued operations;
          // never replay an uncertain publish and never use it for a new publish.
          this.synchronousReads = true;
          if (this.worker === worker) this.worker = undefined;
          try { worker.postMessage({ operation: "close" }); } catch { /* already exited */ }
          worker.unref();
          return new FileMailbox(this.agentDirectory, recipient, new BindingStore(this.stateDirectory), this.server).page(after);
        }
      },
      publish: async envelope => {
        try { return await this.call("publish", recipient, envelope) as SendResult; }
        catch (error) {
          if (error instanceof WorkerOutcomeError)
            return { id: envelope.id, state: "unknown", durability: "unknown",
              delivery: unknownMessageDelivery(envelope.messageId) };
          throw error;
        }
      },
    };
  }
  private start(): Worker {
    if (this.closed) throw new Error("Mailbox transport is closed");
    if (this.worker) return this.worker;
    // The worker needs only Node's native TypeScript support, not Pi/test-runner process flags.
    const worker = this.workerFactory?.() ?? new Worker(new URL("./transport-thread.ts", import.meta.url), {
      execArgv: [], workerData: { agentDirectory: this.agentDirectory,
        stateDirectory: this.stateDirectory, server: this.server },
    });
    this.worker = worker;
    worker.unref();
    worker.on("message", (response: Response) => {
      const pending = this.pending.get(response.id);
      if (!pending || pending.worker !== worker) return;
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
      for (const [id, pending] of this.pending) if (pending.worker === worker) {
        this.pending.delete(id); pending.reject(uncertain);
      }
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
      this.pending.set(id, { worker, resolve, reject });
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
