import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../server/providers/ProviderRegistry.js';
import { FakeEmailProvider } from './helpers/fakeProvider.js';

describe('ProviderRegistry', () => {
  it('stores, retrieves, and removes providers by accountId', () => {
    const reg = new ProviderRegistry();
    const p = new FakeEmailProvider('acc1');
    reg.set(p);
    expect(reg.get('acc1')).toBe(p);
    expect(reg.get('nope')).toBeUndefined();
    reg.remove('acc1');
    expect(reg.get('acc1')).toBeUndefined();
  });
});
