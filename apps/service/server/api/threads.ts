import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import {
  NotFoundError,
  type EmailAddress,
  type MessageView,
  type ThreadSummary,
  type ThreadWithMessages,
} from '@secretary/shared-types';
import { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { MessageRow, ThreadRow } from '../db/schema.js';

function parseAddrs(json: string | null): EmailAddress[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as EmailAddress[];
  } catch {
    return [];
  }
}

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

export function registerThreadsRoutes(app: FastifyInstance, deps: { db: Database.Database }): void {
  const threads = new ThreadsRepository(deps.db);
  const messages = new MessagesRepository(deps.db);

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
    const view: ThreadWithMessages = {
      ...threadSummary(row),
      messages: messages.listByThread(id).map(messageView),
    };
    return { data: view };
  });
}
