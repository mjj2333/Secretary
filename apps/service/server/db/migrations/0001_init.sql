CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('imap','gmail','graph')),
  display_name TEXT NOT NULL,
  email_address TEXT NOT NULL,
  imap_host TEXT,
  imap_port INTEGER,
  imap_use_tls INTEGER,
  smtp_host TEXT,
  smtp_port INTEGER,
  oauth_keychain_handle TEXT,
  imap_password_keychain_handle TEXT,
  sync_state TEXT,
  is_enabled INTEGER DEFAULT 1,
  created_at INTEGER,
  last_synced_at INTEGER
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_thread_id TEXT,
  subject_normalized TEXT,
  participants TEXT,
  message_count INTEGER DEFAULT 0,
  first_message_at INTEGER,
  last_message_at INTEGER,
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  state TEXT NOT NULL DEFAULT 'needs_classification'
    CHECK (state IN ('needs_classification','awaiting_their_reply','awaiting_your_reply','closed','scheduled_followup','informational')),
  state_changed_at INTEGER,
  state_reason TEXT,
  sla_deadline INTEGER,
  urgency TEXT CHECK (urgency IN ('low','normal','high')),
  last_agent_summary TEXT,
  is_archived INTEGER DEFAULT 0
);
CREATE INDEX idx_threads_state_sla ON threads (state, sla_deadline);
CREATE INDEX idx_threads_last_inbound ON threads (last_inbound_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  message_id_header TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_addresses TEXT,
  cc_addresses TEXT,
  bcc_addresses TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  snippet TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  date_sent INTEGER,
  date_received INTEGER,
  is_read INTEGER,
  is_starred INTEGER,
  is_draft INTEGER,
  folder TEXT,
  labels TEXT,
  attachments_meta TEXT,
  raw_size_bytes INTEGER,
  synced_at INTEGER,
  UNIQUE (account_id, provider_id)
);
CREATE INDEX idx_messages_thread ON messages (thread_id, date_received);
CREATE INDEX idx_messages_account_date ON messages (account_id, date_received DESC);
CREATE INDEX idx_messages_from ON messages (from_address);
CREATE INDEX idx_messages_msgid ON messages (message_id_header);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  email_address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  aliases TEXT,
  category TEXT NOT NULL DEFAULT 'unknown'
    CHECK (category IN ('client_established','client_new','screening','personal','vendor','noise','unknown')),
  notes TEXT,
  first_contact_at INTEGER,
  last_contact_at INTEGER,
  total_messages_in INTEGER DEFAULT 0,
  total_messages_out INTEGER DEFAULT 0,
  style_notes TEXT,
  do_not_auto_draft INTEGER DEFAULT 0,
  screening_status TEXT
    CHECK (screening_status IN ('never_screened','screening_in_progress','cleared','rejected') OR screening_status IS NULL),
  booking_history TEXT
);
CREATE INDEX idx_contacts_category ON contacts (category);
CREATE INDEX idx_contacts_last_contact ON contacts (last_contact_at DESC);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  in_reply_to_message_id TEXT REFERENCES messages(id),
  to_addresses TEXT,
  cc_addresses TEXT,
  subject TEXT,
  body_text TEXT NOT NULL,
  body_html TEXT,
  raw_intent TEXT,
  polish_diff TEXT,
  system_prompt_used TEXT,
  model_used TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  latency_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','editing','sent','discarded','failed')),
  created_at INTEGER,
  sent_at INTEGER,
  final_body_sent TEXT
);
CREATE INDEX idx_drafts_thread_version ON drafts (thread_id, version);
CREATE INDEX idx_drafts_status_created ON drafts (status, created_at);

CREATE TABLE follow_ups (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  trigger_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('sla_breach','scheduled_reminder','awaiting_response','manual_pin')),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','surfaced','dismissed','resolved')),
  created_at INTEGER,
  surfaced_at INTEGER,
  resolved_at INTEGER
);
CREATE INDEX idx_followups_status_trigger ON follow_ups (status, trigger_at);

CREATE TABLE action_log (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('agent','user','system')),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT
);
CREATE INDEX idx_action_log_time ON action_log (timestamp DESC);
CREATE INDEX idx_action_log_target ON action_log (target_type, target_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER,
  last_used_at INTEGER
);

CREATE TABLE style_examples (
  id TEXT PRIMARY KEY,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  contact_category TEXT,
  context_summary TEXT,
  reply_text TEXT,
  tags TEXT,
  embedding BLOB
);
CREATE INDEX idx_style_examples_category ON style_examples (contact_category);
