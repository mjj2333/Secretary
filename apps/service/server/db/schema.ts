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

export interface ThreadRow {
  id: string;
  account_id: string;
  provider_thread_id: string | null;
  subject_normalized: string | null;
  participants: string | null;
  message_count: number;
  first_message_at: number | null;
  last_message_at: number | null;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  state:
    | 'needs_classification'
    | 'awaiting_their_reply'
    | 'awaiting_your_reply'
    | 'closed'
    | 'scheduled_followup'
    | 'informational';
  state_changed_at: number | null;
  state_reason: string | null;
  sla_deadline: number | null;
  urgency: 'low' | 'normal' | 'high' | null;
  last_agent_summary: string | null;
  is_archived: number;
}

export interface MessageRow {
  id: string;
  account_id: string;
  provider_id: string;
  thread_id: string;
  message_id_header: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  from_address: string;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  snippet: string | null;
  direction: 'inbound' | 'outbound';
  date_sent: number | null;
  date_received: number | null;
  is_read: number | null;
  is_starred: number | null;
  is_draft: number | null;
  folder: string | null;
  labels: string | null;
  attachments_meta: string | null;
  raw_size_bytes: number | null;
  synced_at: number | null;
}

export interface ContactRow {
  id: string;
  email_address: string;
  display_name: string | null;
  aliases: string | null;
  category:
    | 'client_established'
    | 'client_new'
    | 'screening'
    | 'personal'
    | 'vendor'
    | 'noise'
    | 'unknown';
  notes: string | null;
  first_contact_at: number | null;
  last_contact_at: number | null;
  total_messages_in: number;
  total_messages_out: number;
  style_notes: string | null;
  do_not_auto_draft: number;
  screening_status: string | null;
  booking_history: string | null;
}

export interface ActionLogRow {
  id: string;
  timestamp: number;
  actor: 'agent' | 'user' | 'system';
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
}

export interface FollowUpRow {
  id: string;
  thread_id: string;
  trigger_at: number;
  reason: 'sla_breach' | 'scheduled_reminder' | 'awaiting_response' | 'manual_pin';
  description: string | null;
  status: 'pending' | 'surfaced' | 'dismissed' | 'resolved';
  created_at: number | null;
  surfaced_at: number | null;
  resolved_at: number | null;
}

export interface DraftRow {
  id: string;
  thread_id: string;
  account_id: string;
  version: number;
  in_reply_to_message_id: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  subject: string | null;
  body_text: string;
  body_html: string | null;
  raw_intent: string | null;
  polish_diff: string | null;
  system_prompt_used: string | null;
  model_used: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  status: 'pending_review' | 'editing' | 'sent' | 'discarded' | 'failed';
  created_at: number | null;
  sent_at: number | null;
  final_body_sent: string | null;
}

export interface StyleExampleRow {
  id: string;
  source_message_id: string | null;
  contact_category: string | null;
  context_summary: string | null;
  reply_text: string | null;
  tags: string | null;
  embedding: Buffer | null;
}
