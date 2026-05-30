import { describe, expect, it } from 'vitest';
import { createLogger } from '../server/logger.js';

describe('createLogger', () => {
  it('creates a logger at the requested level', () => {
    const log = createLogger({ level: 'warn', pretty: false });
    expect(log.level).toBe('warn');
    expect(typeof log.info).toBe('function');
  });
});
