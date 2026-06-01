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

export type DraftStatus = 'pending_review' | 'editing' | 'sent' | 'discarded' | 'failed';

/** One line of a raw-intent → polished-body diff (BRIEF §6 polish_diff). */
export interface DiffOp {
  op: 'eq' | 'add' | 'del';
  line: string;
}

/** A draft as returned by the drafts API (ISO dates per §16). */
export interface DraftView {
  id: string;
  threadId: string;
  accountId: string;
  version: number;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string | null;
  bodyText: string;
  rawIntent: string | null;
  polishDiff: DiffOp[] | null;
  status: DraftStatus;
  modelUsed: string | null;
  createdAt: string | null;
  sentAt: string | null;
}

export interface ThreadWithMessages extends ThreadSummary {
  senderName: string;
  messages: MessageView[];
  currentDraft: DraftView | null;
}

export type ClassificationIntent =
  | 'inquiry'
  | 'booking_request'
  | 'scheduling'
  | 'chitchat'
  | 'question'
  | 'complaint'
  | 'other';

/** The validated result of classifying one inbound message (BRIEF §11). */
export interface ClassificationResult {
  intent: ClassificationIntent;
  category_suggestion: ContactCategory;
  urgency: Urgency;
  requires_response: boolean;
  summary: string;
}

/** A row on the Needs Attention screen (BRIEF §9 / §12). */
export interface NeedsAttentionItem extends ThreadSummary {
  senderName: string;
  hasDraft: boolean;
  urgency: Urgency | null;
  slaDeadline: string | null;
  summary: string | null;
  hasPendingFollowUp: boolean;
}

/** Contact as returned by the contacts API (ISO dates per §16). */
export interface ContactView {
  id: string;
  emailAddress: string;
  displayName: string | null;
  category: ContactCategory;
  notes: string | null;
  doNotAutoDraft: boolean;
  totalMessagesIn: number;
  totalMessagesOut: number;
  lastContactAt: string | null;
}
