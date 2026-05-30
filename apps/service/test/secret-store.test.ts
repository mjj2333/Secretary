import { describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';

describe('InMemorySecretStore', () => {
  it('returns null for an unknown key and false from has()', () => {
    const store = new InMemorySecretStore();
    expect(store.get('app.db-key')).toBeNull();
    expect(store.has('app.db-key')).toBe(false);
  });

  it('stores, reads, and deletes a secret', () => {
    const store = new InMemorySecretStore();
    store.set('app.db-key', 'abc123');
    expect(store.get('app.db-key')).toBe('abc123');
    expect(store.has('app.db-key')).toBe(true);
    store.delete('app.db-key');
    expect(store.get('app.db-key')).toBeNull();
  });
});
