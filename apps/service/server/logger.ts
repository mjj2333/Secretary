import pino, { type Logger } from 'pino';

export interface LoggerOptions {
  level: string;
  pretty: boolean;
  /** When set, logs are written to this file instead of stdout. */
  filePath?: string;
}

/**
 * Creates the service logger. Logs metadata only — never message bodies,
 * prompts, completions, or secret values. Callers must not pass such fields.
 */
export function createLogger(opts: LoggerOptions): Logger {
  if (opts.pretty) {
    return pino({
      level: opts.level,
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  }
  if (opts.filePath) {
    return pino(
      { level: opts.level },
      pino.destination({ dest: opts.filePath, mkdir: true, sync: false }),
    );
  }
  return pino({ level: opts.level });
}
