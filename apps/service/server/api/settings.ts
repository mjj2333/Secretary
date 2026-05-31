import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { ValidationError } from '@secretary/shared-types';
import { SettingsRepository } from '../db/repositories/SettingsRepository.js';

export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: { db: Database.Database },
): void {
  const repo = new SettingsRepository(deps.db);

  app.get('/settings', async () => ({ data: repo.getAll() }));

  app.patch('/settings', async (req) => {
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
      throw new ValidationError('Body must be an object of settings keys');
    }
    return { data: repo.patch(req.body as Record<string, unknown>) };
  });
}
