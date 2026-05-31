export interface ClassificationWorker {
  classify(messageId: string): Promise<void>;
}

/** In-process FIFO queue draining one classification at a time (single GPU friendliness). */
export class ClassificationQueue {
  private readonly order: string[] = [];
  private readonly queued = new Set<string>();
  private draining = false;
  private idleResolvers: Array<() => void> = [];

  constructor(private readonly worker: ClassificationWorker) {}

  enqueue(messageId: string): void {
    if (this.queued.has(messageId)) return;
    this.queued.add(messageId);
    this.order.push(messageId);
    void this.drain();
  }

  /** Number of pending (not-yet-started) items. The in-flight job, if any, is not counted; use onIdle() to await full drain. */
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
          await this.worker.classify(id);
        } catch (err) {
          // The worker (Classifier) is expected to be self-contained; this is a backstop so a
          // contract-violating throw can't stall the drain loop or vanish silently.
          console.error(
            `[secretary] classification job failed (${id}):`,
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
