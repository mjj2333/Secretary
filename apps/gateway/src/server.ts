import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { ZodIssue } from 'zod';
import { decryptJson, encryptJson, type EncryptedEnvelope } from '@secretary/shared-crypto';
import {
  ENVELOPE_CONTENT_TYPE,
  completeRequestSchema,
  encryptedEnvelopeSchema,
  type CompleteResponse,
  type HealthResponse,
} from '@secretary/llm-protocol';
import {
  DecryptionError,
  RateLimitError,
  SecretaryError,
  ValidationError,
} from '@secretary/shared-types';

import type { Config } from './config.js';
import type { OllamaClient } from './ollama.js';
import { hashKeyForLogging, makeAuthHook } from './auth.js';
import { TokenBucket } from './ratelimit.js';

export interface ServerDeps {
  config: Config;
  ollama: OllamaClient;
  logger: Logger;
  rateLimiter?: TokenBucket;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, ollama, logger } = deps;
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    disableRequestLogging: true,
    bodyLimit: 1_048_576,
  });

  const rateLimiter =
    deps.rateLimiter ??
    new TokenBucket({
      capacity: config.rateLimit.burst,
      refillPerSecond: config.rateLimit.perMinute / 60,
    });
  const authHook = makeAuthHook({ expectedKey: config.apiKey });
  const keyHash = hashKeyForLogging(config.apiKey);

  app.addContentTypeParser(ENVELOPE_CONTENT_TYPE, { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err: unknown) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      done(wrapped, undefined);
    }
  });

  app.setErrorHandler((err: unknown, request, reply) => {
    const asError = err instanceof Error ? err : new Error(String(err));
    if (err instanceof SecretaryError) {
      if (err instanceof RateLimitError) {
        void reply.header('Retry-After', String(err.retryAfterSeconds));
      }
      request.log.warn(
        { code: err.code, status: err.status, endpoint: request.url },
        'request rejected',
      );
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const { statusCode } = err as { statusCode?: number };
    if (statusCode === 401) {
      return reply.status(401).send({ error: { code: 'unauthorized', message: asError.message } });
    }
    request.log.error({ err: { message: asError.message, name: asError.name } }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  app.get('/health', async (): Promise<HealthResponse> => {
    const modelLoaded = await ollama.modelInfo();
    return { ok: true, model_loaded: modelLoaded };
  });

  app.post('/v1/complete', { preHandler: [authHook] }, async (request, reply) => {
    const rate = rateLimiter.check(keyHash);
    if (!rate.allowed) {
      throw new RateLimitError(Math.max(1, Math.ceil(rate.retryAfterMs / 1000)));
    }

    const contentType = String(request.headers['content-type'] ?? '');
    if (!contentType.includes(ENVELOPE_CONTENT_TYPE)) {
      throw new ValidationError(`Expected Content-Type: ${ENVELOPE_CONTENT_TYPE}`);
    }

    const envelopeParsed = encryptedEnvelopeSchema.safeParse(request.body);
    if (!envelopeParsed.success) {
      throw new ValidationError('Request body is not a valid encrypted envelope');
    }

    let decryptedJson: unknown;
    try {
      decryptedJson = decryptJson(config.encryptionKey, envelopeParsed.data as EncryptedEnvelope);
    } catch {
      throw new DecryptionError();
    }

    const completeParsed = completeRequestSchema.safeParse(decryptedJson);
    if (!completeParsed.success) {
      const issues = completeParsed.error.issues
        .map((i: ZodIssue) => `${i.path.join('.') || '<root>'} ${i.message}`)
        .join('; ');
      throw new ValidationError(`Decrypted payload failed validation: ${issues}`);
    }
    const params = completeParsed.data;

    const startedAt = Date.now();
    const completion = await ollama.complete({
      model: params.model,
      ...(params.system !== undefined ? { system: params.system } : {}),
      prompt: params.prompt,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.max_tokens !== undefined ? { maxTokens: params.max_tokens } : {}),
      ...(params.format !== undefined ? { format: params.format } : {}),
      ...(params.json_schema !== undefined ? { jsonSchema: params.json_schema } : {}),
      keepAlive: config.ollamaKeepAlive,
    });
    const durationMs = Date.now() - startedAt;

    request.log.info(
      {
        key_hash: keyHash,
        endpoint: '/v1/complete',
        status: 200,
        duration_ms: durationMs,
        ollama_duration_ms: completion.duration_ms,
        tokens_in: completion.tokens_in,
        tokens_out: completion.tokens_out,
        model: completion.model,
      },
      'completion',
    );

    const responsePayload: CompleteResponse = {
      response: completion.response,
      model: completion.model,
      tokens_in: completion.tokens_in,
      tokens_out: completion.tokens_out,
      duration_ms: completion.duration_ms,
    };
    const encrypted = encryptJson(config.encryptionKey, responsePayload);
    void reply.header('content-type', ENVELOPE_CONTENT_TYPE);
    return encrypted;
  });

  return app;
}
