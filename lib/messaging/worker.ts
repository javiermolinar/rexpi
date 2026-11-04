export interface ReceiverOptions {
  current(): boolean;
  reconcile(signal: AbortSignal): Promise<void>;
  diagnostic?(message: string): void;
  /** Timer injection changes timing only, never import/scheduling authority. */
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** One bounded reconciliation at a time. No send retries, overlapping scans or restart after stop. */
export class ReceiverWorker {
  private readonly options: ReceiverOptions;
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private started = false;
  private stopped = false;
  private backoff = 0;
  constructor(options: ReceiverOptions) { this.options = options; }
  private current(): boolean { return !this.stopped && !this.controller.signal.aborted && this.options.current(); }
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.tick();
  }
  stop(): void { this.stopped = true; this.controller.abort(); this.clear(); }
  async drain(): Promise<void> { await this.running; }
  private clear(): void {
    if (this.timer !== undefined) (this.options.clearTimer ?? clearTimeout)(this.timer);
    this.timer = undefined;
  }
  private schedule(): void {
    if (!this.current()) return;
    this.clear();
    const callback = () => { this.timer = undefined; void this.tick(); };
    this.timer = (this.options.setTimer ?? setTimeout)(callback, this.backoff || 2000);
    this.timer?.unref?.();
  }
  /** A hint does not bypass the two-second polling bound or failure backoff. */
  kick(): void { if (this.started && !this.running && this.timer === undefined) this.schedule(); }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.clear();
    if (!this.current()) { this.stop(); return Promise.resolve(); }
    this.running = Promise.resolve().then(() => {
      if (this.current()) return this.options.reconcile(this.controller.signal);
    }).then(() => { this.backoff = 0; }, () => {
      if (!this.current()) return;
      this.backoff = Math.min(this.backoff ? this.backoff * 2 : 2000, 30_000);
      // No peer body, corrupt history or arbitrary exception text in background diagnostics.
      try { this.options.diagnostic?.("Mailbox reconciliation held; inspect local evidence"); } catch { /* advisory only */ }
    }).finally(() => {
      this.running = undefined;
      if (this.current()) this.schedule(); else this.stop();
    });
    return this.running;
  }
}
