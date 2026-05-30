import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptJson, encryptJson } from '@secretary/shared-crypto';
import { ENVELOPE_CONTENT_TYPE, type CompleteResponse } from '@secretary/llm-protocol';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { TokenBucket } from '../src/ratelimit.js';
import {
  TEST_API_KEY,
  TEST_ENCRYPTION_KEY_HEX,
  makeMockOllama,
  makeTestConfig,
  silentLogger,
} from './helpers.js';
import { hexToKey } from '@secretary/shared-crypto';

describe('gateway server', () => {
  let app: FastifyInstance;
  let mock: ReturnType<typeof makeMockOllama>;
  const config = makeTestConfig();

  beforeEach(async () => {
    mock = makeMockOllama();
    app = await buildServer({
      config,
      ollama: mock.client,
      logger: silentLogger(),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /health', () => {
    it('returns ok and the loaded model', async () => {
      mock.setModelInfo(async () => 'test-model');
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, model_loaded: 'test-model' });
    });

    it('does not require an API key', async () => {
      mock.setModelInfo(async () => null);
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json().model_loaded).toBeNull();
    });
  });

  describe('POST /v1/complete', () => {
    it('rejects requests without an API key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/complete',
        headers: { 'content-type': ENVELOPE_CONTENT_TYPE },
        payload: JSON.stringify({ ciphertext: 'x', nonce: 'y' }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
    });

    it('rejects requests with a wrong API key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/complete',
        headers: {
          'x-api-key': 'd'.repeat(64),
          'content-type': ENVELOPE_CONTENT_TYPE,
        },
        payload: JSON.stringify({ ciphertext: 'x', nonce: 'y' }),
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects requests with the wrong content-type', async () => {
      const env = encryptJson(config.encryptionKey, { model: 'm', prompt: 'p' });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/complete',
        headers: { 'x-api-key': TEST_API_KEY, 'content-type': 'application/json' },
        payload: JSON.stringify(env),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    });

    it('rejects a malformed envelope', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/complete',
        headers: { 'x-api-key': TEST_API_KEY, 'content-type': ENVELOPE_CONTENT_TYPE },
        payload: JSON.stringify({ ciphertext: '', nonce: '' }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    });

    it('rejects an undecryptable body', async () => {
      const wrongKey = hexToKey('c'.repeat(64));
      const env = encryptJson(wrongKey, { model: 'm', prompt: 'p' });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/complete',
        headers: { 'x-api-key': TEST_API_KEY, 'content-type': ENVELOPE_CONTENT_TYPE },
        payload: JSON.stringify(env),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('decryption_failed');
    });

    it('rejects a decrypted payload that does not match the schema', async () => {
      const env = encryptJson(config.encryptionKey, { model: 'm' });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/complete',
        headers: { 'x-api-key': TEST_API_KEY, 'content-type': ENVELOPE_CONTENT_TYPE },
        payload: JSON.stringify(env),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    });

    it('encrypts the response and forwards parameters to Ollama', async () => {
      mock.setComplete(async () => ({
        response: 'hello back',
        model: 'test-model',
        tokens_in: 10,
        tokens_out: 5,
        duration_ms: 123,
      }));
      const requestPayload = {
        model: 'test-model',
        prompt: 'hello',
        temperature: 0.5,
        max_tokens: 100,
      };
      const env = encryptJson(config.encryptionKey, requestPayload);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/complete',
        headers: { 'x-api-key': TEST_API_KEY, 'content-type': ENVELOPE_CONTENT_TYPE },
        payload: JSON.stringify(env),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain(ENVELOPE_CONTENT_TYPE);
      const responseEnvelope = res.json();
      const decoded = decryptJson<CompleteResponse>(config.encryptionKey, responseEnvelope);
      expect(decoded).toMatchObject({
        response: 'hello back',
        model: 'test-model',
        tokens_in: 10,
        tokens_out: 5,
      });
      expect(mock.completeCalls).toHaveLength(1);
      expect(mock.completeCalls[0]).toMatchObject({
        model: 'test-model',
        prompt: 'hello',
        temperature: 0.5,
        maxTokens: 100,
        keepAlive: '0',
      });
    });
  });

  describe('rate limiting', () => {
    it('returns 429 once the bucket is exhausted', async () => {
      const tinyBucket = new TokenBucket({ capacity: 1, refillPerSecond: 0.0001 });
      const tinyApp = await buildServer({
        config,
        ollama: mock.client,
        logger: silentLogger(),
        rateLimiter: tinyBucket,
      });
      mock.setComplete(async () => ({
        response: 'ok',
        model: 'test-model',
        tokens_in: 1,
        tokens_out: 1,
        duration_ms: 1,
      }));
      const requestPayload = { model: 'test-model', prompt: 'p' };
      const env = encryptJson(config.encryptionKey, requestPayload);

      const first = await tinyApp.inject({
        method: 'POST',
        url: '/v1/complete',
        headers: { 'x-api-key': TEST_API_KEY, 'content-type': ENVELOPE_CONTENT_TYPE },
        payload: JSON.stringify(env),
      });
      expect(first.statusCode).toBe(200);

      const second = await tinyApp.inject({
        method: 'POST',
        url: '/v1/complete',
        headers: { 'x-api-key': TEST_API_KEY, 'content-type': ENVELOPE_CONTENT_TYPE },
        payload: JSON.stringify(env),
      });
      expect(second.statusCode).toBe(429);
      expect(second.headers['retry-after']).toBeDefined();
      expect(second.json().error.code).toBe('rate_limited');

      await tinyApp.close();
    });
  });
});

// Lint friendliness: TEST_ENCRYPTION_KEY_HEX is exported by helpers and referenced
// elsewhere; keep this token referenced so unused-import rules stay happy.
void TEST_ENCRYPTION_KEY_HEX;
