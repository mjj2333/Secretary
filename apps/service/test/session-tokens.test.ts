import { describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { SessionTokens } from '../server/crypto/SessionTokens.js';

function make(now = () => 1_000) {
  return new SessionTokens(new InMemorySecretStore(), now);
}

describe('SessionTokens', () => {
  it('exchanges its bootstrap token once for a valid session token', () => {
    const st = make();
    const bootstrap = st.currentBootstrapToken();
    const { token } = st.exchangeBootstrap(bootstrap);
    expect(st.validateSession(token)).toBe(true);
    // single-use: second exchange of the same bootstrap token fails
    expect(() => st.exchangeBootstrap(bootstrap)).toThrow();
  });

  it('rejects an expired session token', () => {
    let t = 1_000;
    const st = new SessionTokens(new InMemorySecretStore(), () => t);
    const { token } = st.exchangeBootstrap(st.currentBootstrapToken(), 10);
    t = 20_000;
    expect(st.validateSession(token)).toBe(false);
  });

  it('revokeAll invalidates previously issued tokens', () => {
    const st = make();
    const { token } = st.exchangeBootstrap(st.currentBootstrapToken());
    expect(st.validateSession(token)).toBe(true);
    st.revokeAll();
    expect(st.validateSession(token)).toBe(false);
  });
});
