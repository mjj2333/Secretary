import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';
import { NotFoundError, ValidationError, type ContactView } from '@secretary/shared-types';
import { ContactsRepository, type ContactPatch } from '../db/repositories/ContactsRepository.js';
import { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import type { ContactRow } from '../db/schema.js';

const CONTACT_CATEGORIES = [
  'client_established',
  'client_new',
  'screening',
  'personal',
  'vendor',
  'noise',
  'unknown',
] as const;

const patchSchema = z
  .object({
    category: z.enum(CONTACT_CATEGORIES).optional(),
    notes: z.string().optional(),
    styleNotes: z.unknown().optional(),
    doNotAutoDraft: z.boolean().optional(),
  })
  .strict();

function contactView(row: ContactRow): ContactView {
  return {
    id: row.id,
    emailAddress: row.email_address,
    displayName: row.display_name,
    category: row.category,
    notes: row.notes,
    doNotAutoDraft: row.do_not_auto_draft === 1,
    totalMessagesIn: row.total_messages_in,
    totalMessagesOut: row.total_messages_out,
    lastContactAt: row.last_contact_at ? new Date(row.last_contact_at).toISOString() : null,
  };
}

export function registerContactsRoutes(
  app: FastifyInstance,
  deps: { db: Database.Database },
): void {
  const contacts = new ContactsRepository(deps.db);
  const actions = new ActionLogRepository(deps.db);

  app.get('/contacts', async (req) => {
    const q = req.query as { category?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit ?? '50'), 200);
    const offset = Number(q.offset ?? '0');
    const isCategory = (v: string | undefined): v is (typeof CONTACT_CATEGORIES)[number] =>
      v !== undefined && (CONTACT_CATEGORIES as readonly string[]).includes(v);
    const rows = contacts.list({
      ...(isCategory(q.category) ? { category: q.category } : {}),
      limit,
      offset,
    });
    return { data: rows.map(contactView) };
  });

  app.get('/contacts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = contacts.getById(id);
    if (!row) throw new NotFoundError('Contact not found');
    return { data: contactView(row) };
  });

  app.patch('/contacts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid contact patch');

    // Build the patch from only the provided keys (zod omits absent optionals), so the
    // object satisfies ContactPatch under exactOptionalPropertyTypes without an `any` cast.
    const patch: ContactPatch = {};
    if (parsed.data.category !== undefined) patch.category = parsed.data.category;
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
    if (parsed.data.styleNotes !== undefined) patch.styleNotes = parsed.data.styleNotes;
    if (parsed.data.doNotAutoDraft !== undefined) patch.doNotAutoDraft = parsed.data.doNotAutoDraft;

    // contacts.patch returns the updated row via getById; undefined => the contact doesn't exist.
    const updated = contacts.patch(id, patch);
    if (!updated) throw new NotFoundError('Contact not found');
    actions.append({
      actor: 'user',
      action: 'contact_updated',
      targetType: 'contact',
      targetId: id,
      details: { fields: Object.keys(parsed.data) },
    });
    return { data: contactView(updated) };
  });
}
