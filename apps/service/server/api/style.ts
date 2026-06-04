import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';
import { SecretaryError, UpstreamError, NotFoundError, ValidationError } from '@secretary/shared-types';
import { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import { StyleExamplesRepository } from '../db/repositories/StyleExamplesRepository.js';
import type { MiningJob } from '../agent/MiningJob.js';
import { styleExampleView } from './views.js';
import type { StyleExampleStatus } from '../db/schema.js';

const MINE_LIMIT = 200;

const patchSchema = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    contextSummary: z.string().optional(),
    replyText: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export interface MiningDeps {
  queue: { enqueue(id: string): void; onIdle(): Promise<void> };
  job: MiningJob;
  gatewayReady: boolean;
}

export interface StyleRouteDeps {
  db: Database.Database;
  mining: MiningDeps;
}

export function registerStyleRoutes(app: FastifyInstance, deps: StyleRouteDeps): void {
  const messages = new MessagesRepository(deps.db);
  const styleExamples = new StyleExamplesRepository(deps.db);

  app.post('/style/mine', async () => {
    if (!deps.mining.gatewayReady) {
      throw new UpstreamError('gateway_unavailable', 'LLM gateway is not configured', 503);
    }
    if (deps.mining.job.running) {
      throw new SecretaryError('mining_in_progress', 'Mining is already in progress', 409);
    }
    const candidates = messages.recentOutbound(MINE_LIMIT);
    const fresh = candidates.filter((m) => !styleExamples.existsForMessage(m.id));
    const alreadyMined = candidates.length - fresh.length;
    if (fresh.length > 0) {
      deps.mining.job.start(fresh.length);
      for (const m of fresh) deps.mining.queue.enqueue(m.id);
      void deps.mining.queue.onIdle().then(() => deps.mining.job.finish());
    }
    return { data: { enqueued: fresh.length, alreadyMined } };
  });

  app.get('/style/mining-status', async () => {
    return { data: deps.mining.job.snapshot() };
  });

  app.get('/style/examples', async (req) => {
    const status = (req.query as { status?: string }).status;
    const rows =
      status === 'pending' || status === 'approved' || status === 'rejected'
        ? styleExamples.listByStatus(status as StyleExampleStatus)
        : styleExamples.listAll();
    return { data: rows.map(styleExampleView) };
  });

  app.patch('/style/examples/:id', async (req) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid style-example patch');
    if (!styleExamples.getById(id)) throw new NotFoundError('Style example not found');
    const { status, contextSummary, replyText, tags } = parsed.data;
    const fields: { contextSummary?: string; replyText?: string; tags?: string } = {};
    if (contextSummary !== undefined) fields.contextSummary = contextSummary;
    if (replyText !== undefined) fields.replyText = replyText;
    if (tags !== undefined) fields.tags = JSON.stringify(tags);
    if (Object.keys(fields).length > 0) styleExamples.update(id, fields);
    if (status !== undefined) styleExamples.setStatus(id, status);
    return { data: styleExampleView(styleExamples.getById(id)!) };
  });
}
