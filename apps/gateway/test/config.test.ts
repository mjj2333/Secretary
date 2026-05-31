import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const HEX = 'a'.repeat(64);

describe('loadConfig', () => {
  it('parses a fully populated env', () => {
    const cfg = loadConfig({
      PORT: '12345',
      HOST: '0.0.0.0',
      GATEWAY_API_KEY: HEX,
      PAYLOAD_ENCRYPTION_KEY: 'b'.repeat(64),
      OLLAMA_URL: 'http://ollama:11434',
      OLLAMA_DEFAULT_MODEL: 'mistral',
      OLLAMA_KEEP_ALIVE: '5m',
      LOG_LEVEL: 'warn',
      LOG_PRETTY: 'true',
      RATE_LIMIT_PER_MINUTE: '120',
      RATE_LIMIT_BURST: '20',
    });
    expect(cfg.port).toBe(12345);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.apiKey).toBe(HEX);
    expect(cfg.encryptionKey.length).toBe(32);
    expect(cfg.ollamaDefaultModel).toBe('mistral');
    expect(cfg.ollamaKeepAlive).toBe('5m');
    expect(cfg.logLevel).toBe('warn');
    expect(cfg.logPretty).toBe(true);
    expect(cfg.rateLimit).toEqual({ perMinute: 120, burst: 20 });
  });

  it('applies defaults when only required vars are set', () => {
    const cfg = loadConfig({
      GATEWAY_API_KEY: HEX,
      PAYLOAD_ENCRYPTION_KEY: HEX,
    });
    expect(cfg.port).toBe(47823);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.ollamaUrl).toBe('http://localhost:11434');
    expect(cfg.ollamaDefaultModel).toBe('qwen2.5:14b-instruct-q5_K_M');
    expect(cfg.ollamaKeepAlive).toBe('0');
    expect(cfg.logLevel).toBe('info');
    expect(cfg.logPretty).toBe(false);
    expect(cfg.rateLimit).toEqual({ perMinute: 60, burst: 10 });
  });

  it('throws when required vars are missing', () => {
    expect(() => loadConfig({})).toThrow(/GATEWAY_API_KEY|PAYLOAD_ENCRYPTION_KEY/);
  });

  it('throws when keys are not 64 hex chars', () => {
    expect(() => loadConfig({ GATEWAY_API_KEY: 'short', PAYLOAD_ENCRYPTION_KEY: HEX })).toThrow(
      /64-char hex/,
    );
  });

  it('lower-cases the API key for consistent comparison', () => {
    const cfg = loadConfig({
      GATEWAY_API_KEY: 'AB'.repeat(32),
      PAYLOAD_ENCRYPTION_KEY: HEX,
    });
    expect(cfg.apiKey).toBe('ab'.repeat(32));
  });
});
