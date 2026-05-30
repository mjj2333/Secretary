import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthError } from '@secretary/shared-types';

const API_KEY_HEADER = 'x-api-key';

export interface AuthOptions {
  expectedKey: string;
}

export function makeAuthHook({ expectedKey }: AuthOptions) {
  const expected = Buffer.from(expectedKey, 'utf8');

  return async function authHook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const presented = request.headers[API_KEY_HEADER];
    const value = typeof presented === 'string' ? presented.toLowerCase() : '';
    const candidate = Buffer.from(value, 'utf8');
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      throw new AuthError('Invalid or missing X-API-Key');
    }
  };
}

export function hashKeyForLogging(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
