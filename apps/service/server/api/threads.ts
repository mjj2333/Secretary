import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';
import {
  NotFoundError,
  ValidationError,
  type MessageView,
  type NeedsAttentionItem,
  type ThreadState,
  type ThreadSummary,
  type ThreadWithMessages,
} from '@secretary/shared-types';
import { ThreadsRepository, type AttentionRow } from '../db/repositories/ThreadsRepository.js';
import { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import { DraftsRepository } from '../db/repositories/DraftsRepository.js';
import type { MessageRow, ThreadRow } from '../db/schema.js';
import { draftView, parseAddrs, resolveSenderName } from './views.js';

const stateBodySchema = z.object({
  state: z.enum([
    'needs_classification',
    'awaiting_their_reply',
    'awaiting_your_reply',
    'closed',
    'scheduled_followup',
    'informational',
  ]),
  reason: z.string().optional(),
});

function threadSummary(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    subject: row.subject_normalized,
    participants: row.participants ? (JSON.parse(row.participants) as string[]) : [],
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
    state: row.state,
  };
}

function needsAttentionItem(
  row: AttentionRow,
): Omit<NeedsAttentionItem, 'senderName' | 'hasDraft'> {
  return {
    ...threadSummary(row),
    urgency: row.urgency,
    slaDeadline: row.sla_deadline ? new Date(row.sla_deadline).toISOString() : null,
    summary: row.last_agent_summary,
    hasPendingFollowUp: row.has_pending === 1,
  };
}

function messageView(row: MessageRow): MessageView {
  return {
    id: row.id,
    from: row.from_name
      ? { address: row.from_address, name: row.from_name }
      : { address: row.from_address },
    to: parseAddrs(row.to_addresses),
    subject: row.subject,
    snippet: row.snippet,
    bodyText: row.body_text,
    direction: row.direction,
    dateReceived: row.date_received ? new Date(row.date_received).toISOString() : null,
    isRead: row.is_read === 1,
  };
}

export interface ThreadsRouteDeps {
  db: Database.Database;
  classificationQueue: { enqueue(messageId: string): void };
  stateMachine: { onManual(threadId: string, state: ThreadState, reason?: string): void };
}

export function registerThreadsRoutes(app: FastifyInstance, deps: ThreadsRouteDeps): void {
  const threads = new ThreadsRepository(deps.db);
  const messages = new MessagesRepository(deps.db);
  const contacts = new ContactsRepository(deps.db);
  const drafts = new DraftsRepository(deps.db);

  app.get('/threads/needs-attention', async () => ({
    // Per-row enrichment (sender + has-draft) is fine: the needs-attention list is bounded
    // (threads awaiting reply / with a pending follow-up) and these are indexed point lookups.
    data: threads.needsAttention().map((row) => ({
      ...needsAttentionItem(row),
      senderName: resolveSenderName(row, messages, contacts),
      hasDraft: drafts.currentForThread(row.id) !== undefined,
    })),
  }));

  app.get('/threads', async (req) => {
    const q = req.query as { accountId?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit ?? '50'), 200);
    const offset = Number(q.offset ?? '0');
    const rows = q.accountId
      ? threads.listByAccount(q.accountId, limit, offset)
      : (deps.db
          .prepare('SELECT * FROM threads ORDER BY last_message_at DESC LIMIT ? OFFSET ?')
          .all(limit, offset) as ThreadRow[]);
    return { data: rows.map(threadSummary) };
  });

  app.get('/threads/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = threads.get(id);
    if (!row) throw new NotFoundError('Thread not found');
    const current = drafts.currentForThread(id);
    const view: ThreadWithMessages = {
      ...threadSummary(row),
      senderName: resolveSenderName(row, messages, contacts),
      messages: messages.listByThread(id).map(messageView),
      currentDraft: current ? draftView(current) : null,
    };
    return { data: view };
  });

  app.post('/threads/:id/state', async (req) => {
    const { id } = req.params as { id: string };
    const parsed = stateBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid state');
    // onManual throws NotFoundError internally if the thread is missing.
    deps.stateMachine.onManual(id, parsed.data.state, parsed.data.reason);
    const updated = threads.get(id);
    if (!updated) throw new NotFoundError('Thread not found');
    return { data: threadSummary(updated) };
  });

  app.post('/threads/:id/classify', async (req) => {
    const { id } = req.params as { id: string };
    if (!threads.get(id)) throw new NotFoundError('Thread not found');
    const latest = messages.latestInboundForThread(id);
    if (!latest) throw new ValidationError('No inbound message to classify');
    deps.classificationQueue.enqueue(latest.id);
    return { data: { queued: true } };
  });
}
