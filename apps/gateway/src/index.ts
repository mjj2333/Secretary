import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createOllamaClient } from './ollama.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, pretty: config.logPretty });
  logger.info(
    { port: config.port, host: config.host, model: config.ollamaDefaultModel },
    'starting gateway',
  );

  const ollama = createOllamaClient({
    baseUrl: config.ollamaUrl,
    defaultModel: config.ollamaDefaultModel,
    defaultKeepAlive: config.ollamaKeepAlive,
    timeoutMs: config.ollamaTimeoutMs,
  });

  const app = await buildServer({ config, ollama, logger });

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info({ port: config.port, host: config.host }, 'gateway listening');
  } catch (err) {
    logger.fatal({ err: errorMeta(err) }, 'failed to start');
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err: errorMeta(err) }, 'shutdown error');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function errorMeta(err: unknown): { message: string; name?: string } {
  if (err instanceof Error) return { message: err.message, name: err.name };
  return { message: String(err) };
}

void main().catch((err) => {
  // Logger may not exist yet during config-load failures.
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
