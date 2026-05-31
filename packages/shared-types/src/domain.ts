export type Provider = 'imap' | 'gmail' | 'graph';
export type MessageDirection = 'inbound' | 'outbound';
export type ThreadState =
  | 'needs_classification'
  | 'awaiting_their_reply'
  | 'awaiting_your_reply'
  | 'closed'
  | 'scheduled_followup'
  | 'informational';
export type ContactCategory =
  | 'client_established'
  | 'client_new'
  | 'screening'
  | 'personal'
  | 'vendor'
  | 'noise'
  | 'unknown';
export type Urgency = 'low' | 'normal' | 'high';

export interface EmailAddress {
  address: string;
  name?: string;
}

export interface AttachmentMeta {
  filename: string;
  size: number;
  contentType: string;
  providerId?: string;
}

/** Provider-agnostic normalized message produced by every EmailProvider. */
export interface RawMessage {
  providerId: string;
  messageIdHeader?: string;
  inReplyTo?: string;
  references: string[];
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  snippet?: string;
  direction: MessageDirection;
  dateSent?: number;
  dateReceived?: number;
  isRead: boolean;
  isStarred: boolean;
  folder: string;
  labels: string[];
  attachmentsMeta: AttachmentMeta[];
  rawSizeBytes?: number;
}

export interface SendInput {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject?: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyToMessageId?: string;
}

/** API view shapes (dates are ISO-8601 strings per BRIEF §16). */
export interface AccountView {
  id: string;
  provider: Provider;
  displayName: string;
  emailAddress: string;
  isEnabled: boolean;
  lastSyncedAt: string | null;
  syncState: string | null;
}

export interface MessageView {
  id: string;
  from: EmailAddress;
  to: EmailAddress[];
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  direction: MessageDirection;
  dateReceived: string | null;
  isRead: boolean;
}

export interface ThreadSummary {
  id: string;
  accountId: string;
  subject: string | null;
  participants: string[];
  messageCount: number;
  lastMessageAt: string | null;
  state: ThreadState;
}

export interface ThreadWithMessages extends ThreadSummary {
  messages: MessageView[];
}
