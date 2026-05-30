import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedEnvelope {
  ciphertext: string;
  nonce: string;
}

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

export function hexToKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new CryptoError('Key must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptBytes(key: Buffer, plaintext: Buffer): EncryptedEnvelope {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
    nonce: nonce.toString('base64'),
  };
}

export function decryptBytes(key: Buffer, envelope: EncryptedEnvelope): Buffer {
  assertKey(key);
  const nonce = Buffer.from(envelope.nonce, 'base64');
  if (nonce.length !== NONCE_BYTES) {
    throw new CryptoError(`Nonce must be ${NONCE_BYTES} bytes (got ${nonce.length})`);
  }
  const combined = Buffer.from(envelope.ciphertext, 'base64');
  if (combined.length < TAG_BYTES) {
    throw new CryptoError('Ciphertext too short to contain auth tag');
  }
  const tagOffset = combined.length - TAG_BYTES;
  const encrypted = combined.subarray(0, tagOffset);
  const tag = combined.subarray(tagOffset);
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new CryptoError('Authentication failed: invalid key, nonce, ciphertext, or tag');
  }
}

export function encryptJson(key: Buffer, value: unknown): EncryptedEnvelope {
  return encryptBytes(key, Buffer.from(JSON.stringify(value), 'utf8'));
}

export function decryptJson<T = unknown>(key: Buffer, envelope: EncryptedEnvelope): T {
  const bytes = decryptBytes(key, envelope);
  try {
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch {
    throw new CryptoError('Decrypted payload is not valid JSON');
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(`Key must be ${KEY_BYTES} bytes (got ${key.length})`);
  }
}
