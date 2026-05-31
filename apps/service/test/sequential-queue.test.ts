import { describe, expect, it } from 'vitest';
import { SequentialQueue } from '../server/agent/SequentialQueue.js';

class Recorder {
  readonly order: string[] = [];
  private active = 0;
  maxConcurrent = 0;
  fn = async (id: string): Promise<void> => {
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    await new Promise((r) => setTimeout(r, 1));
    this.order.push(id);
    this.active -= 1;
  };
}

describe('SequentialQueue', () => {
  it('drains FIFO with concurrency 1', async () => {
    const rec = new Recorder();
    const q = new SequentialQueue(rec.fn);
    q.enqueue('a');
    q.enqueue('b');
    q.enqueue('c');
    await q.onIdle();
    expect(rec.order).toEqual(['a', 'b', 'c']);
    expect(rec.maxConcurrent).toBe(1);
  });

  it('dedups an id already queued', async () => {
    const rec = new Recorder();
    const q = new SequentialQueue(rec.fn);
    q.enqueue('a');
    q.enqueue('a');
    await q.onIdle();
    expect(rec.order).toEqual(['a']);
  });

  it('onIdle resolves immediately when empty', async () => {
    const q = new SequentialQueue(async () => {});
    await q.onIdle();
    expect(q.size()).toBe(0);
  });

  it('keeps draining when a job throws', async () => {
    const order: string[] = [];
    const q = new SequentialQueue(async (id) => {
      if (id === 'bad') throw new Error('boom');
      order.push(id);
    });
    q.enqueue('bad');
    q.enqueue('good');
    await q.onIdle();
    expect(order).toEqual(['good']);
  });

  it('picks up an item enqueued while a job is in progress', async () => {
    let resolveFirst!: () => void;
    const order: string[] = [];
    const q = new SequentialQueue(async (id) => {
      if (id === 'first')
        await new Promise<void>((r) => {
          resolveFirst = r;
        });
      order.push(id);
    });
    q.enqueue('first');
    await Promise.resolve();
    q.enqueue('second');
    resolveFirst();
    await q.onIdle();
    expect(order).toEqual(['first', 'second']);
  });
});
