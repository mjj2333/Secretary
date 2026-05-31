import { describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.js';

describe('loadConfig', () => {
  it('applies local-direct defaults when env is empty', () => {
    const c = loadConfig({});
    expect(c.port).toBe(47824);
    expect(c.gatewayUrl).toBe('http://localhost:47823');
    expect(c.gatewayUseCfHeaders).toBe(false);
  });

  it('coerces port and parses the CF-headers flag', () => {
    const c = loadConfig({ SERVICE_PORT: '5000', GATEWAY_USE_CF_HEADERS: 'true' });
    expect(c.port).toBe(5000);
    expect(c.gatewayUseCfHeaders).toBe(true);
  });

  it('throws a descriptive error on an invalid port', () => {
    expect(() => loadConfig({ SERVICE_PORT: 'abc' })).toThrow(/Invalid service config/);
  });
});
