import { pino, type Logger, type LoggerOptions } from 'pino';

import type { LogLevel } from './config.js';

export interface LoggerInit {
  level: LogLevel;
  pretty: boolean;
}

export function createLogger({ level, pretty }: LoggerInit): Logger {
  const base: LoggerOptions = {
    level,
    base: { service: 'gateway' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.body',
        'res.body',
        'prompt',
        'response',
        'system',
        'plaintext',
        'ciphertext',
        'json_schema',
      ],
      remove: true,
    },
  };
  if (pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
      },
    });
  }
  return pino(base);
}
