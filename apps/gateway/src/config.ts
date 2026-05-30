import { z } from 'zod';
import { hexToKey } from '@secretary/shared-crypto';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(47823),
  HOST: z.string().default('127.0.0.1'),
  GATEWAY_API_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Must be a 64-char hex string'),
  PAYLOAD_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Must be a 64-char hex string'),
  OLLAMA_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_DEFAULT_MODEL: z.string().default('qwen2.5:14b-instruct-q5_K_M'),
  OLLAMA_KEEP_ALIVE: z.string().default('0'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
    .default('false'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_BURST: z.coerce.number().int().positive().default(10),
});

export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL'];

export interface Config {
  port: number;
  host: string;
  apiKey: string;
  encryptionKey: Buffer;
  ollamaUrl: string;
  ollamaDefaultModel: string;
  ollamaKeepAlive: string;
  ollamaTimeoutMs: number;
  logLevel: LogLevel;
  logPretty: boolean;
  rateLimit: { perMinute: number; burst: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid gateway config: ${issues}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    apiKey: e.GATEWAY_API_KEY.toLowerCase(),
    encryptionKey: hexToKey(e.PAYLOAD_ENCRYPTION_KEY),
    ollamaUrl: e.OLLAMA_URL,
    ollamaDefaultModel: e.OLLAMA_DEFAULT_MODEL,
    ollamaKeepAlive: e.OLLAMA_KEEP_ALIVE,
    ollamaTimeoutMs: e.OLLAMA_TIMEOUT_MS,
    logLevel: e.LOG_LEVEL,
    logPretty: e.LOG_PRETTY === 'true' || e.LOG_PRETTY === '1',
    rateLimit: { perMinute: e.RATE_LIMIT_PER_MINUTE, burst: e.RATE_LIMIT_BURST },
  };
}
