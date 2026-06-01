import type { DiffOp, DraftView, EmailAddress } from '@secretary/shared-types';
import type { DraftRow, ThreadRow } from '../db/schema.js';
import type { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { ContactsRepository } from '../db/repositories/ContactsRepository.js';

export function parseAddrs(json: string | null): EmailAddress[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as EmailAddress[];
  } catch {
    return [];
  }
}

export function draftView(row: DraftRow): DraftView {
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

/** Friendly sender name: latest inbound from-address → contact display_name → from_name → email; fallback to first participant / subject / "Unknown". */
export function resolveSenderName(
  threadRow: ThreadRow,
  messages: MessagesRepository,
  contacts: ContactsRepository,
): string {
  const latest = messages.latestInboundForThread(threadRow.id);
  if (latest) {
    const contact = contacts.findByEmail(latest.from_address);
    return contact?.display_name ?? latest.from_name ?? latest.from_address;
  }
  const participants = threadRow.participants
    ? (JSON.parse(threadRow.participants) as string[])
    : [];
  return participants[0] ?? threadRow.subject_normalized ?? 'Unknown';
}
