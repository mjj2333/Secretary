import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';
import {
  ImapError,
  NotFoundError,
  ValidationError,
  type AccountView,
} from '@secretary/shared-types';
import type { SecretStore } from '../auth/SecretStore.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { SyncManager } from '../sync/SyncManager.js';
import type { EmailProvider, ImapConfig } from '../providers/ProviderInterface.js';
import type { AccountRow } from '../db/schema.js';
import { buildImapConfig } from '../providers/imapConfig.js';

const imapSchema = z.object({
  displayName: z.string().min(1),
  emailAddress: z.string().email(),
  imapHost: z.string().min(1),
  imapPort: z.number().int().positive(),
  useTls: z.boolean(),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().positive(),
  password: z.string().min(1),
});

export interface AccountsDeps {
  db: Database.Database;
  secrets: SecretStore;
  providers: ProviderRegistry;
  sync: SyncManager;
  providerFactory: (config: ImapConfig) => EmailProvider;
}

function toView(row: AccountRow): AccountView {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    emailAddress: row.email_address,
    isEnabled: row.is_enabled === 1,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    syncState: row.sync_state,
  };
}

export function registerAccountsRoutes(app: FastifyInstance, deps: AccountsDeps): void {
  app.post('/accounts/imap', async (req) => {
    const parsed = imapSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid IMAP account');
    const a = parsed.data;
    const id = randomUUID();
    const handle = `imap.${id}`;

    const account: AccountRow = {
      id,
      provider: 'imap',
      display_name: a.displayName,
      email_address: a.emailAddress,
      imap_host: a.imapHost,
      imap_port: a.imapPort,
      imap_use_tls: a.useTls ? 1 : 0,
      smtp_host: a.smtpHost,
      smtp_port: a.smtpPort,
      oauth_keychain_handle: null,
      imap_password_keychain_handle: handle,
      sync_state: 'syncing',
      is_enabled: 1,
      created_at: Date.now(),
      last_synced_at: null,
    };

    const config = buildImapConfig(account, a.emailAddress, a.password);
    const provider = deps.providerFactory(config);
    const health = await provider.healthCheck();
    if (!health.ok) throw new ImapError(health.details ?? 'IMAP connection failed');

    deps.secrets.set(handle, a.password);
    deps.db
      .prepare(
        `INSERT INTO accounts (id, provider, display_name, email_address, imap_host, imap_port,
           imap_use_tls, smtp_host, smtp_port, imap_password_keychain_handle, sync_state, is_enabled, created_at)
         VALUES (@id,@provider,@display_name,@email_address,@imap_host,@imap_port,@imap_use_tls,@smtp_host,@smtp_port,@imap_password_keychain_handle,@sync_state,@is_enabled,@created_at)`,
      )
      .run({
        id: account.id,
        provider: account.provider,
        display_name: account.display_name,
        email_address: account.email_address,
        imap_host: account.imap_host,
        imap_port: account.imap_port,
        imap_use_tls: account.imap_use_tls,
        smtp_host: account.smtp_host,
        smtp_port: account.smtp_port,
        imap_password_keychain_handle: account.imap_password_keychain_handle,
        sync_state: account.sync_state,
        is_enabled: account.is_enabled,
        created_at: account.created_at,
      });
    deps.providers.set(provider);

    // Kick off the initial sync in the background; don't block the response.
    void deps.sync.initialSync(id);
    return { data: toView(account) };
  });

  app.get('/accounts', async () => {
    const rows = deps.db
      .prepare('SELECT * FROM accounts ORDER BY created_at ASC')
      .all() as AccountRow[];
    return { data: rows.map(toView) };
  });

  app.delete('/accounts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const provider = deps.providers.get(id);
    if (provider) {
      await provider.stopWatching().catch(() => undefined);
      deps.providers.remove(id);
    }
    deps.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    deps.secrets.delete(`imap.${id}`);
    return { data: { deleted: true } };
  });

  app.post('/accounts/:id/resync', async (req) => {
    const { id } = req.params as { id: string };
    void deps.sync.initialSync(id);
    return { data: { resyncing: true } };
  });

  const sendSchema = z.object({
    to: z.array(z.object({ address: z.string().email(), name: z.string().optional() })).min(1),
    cc: z.array(z.object({ address: z.string().email(), name: z.string().optional() })).optional(),
    subject: z.string().optional(),
    bodyText: z.string().min(1),
    bodyHtml: z.string().optional(),
    inReplyToMessageId: z.string().optional(),
  });

  app.post('/accounts/:id/send', async (req) => {
    const { id } = req.params as { id: string };
    const provider = deps.providers.get(id);
    if (!provider) throw new NotFoundError('Account not connected');
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid send payload');
    const d = parsed.data;
    const toAddresses = d.to.map((a) => ({
      address: a.address,
      ...(a.name ? { name: a.name } : {}),
    }));
    const ccAddresses = d.cc?.map((a) => ({
      address: a.address,
      ...(a.name ? { name: a.name } : {}),
    }));
    const input = {
      to: toAddresses,
      bodyText: d.bodyText,
      ...(ccAddresses ? { cc: ccAddresses } : {}),
      ...(d.subject ? { subject: d.subject } : {}),
      ...(d.bodyHtml ? { bodyHtml: d.bodyHtml } : {}),
      ...(d.inReplyToMessageId ? { inReplyToMessageId: d.inReplyToMessageId } : {}),
    };
    const sent = await provider.sendMessage(input);
    return { data: { providerMessageId: sent.providerMessageId } };
  });
}
