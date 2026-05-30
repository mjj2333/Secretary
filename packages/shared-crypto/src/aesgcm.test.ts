import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
  hexToKey,
  type EncryptedEnvelope,
} from './aesgcm.js';

const key = randomBytes(32);

describe('hexToKey', () => {
  it('parses a valid 64-char hex string', () => {
    const buf = hexToKey('a'.repeat(64));
    expect(buf.length).toBe(32);
  });

  it('accepts upper and lower case', () => {
    const buf = hexToKey('AbCdEf'.repeat(10) + 'aBcD');
    expect(buf.length).toBe(32);
  });

  it('rejects non-hex characters', () => {
    expect(() => hexToKey('z'.repeat(64))).toThrow(CryptoError);
  });

  it('rejects wrong-length strings', () => {
    expect(() => hexToKey('a'.repeat(63))).toThrow(CryptoError);
    expect(() => hexToKey('a'.repeat(65))).toThrow(CryptoError);
    expect(() => hexToKey('')).toThrow(CryptoError);
  });
});

describe('encryptBytes / decryptBytes', () => {
  it('round-trips an arbitrary buffer', () => {
    const plaintext = Buffer.from('hello, secretary');
    const env = encryptBytes(key, plaintext);
    const decoded = decryptBytes(key, env);
    expect(decoded.equals(plaintext)).toBe(true);
  });

  it('round-trips empty plaintext', () => {
    const env = encryptBytes(key, Buffer.alloc(0));
    expect(decryptBytes(key, env).length).toBe(0);
  });

  it('round-trips larger plaintext', () => {
    const plaintext = randomBytes(1_000_000);
    const env = encryptBytes(key, plaintext);
    expect(decryptBytes(key, env).equals(plaintext)).toBe(true);
  });

  it('produces a different nonce and ciphertext each time', () => {
    const plaintext = Buffer.from('same data');
    const a = encryptBytes(key, plaintext);
    const b = encryptBytes(key, plaintext);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails to decrypt with a wrong key', () => {
    const env = encryptBytes(key, Buffer.from('top secret'));
    expect(() => decryptBytes(randomBytes(32), env)).toThrow(CryptoError);
  });

  it('fails on tampered ciphertext', () => {
    const env = encryptBytes(key, Buffer.from('payload'));
    const tampered: EncryptedEnvelope = {
      ...env,
      ciphertext: flipFirstByte(env.ciphertext),
    };
    expect(() => decryptBytes(key, tampered)).toThrow(CryptoError);
  });

  it('fails on tampered nonce', () => {
    const env = encryptBytes(key, Buffer.from('payload'));
    const tampered: EncryptedEnvelope = {
      ...env,
      nonce: flipFirstByte(env.nonce),
    };
    expect(() => decryptBytes(key, tampered)).toThrow(CryptoError);
  });

  it('rejects a malformed nonce length', () => {
    const env = encryptBytes(key, Buffer.from('payload'));
    const bad: EncryptedEnvelope = { ...env, nonce: Buffer.alloc(8).toString('base64') };
    expect(() => decryptBytes(key, bad)).toThrow(CryptoError);
  });

  it('rejects ciphertext too short to contain an auth tag', () => {
    const bad: EncryptedEnvelope = {
      ciphertext: Buffer.alloc(4).toString('base64'),
      nonce: randomBytes(12).toString('base64'),
    };
    expect(() => decryptBytes(key, bad)).toThrow(CryptoError);
  });

  it('rejects a wrong-length key on encrypt', () => {
    expect(() => encryptBytes(Buffer.alloc(16), Buffer.from('x'))).toThrow(CryptoError);
  });

  it('rejects a wrong-length key on decrypt', () => {
    const env = encryptBytes(key, Buffer.from('x'));
    expect(() => decryptBytes(Buffer.alloc(16), env)).toThrow(CryptoError);
  });
});

describe('encryptJson / decryptJson', () => {
  it('round-trips a JSON object', () => {
    const payload = { model: 'qwen', prompt: 'hi', temperature: 0.5, tags: ['a', 'b'] };
    const env = encryptJson(key, payload);
    const decoded = decryptJson<typeof payload>(key, env);
    expect(decoded).toEqual(payload);
  });

  it('round-trips null, numbers, strings', () => {
    expect(decryptJson(key, encryptJson(key, null))).toBe(null);
    expect(decryptJson(key, encryptJson(key, 42))).toBe(42);
    expect(decryptJson(key, encryptJson(key, 'hi'))).toBe('hi');
  });

  it('throws on undecryptable payload', () => {
    const env: EncryptedEnvelope = {
      ciphertext: Buffer.alloc(20).toString('base64'),
      nonce: Buffer.alloc(12).toString('base64'),
    };
    expect(() => decryptJson(key, env)).toThrow(CryptoError);
  });

  it('throws CryptoError when decrypted bytes are not valid JSON', () => {
    const env = encryptBytes(key, Buffer.from('not json {{{'));
    expect(() => decryptJson(key, env)).toThrow(CryptoError);
  });
});

function flipFirstByte(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[0] = (buf[0] ?? 0) ^ 0xff;
  return buf.toString('base64');
}
