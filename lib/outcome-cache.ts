/** Extension-lifetime outcome fences for operations whose runtimes may be replaced. */
export class OutcomeCache<T> {
  private readonly calls = new Map<string, Promise<T>>();
  private readonly limit: number;
  private readonly fullError: string;

  constructor(limit: number, fullError: string) {
    this.limit = limit;
    this.fullError = fullError;
  }

  run(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.calls.get(id);
    if (previous) return previous;
    if (this.calls.size >= this.limit) return Promise.reject(new Error(this.fullError));
    // Cache before validation, awaiting, or native work, including rejected outcomes.
    const result = Promise.resolve().then(operation);
    this.calls.set(id, result);
    return result;
  }
}
