import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';
import {
  NotFoundError,
  UpstreamError,
  ValidationError,
  type DraftView,
  type EmailAddress,
  type DiffOp,
  type ThreadState,
} from '@secretary/shared-types';
import { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import { DraftsRepository } from '../db/repositories/DraftsRepository.js';
import { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { DraftRow } from '../db/schema.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';

const createSchema = z
  .object({
    threadId: z.string().min(1),
    rawIntent: z.string().optional(),
    regenerate: z.boolean().optional(),
  })
  .strict();
const patchSchema = z
  .object({ bodyText: z.string().optional(), subject: z.string().optional() })
  .strict();

function parseAddrs(json: string | null): EmailAddress[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as EmailAddress[];
  } catch {
    return [];
  }
}

function draftView(row: DraftRow): DraftView {
  return {
    id: row.id,
    threadId: row.thread_id,
    accountId: row.account_id,
    version: row.version,
    to: parseAddrs(row.to_addresses),
    cc: parseAddrs(row.cc_addresses),
    subject: row.subject,
    bodyText: row.body_text,
    rawIntent: row.raw_intent,
    polishDiff: row.polish_diff ? (JSON.parse(row.polish_diff) as DiffOp[]) : null,
    status: row.status,
    modelUsed: row.model_used,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
  };
}

export interface DraftsRouteDeps {
  db: Database.Database;
  drafter: { draft(threadId: string, opts?: { rawIntent?: string }): Promise<DraftRow | null> };
  providers: ProviderRegistry;
  stateMachine: { onOutbound(threadId: string): void };
}

export function registerDraftsRoutes(app: FastifyInstance, deps: DraftsRouteDeps): void {
  const drafts = new DraftsRepository(deps.db);
  const messages = new MessagesRepository(deps.db);
  const actions = new ActionLogRepository(deps.db);

  app.get('/drafts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = drafts.getById(id);
    if (!row) throw new NotFoundError('Draft not found');
    return { data: draftView(row) };
  });

  app.post('/drafts', async (req) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid draft request');
    // `regenerate` is accepted for API symmetry (BRIEF §9) but is a no-op here:
    // every POST /drafts creates a fresh version via DraftsRepository.nextVersion.
    const row = await deps.drafter.draft(
      parsed.data.threadId,
      parsed.data.rawIntent !== undefined ? { rawIntent: parsed.data.rawIntent } : undefined,
    );
    if (!row) throw new UpstreamError('draft_failed', 'Draft generation failed', 502);
    return { data: draftView(row) };
  });

  app.patch('/drafts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid draft patch');
    if (!drafts.getById(id)) throw new NotFoundError('Draft not found');
    const fields: { bodyText?: string; subject?: string } = {};
    if (parsed.data.bodyText !== undefined) fields.bodyText = parsed.data.bodyText;
    if (parsed.data.subject !== undefined) fields.subject = parsed.data.subject;
    drafts.updateBody(id, fields);
    return { data: draftView(drafts.getById(id)!) };
  });

  app.post('/drafts/:id/send', async (req) => {
    const { id } = req.params as { id: string };
    const draft = drafts.getById(id);
    if (!draft) throw new NotFoundError('Draft not found');
    if (draft.status === 'sent' || draft.status === 'discarded') {
      throw new ValidationError(`Draft is already ${draft.status}`);
    }
    const provider = deps.providers.get(draft.account_id);
    if (!provider) throw new NotFoundError('Account not connected');

    const replyToHeader = draft.in_reply_to_message_id
      ? (messages.getById(draft.in_reply_to_message_id)?.message_id_header ?? undefined)
      : undefined;
    const to = parseAddrs(draft.to_addresses);
    const cc = parseAddrs(draft.cc_addresses);
    const input = {
      to,
      bodyText: draft.body_text,
      ...(cc.length > 0 ? { cc } : {}),
      ...(draft.subject ? { subject: draft.subject } : {}),
      ...(replyToHeader ? { inReplyToMessageId: replyToHeader } : {}),
    };
    let providerMessageId: string;
    try {
      ({ providerMessageId } = await provider.sendMessage(input));
    } catch (err) {
      drafts.markFailed(id);
      throw new UpstreamError(
        'send_failed',
        err instanceof Error ? err.message : 'Send failed',
        502,
      );
    }
    drafts.markSent(id, { sentAt: Date.now(), finalBodySent: input.bodyText });
    deps.stateMachine.onOutbound(draft.thread_id);
    actions.append({
      actor: 'user',
      action: 'draft_sent',
      targetType: 'draft',
      targetId: id,
      details: { threadId: draft.thread_id, version: draft.version },
    });
    return { data: { providerMessageId, threadState: 'awaiting_their_reply' as ThreadState } };
  });

  app.delete('/drafts/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!drafts.getById(id)) throw new NotFoundError('Draft not found');
    drafts.markDiscarded(id);
    actions.append({
      actor: 'user',
      action: 'draft_discarded',
      targetType: 'draft',
      targetId: id,
    });
    return { data: { discarded: true } };
  });
}
