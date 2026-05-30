import { pino } from 'pino';
import { hexToKey } from '@secretary/shared-crypto';

import type { Config } from '../src/config.js';
import type { CompleteParams, CompleteResult, OllamaClient } from '../src/ollama.js';

export const TEST_API_KEY = 'a'.repeat(64);
export const TEST_ENCRYPTION_KEY_HEX = 'b'.repeat(64);

export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    apiKey: TEST_API_KEY,
    encryptionKey: hexToKey(TEST_ENCRYPTION_KEY_HEX),
    ollamaUrl: 'http://localhost:11434',
    ollamaDefaultModel: 'test-model',
    ollamaKeepAlive: '0',
    ollamaTimeoutMs: 60_000,
    logLevel: 'silent',
    logPretty: false,
    rateLimit: { perMinute: 60, burst: 10 },
    ...overrides,
  };
}

export function silentLogger() {
  return pino({ level: 'silent' });
}

export function makeMockOllama(): {
  client: OllamaClient;
  completeCalls: CompleteParams[];
  setComplete: (impl: (p: CompleteParams) => Promise<CompleteResult>) => void;
  setModelInfo: (impl: () => Promise<string | null>) => void;
} {
  const completeCalls: CompleteParams[] = [];
  let completeImpl: (p: CompleteParams) => Promise<CompleteResult> = async () => ({
    response: 'default',
    model: 'test-model',
    tokens_in: 1,
    tokens_out: 1,
    duration_ms: 1,
  });
  let modelInfoImpl: () => Promise<string | null> = async () => 'test-model';

  const client: OllamaClient = {
    async complete(params) {
      completeCalls.push(params);
      return completeImpl(params);
    },
    async modelInfo() {
      return modelInfoImpl();
    },
  };

  return {
    client,
    completeCalls,
    setComplete: (impl) => {
      completeImpl = impl;
    },
    setModelInfo: (impl) => {
      modelInfoImpl = impl;
    },
  };
}
