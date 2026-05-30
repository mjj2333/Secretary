import { describe, expect, it } from 'vitest';
import { AuthError } from '@secretary/shared-types';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hashKeyForLogging, makeAuthHook } from '../src/auth.js';

const KEY = 'f'.repeat(64);
const WRONG = 'a'.repeat(64);

function fakeRequest(headerValue: string | undefined): FastifyRequest {
  return { headers: { 'x-api-key': headerValue } } as unknown as FastifyRequest;
}

const noopReply = {} as FastifyReply;

describe('makeAuthHook', () => {
  const hook = makeAuthHook({ expectedKey: KEY });

  it('accepts a matching key', async () => {
    await expect(hook(fakeRequest(KEY), noopReply)).resolves.toBeUndefined();
  });

  it('accepts a matching key with different casing', async () => {
    await expect(hook(fakeRequest(KEY.toUpperCase()), noopReply)).resolves.toBeUndefined();
  });

  it('rejects a missing key', async () => {
    await expect(hook(fakeRequest(undefined), noopReply)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an empty key', async () => {
    await expect(hook(fakeRequest(''), noopReply)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a wrong-length key', async () => {
    await expect(hook(fakeRequest('short'), noopReply)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an incorrect key', async () => {
    await expect(hook(fakeRequest(WRONG), noopReply)).rejects.toBeInstanceOf(AuthError);
  });
});

describe('hashKeyForLogging', () => {
  it('produces an 8-char hex prefix', () => {
    const hash = hashKeyForLogging(KEY);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic', () => {
    expect(hashKeyForLogging(KEY)).toBe(hashKeyForLogging(KEY));
  });

  it('differs for different keys', () => {
    expect(hashKeyForLogging(KEY)).not.toBe(hashKeyForLogging(WRONG));
  });
});
