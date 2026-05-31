import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const boolFlag = z
  .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
  .transform((v) => v === 'true' || v === '1');

const defaultDataDir = join(homedir(), '.secretary');

const envSchema = z.object({
  SERVICE_PORT: z.coerce.number().int().positive().default(47824),
  SERVICE_HOST: z.string().default('127.0.0.1'),
  SERVICE_DATA_DIR: z.string().default(defaultDataDir),
  SERVICE_CERT_PATH: z.string().optional(),
  SERVICE_KEY_PATH: z.string().optional(),
  GATEWAY_URL: z.string().url().default('http://localhost:47823'),
  GATEWAY_USE_CF_HEADERS: boolFlag.default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: boolFlag.default('false'),
});

export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL'];

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  certPath: string;
  keyPath: string;
  gatewayUrl: string;
  gatewayUseCfHeaders: boolean;
  logLevel: LogLevel;
  logPretty: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid service config: ${issues}`);
  }
  const e = parsed.data;
  return {
    port: e.SERVICE_PORT,
    host: e.SERVICE_HOST,
    dataDir: e.SERVICE_DATA_DIR,
    certPath: e.SERVICE_CERT_PATH ?? join(e.SERVICE_DATA_DIR, 'certs', 'localhost.pem'),
    keyPath: e.SERVICE_KEY_PATH ?? join(e.SERVICE_DATA_DIR, 'certs', 'localhost-key.pem'),
    gatewayUrl: e.GATEWAY_URL,
    gatewayUseCfHeaders: e.GATEWAY_USE_CF_HEADERS,
    logLevel: e.LOG_LEVEL,
    logPretty: e.LOG_PRETTY,
  };
}
