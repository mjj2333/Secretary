/** A worker processes one id at a time; it should be self-contained (not throw). */
export type SequentialWorker = (id: string) => Promise<void>;

/** In-process FIFO queue draining one job at a time (single-GPU friendliness). */
export class SequentialQueue {
  private readonly order: string[] = [];
  private readonly queued = new Set<string>();
  private draining = false;
  private idleResolvers: Array<() => void> = [];

  constructor(private readonly worker: SequentialWorker) {}

  enqueue(id: string): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.order.push(id);
    void this.drain();
  }

  /** Number of pending (not-yet-started) items; the in-flight job is not counted. */
  size(): number {
    return this.order.length;
  }

  /** Resolves when the queue is empty and idle. */
  onIdle(): Promise<void> {
    if (!this.draining && this.order.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const id = this.order.shift();
        if (id === undefined) break;
        try {
          await this.worker(id);
        } catch (err) {
          // Workers are expected to be self-contained; backstop so a contract-violating
          // throw can't stall the drain loop or vanish silently.
          console.error(
            `[secretary] sequential-queue job failed (${id}):`,
            err instanceof Error ? err.message : err,
          );
        }
        this.queued.delete(id);
      }
    } finally {
      this.draining = false;
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }
}
