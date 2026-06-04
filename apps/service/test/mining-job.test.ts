import { describe, expect, it } from 'vitest';
import { MiningJob } from '../server/agent/MiningJob.js';

describe('MiningJob', () => {
  it('tracks running/total/done across start, tick, finish', () => {
    const job = new MiningJob();
    expect(job.snapshot()).toEqual({ running: false, total: 0, done: 0 });
    job.start(3);
    expect(job.running).toBe(true);
    job.tick();
    job.tick();
    expect(job.snapshot()).toEqual({ running: true, total: 3, done: 2 });
    job.finish();
    expect(job.snapshot()).toEqual({ running: false, total: 3, done: 2 });
  });
});
