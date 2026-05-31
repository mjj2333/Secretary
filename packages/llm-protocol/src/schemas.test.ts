import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_CONTENT_TYPE,
  completeRequestSchema,
  completeResponseSchema,
  encryptedEnvelopeSchema,
  errorResponseSchema,
  healthResponseSchema,
} from './index.js';

describe('ENVELOPE_CONTENT_TYPE', () => {
  it('is the agreed-upon wire content type', () => {
    expect(ENVELOPE_CONTENT_TYPE).toBe('application/cf-encrypted+json');
  });
});

describe('encryptedEnvelopeSchema', () => {
  it('accepts a well-formed envelope', () => {
    expect(encryptedEnvelopeSchema.safeParse({ ciphertext: 'a', nonce: 'b' }).success).toBe(true);
  });

  it('rejects empty strings', () => {
    expect(encryptedEnvelopeSchema.safeParse({ ciphertext: '', nonce: '' }).success).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(encryptedEnvelopeSchema.safeParse({ ciphertext: 'a' }).success).toBe(false);
  });
});

describe('completeRequestSchema', () => {
  it('accepts a minimal request', () => {
    expect(completeRequestSchema.safeParse({ model: 'qwen', prompt: 'hi' }).success).toBe(true);
  });

  it('accepts a fully populated request', () => {
    expect(
      completeRequestSchema.safeParse({
        model: 'qwen',
        system: 'you are helpful',
        prompt: 'hi',
        temperature: 0.5,
        max_tokens: 200,
        format: 'json',
        json_schema: { type: 'object' },
      }).success,
    ).toBe(true);
  });

  it('rejects missing prompt', () => {
    expect(completeRequestSchema.safeParse({ model: 'qwen' }).success).toBe(false);
  });

  it('rejects non-positive max_tokens', () => {
    expect(
      completeRequestSchema.safeParse({ model: 'qwen', prompt: 'hi', max_tokens: 0 }).success,
    ).toBe(false);
  });

  it('rejects out-of-range temperature', () => {
    expect(
      completeRequestSchema.safeParse({ model: 'qwen', prompt: 'hi', temperature: 5 }).success,
    ).toBe(false);
  });
});

describe('completeResponseSchema', () => {
  it('accepts a well-formed response', () => {
    expect(
      completeResponseSchema.safeParse({
        response: 'ok',
        model: 'qwen',
        tokens_in: 10,
        tokens_out: 5,
        duration_ms: 100,
      }).success,
    ).toBe(true);
  });

  it('rejects negative token counts', () => {
    expect(
      completeResponseSchema.safeParse({
        response: 'ok',
        model: 'qwen',
        tokens_in: -1,
        tokens_out: 5,
        duration_ms: 100,
      }).success,
    ).toBe(false);
  });
});

describe('healthResponseSchema', () => {
  it('accepts a null model_loaded', () => {
    expect(healthResponseSchema.safeParse({ ok: true, model_loaded: null }).success).toBe(true);
  });

  it('accepts a string model_loaded', () => {
    expect(healthResponseSchema.safeParse({ ok: true, model_loaded: 'qwen' }).success).toBe(true);
  });
});

describe('errorResponseSchema', () => {
  it('accepts a typed error', () => {
    expect(
      errorResponseSchema.safeParse({
        error: { code: 'validation_error', message: 'bad input' },
      }).success,
    ).toBe(true);
  });
});
