/** Row types mirror the SQLite schema. Booleans are stored as INTEGER 0/1. */
export interface AccountRow {
  id: string;
  provider: 'imap' | 'gmail' | 'graph';
  display_name: string;
  email_address: string;
  imap_host: string | null;
  imap_port: number | null;
  imap_use_tls: number | null;
  smtp_host: string | null;
  smtp_port: number | null;
  oauth_keychain_handle: string | null;
  imap_password_keychain_handle: string | null;
  sync_state: string | null;
  is_enabled: number;
  created_at: number | null;
  last_synced_at: number | null;
}

export interface SettingRow {
  key: string;
  value: string | null;
  updated_at: number | null;
}

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  user_agent: string | null;
  created_at: number | null;
  last_used_at: number | null;
}

/**
 * Remaining table row types (threads, messages, contacts, drafts, follow_ups,
 * action_log, style_examples) are added in the phases whose repositories consume
 * them (Phases 3–6), to avoid unused declarations now.
 */
