import type { FastifyInstance, FastifyReply } from 'fastify';
import type { EventBus, ServerEvent } from '../eventBus.js';

const HEARTBEAT_MS = 15_000;

function writeEvent(reply: FastifyReply, event: ServerEvent): void {
  reply.raw.write(`event: ${event.type}\n`);
  reply.raw.write(`data: ${JSON.stringify(event.payload)}\n\n`);
}

export function registerEventRoutes(app: FastifyInstance, deps: { eventBus: EventBus }): void {
  app.get('/events', (req, reply) => {
    // We manage the raw response ourselves (long-lived stream).
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');

    const unsubscribe = deps.eventBus.subscribe((event) => writeEvent(reply, event));
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    // Under test only: auto-close after a short window so app.inject() resolves.
    // 0 (default, unset env) means never auto-close — production keeps the stream open.
    const closeMs = Number(process.env.SSE_TEST_CLOSE_MS ?? '0');
    const autoClose =
      closeMs > 0
        ? setTimeout(() => {
            cleanup();
            reply.raw.end();
          }, closeMs)
        : undefined;

    req.raw.on('close', () => {
      if (autoClose) clearTimeout(autoClose);
      cleanup();
    });
  });
}
