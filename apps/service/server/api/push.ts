import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';
import { SecretaryError, ValidationError } from '@secretary/shared-types';
import { PushSubscriptionRepository } from '../db/repositories/PushSubscriptionRepository.js';

export interface PushService {
  readonly publicKey: string;
  sendTest(): Promise<{ sent: number }>;
  notifyDraftReady(threadId: string): Promise<void>;
}

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  userAgent: z.string().optional(),
});

class PushNotConfiguredError extends SecretaryError {
  constructor() {
    super('push_not_configured', 'Web Push is not configured yet', 409);
  }
}

export function registerPushRoutes(
  app: FastifyInstance,
  deps: { db: Database.Database; push?: PushService | null },
): void {
  const repo = new PushSubscriptionRepository(deps.db);

  app.get('/push/vapid-public-key', async () => {
    if (!deps.push) throw new PushNotConfiguredError();
    return { data: { publicKey: deps.push.publicKey } };
  });

  app.post('/push/subscribe', async (req) => {
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid push subscription');
    const { endpoint, keys, userAgent } = parsed.data;
    repo.upsert(userAgent === undefined ? { endpoint, keys } : { endpoint, keys, userAgent });
    return { data: { subscribed: true } };
  });

  app.delete('/push/subscribe/:endpoint', async (req) => {
    const { endpoint } = req.params as { endpoint: string };
    repo.deleteByEndpoint(decodeURIComponent(endpoint));
    return { data: { deleted: true } };
  });

  app.post('/push/test', async () => {
    if (!deps.push) throw new PushNotConfiguredError();
    return { data: await deps.push.sendTest() };
  });
}
