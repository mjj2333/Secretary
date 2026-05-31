import { ImapError } from '@secretary/shared-types';
import type { AccountRow } from '../db/schema.js';
import type { ImapConfig } from './ProviderInterface.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

/** Resolves an account row + password into a connection config. Loopback hosts
 * (Proton Bridge) use a non-secure/STARTTLS socket and accept the self-signed cert. */
export function buildImapConfig(account: AccountRow, user: string, pass: string): ImapConfig {
  if (!account.imap_host || account.imap_port === null) {
    throw new ImapError('IMAP host/port not configured');
  }
  const loop = isLoopback(account.imap_host);
  const smtpHost = account.smtp_host ?? account.imap_host;
  const smtpPort = account.smtp_port ?? 587;
  return {
    accountId: account.id,
    imap: {
      host: account.imap_host,
      port: account.imap_port,
      secure: account.imap_use_tls === 1,
      rejectUnauthorized: !loop,
    },
    smtp: {
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      rejectUnauthorized: !isLoopback(smtpHost),
    },
    auth: { user, pass },
  };
}
