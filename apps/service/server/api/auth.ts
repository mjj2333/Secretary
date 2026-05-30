import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '@secretary/shared-types';
import type { SessionTokens } from '../crypto/SessionTokens.js';

const exchangeSchema = z.object({ bootstrapToken: z.string().min(1) });

export function registerAuthRoutes(app: FastifyInstance, deps: { sessions: SessionTokens }): void {
  app.post('/auth/session', async (req) => {
    const parsed = exchangeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('bootstrapToken is required');
    const { token, expiresAt } = deps.sessions.exchangeBootstrap(parsed.data.bootstrapToken);
    return { data: { token, expiresAt: new Date(expiresAt).toISOString() } };
  });

  app.delete('/auth/session', async () => {
    deps.sessions.revokeAll();
    return { data: { revoked: true } };
  });
}
