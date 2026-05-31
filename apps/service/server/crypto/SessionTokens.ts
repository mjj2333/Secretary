import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError } from '@secretary/shared-types';
import type { SecretStore } from '../auth/SecretStore.js';

const SIGNING_KEY_SECRET = 'app.session-signing-key';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * Issues stateless HMAC-signed session tokens. The signing key lives in the
 * SecretStore; revocation rotates it (invalidating all tokens). A one-time
 * bootstrap token is generated per instance for the initial PWA handshake.
 */
export class SessionTokens {
  private bootstrap: string | null;

  constructor(
    private readonly store: SecretStore,
    private readonly now: () => number = Date.now,
  ) {
    this.bootstrap = randomBytes(32).toString('hex');
  }

  private signingKey(): Buffer {
    let hex = this.store.get(SIGNING_KEY_SECRET);
    if (!hex) {
      hex = randomBytes(32).toString('hex');
      this.store.set(SIGNING_KEY_SECRET, hex);
    }
    return Buffer.from(hex, 'hex');
  }

  currentBootstrapToken(): string {
    if (!this.bootstrap) throw new AuthError('Bootstrap token already used');
    return this.bootstrap;
  }

  exchangeBootstrap(
    token: string,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): { token: string; expiresAt: number } {
    if (!this.bootstrap) throw new AuthError('Bootstrap token already used');
    const a = Buffer.from(token);
    const b = Buffer.from(this.bootstrap);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AuthError('Invalid bootstrap token');
    }
    this.bootstrap = null; // single-use
    return this.issueSession(ttlSeconds);
  }

  issueSession(ttlSeconds = DEFAULT_TTL_SECONDS): { token: string; expiresAt: number } {
    const expiresAt = this.now() + ttlSeconds * 1000;
    const payload = b64url(Buffer.from(JSON.stringify({ exp: expiresAt })));
    const sig = b64url(createHmac('sha256', this.signingKey()).update(payload).digest());
    return { token: `${payload}.${sig}`, expiresAt };
  }

  validateSession(token: string): boolean {
    const dot = token.indexOf('.');
    if (dot < 0) return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = b64url(createHmac('sha256', this.signingKey()).update(payload).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    try {
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        exp: number;
      };
      return typeof exp === 'number' && exp > this.now();
    } catch {
      return false;
    }
  }

  /** Rotates the signing key, invalidating every previously issued session token. */
  revokeAll(): void {
    this.store.set(SIGNING_KEY_SECRET, randomBytes(32).toString('hex'));
  }
}
