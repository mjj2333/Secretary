import type { RawMessage, SendInput } from '@secretary/shared-types';

export interface SyncResult {
  newMessages: RawMessage[];
  updatedMessages: RawMessage[];
  nextSyncState: Record<string, unknown>;
}

/** Provider-agnostic email backend contract (BRIEF §7). */
export interface EmailProvider {
  readonly accountId: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  syncIncremental(): Promise<SyncResult>;
  syncFull(sinceUnixMs: number): Promise<RawMessage[]>;
  startWatching(onChange: () => void): Promise<void>;
  stopWatching(): Promise<void>;
  sendMessage(input: SendInput): Promise<{ providerMessageId: string }>;
  markRead(providerMessageId: string, isRead: boolean): Promise<void>;
  moveToFolder?(providerMessageId: string, folder: string): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; details?: string }>;
}

/** Resolved IMAP/SMTP connection config (built from an account row). */
export interface ImapConfig {
  accountId: string;
  imap: { host: string; port: number; secure: boolean; rejectUnauthorized: boolean };
  smtp: { host: string; port: number; secure: boolean; rejectUnauthorized: boolean };
  auth: { user: string; pass: string };
}
