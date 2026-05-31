import { describe, expect, it } from 'vitest';
import { buildImapConfig } from '../server/providers/imapConfig.js';
import type { AccountRow } from '../server/db/schema.js';

const base: AccountRow = {
  id: 'acc1',
  provider: 'imap',
  display_name: 'A',
  email_address: 'me@example.com',
  imap_host: 'imap.gmail.com',
  imap_port: 993,
  imap_use_tls: 1,
  smtp_host: 'smtp.gmail.com',
  smtp_port: 465,
  oauth_keychain_handle: null,
  imap_password_keychain_handle: 'imap.acc1',
  sync_state: null,
  is_enabled: 1,
  created_at: 0,
  last_synced_at: null,
};

describe('buildImapConfig', () => {
  it('uses secure TLS + verification for a remote host', () => {
    const cfg = buildImapConfig(base, 'me@example.com', 'pw');
    expect(cfg.imap.secure).toBe(true);
    expect(cfg.imap.rejectUnauthorized).toBe(true);
  });

  it('allows self-signed for a loopback host (Proton Bridge)', () => {
    const cfg = buildImapConfig(
      {
        ...base,
        imap_host: '127.0.0.1',
        imap_port: 1143,
        imap_use_tls: 0,
        smtp_host: '127.0.0.1',
        smtp_port: 1025,
      },
      'me@example.com',
      'pw',
    );
    expect(cfg.imap.secure).toBe(false);
    expect(cfg.imap.rejectUnauthorized).toBe(false);
  });
});
