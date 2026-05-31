import { describe, expect, it } from 'vitest';
import { ClassificationQueue } from '../server/agent/ClassificationQueue.js';

/** Records the order classify() is called and proves concurrency is 1. */
class RecordingWorker {
  readonly order: string[] = [];
  private active = 0;
  maxConcurrent = 0;
  async classify(id: string): Promise<void> {
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    await new Promise((r) => setTimeout(r, 1));
    this.order.push(id);
    this.active -= 1;
  }
}

describe('ClassificationQueue', () => {
  it('drains sequentially in FIFO order with concurrency 1', async () => {
    const worker = new RecordingWorker();
    const q = new ClassificationQueue(worker);
    q.enqueue('a');
    q.enqueue('b');
    q.enqueue('c');
    await q.onIdle();
    expect(worker.order).toEqual(['a', 'b', 'c']);
    expect(worker.maxConcurrent).toBe(1);
  });

  it('dedups an id already queued', async () => {
    const worker = new RecordingWorker();
    const q = new ClassificationQueue(worker);
    q.enqueue('a');
    q.enqueue('a');
    await q.onIdle();
    expect(worker.order).toEqual(['a']);
  });

  it('onIdle resolves immediately when nothing is queued', async () => {
    const worker = new RecordingWorker();
    await new ClassificationQueue(worker).onIdle();
    expect(worker.order).toEqual([]);
  });

  it('picks up an item enqueued while a job is in progress', async () => {
    let resolveFirst!: () => void;
    const order: string[] = [];
    const q = new ClassificationQueue({
      async classify(id: string) {
        if (id === 'first') {
          await new Promise<void>((r) => {
            resolveFirst = r;
          });
        }
        order.push(id);
      },
    });
    q.enqueue('first');
    await Promise.resolve(); // yield so the drain loop starts and parks on the first job
    q.enqueue('second'); // enqueued while the drain is live
    resolveFirst();
    await q.onIdle();
    expect(order).toEqual(['first', 'second']);
  });

  it('keeps draining even if a job throws', async () => {
    const order: string[] = [];
    const q = new ClassificationQueue({
      async classify(id: string) {
        if (id === 'bad') throw new Error('boom');
        order.push(id);
      },
    });
    q.enqueue('bad');
    q.enqueue('good');
    await q.onIdle();
    expect(order).toEqual(['good']);
  });
});
