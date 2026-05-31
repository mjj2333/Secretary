import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, ExistsEvent } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import type { AddressObject } from 'mailparser';
import type { EmailAddress, RawMessage, SendInput } from '@secretary/shared-types';
import type { EmailProvider, ImapConfig, SyncResult } from './ProviderInterface.js';
import { snippetOf } from '../sync/normalize.js';

const FOLDERS: Array<{ mailbox: string; direction: 'inbound' | 'outbound' }> = [
  { mailbox: 'INBOX', direction: 'inbound' },
  { mailbox: 'Sent', direction: 'outbound' },
];

function addrs(a: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!a) return [];
  const list = Array.isArray(a) ? a : [a];
  return list.flatMap((g) =>
    (g.value ?? [])
      .filter((v) => v.address)
      .map((v) =>
        v.name ? { address: v.address as string, name: v.name } : { address: v.address as string },
      ),
  );
}

export class ImapProvider implements EmailProvider {
  readonly accountId: string;
  private client: ImapFlow;
  private watchClient: ImapFlow | null = null;
  private shouldWatch = false;
  private reconnectDelayMs = 1000;
  private onChangeCb: (() => void) | null = null;

  constructor(private readonly config: ImapConfig) {
    this.accountId = config.accountId;
    this.client = this.newClient();
  }

  private newClient(): ImapFlow {
    const client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      auth: { user: this.config.auth.user, pass: this.config.auth.pass },
      tls: { rejectUnauthorized: this.config.imap.rejectUnauthorized },
      logger: false,
    });
    // ImapFlow is an EventEmitter — an unhandled 'error' event (socket timeout,
    // connection reset, …) would crash the whole process. Always have a listener.
    client.on('error', (err: unknown) => {
      console.error(
        `[secretary] imap error (${this.accountId}):`,
        err instanceof Error ? err.message : err,
      );
    });
    return client;
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      /* ignore */
    }
  }

  isConnected(): boolean {
    return this.client.usable;
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    const c = this.newClient();
    try {
      await c.connect();
      await c.logout();
      return { ok: true };
    } catch (err) {
      const e = err as {
        message?: string;
        responseText?: string;
        authenticationFailed?: boolean;
      };
      const detail = e.responseText ?? e.message ?? 'connection failed';
      return {
        ok: false,
        details: e.authenticationFailed ? `authentication failed: ${detail}` : detail,
      };
    }
  }

  async syncFull(sinceUnixMs: number): Promise<RawMessage[]> {
    const since = new Date(sinceUnixMs);
    const out: RawMessage[] = [];
    const seen = new Set<string>();
    for (const { mailbox, direction } of FOLDERS) {
      const lock = await this.client.getMailboxLock(mailbox).catch(() => null);
      if (!lock) continue; // folder may not exist
      try {
        for await (const msg of this.client.fetch(
          { since },
          { uid: true, flags: true, internalDate: true, size: true, source: true },
        )) {
          if (!msg.source) continue; // source not available — skip
          const raw = await this.parse(msg, msg.source, direction, mailbox);
          const dedupKey = raw.messageIdHeader ?? `${mailbox}:${raw.providerId}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          out.push(raw);
        }
      } finally {
        lock.release();
      }
    }
    return out;
  }

  async syncIncremental(): Promise<SyncResult> {
    // v1: bounded re-sync of the last 2 days; idempotent inserts dedup downstream.
    const newMessages = await this.syncFull(Date.now() - 2 * 24 * 60 * 60 * 1000);
    return { newMessages, updatedMessages: [], nextSyncState: { syncedAt: Date.now() } };
  }

  async startWatching(onChange: () => void): Promise<void> {
    this.onChangeCb = onChange;
    this.shouldWatch = true;
    this.reconnectDelayMs = 1000;
    await this.openWatchConnection();
  }

  /** Opens a dedicated IDLE connection (separate from the sync/command client so the
   *  two never stomp on each other's selected mailbox). Re-arms on disconnect. */
  private async openWatchConnection(): Promise<void> {
    if (!this.shouldWatch) return;
    const wc = this.newClient();
    this.watchClient = wc;
    wc.on('error', () => {
      /* a 'close' event follows; reconnect handled there */
    });
    wc.on('close', () => {
      if (this.watchClient === wc) this.watchClient = null;
      if (this.shouldWatch) this.scheduleReconnect();
    });
    wc.on('exists', (_data: ExistsEvent) => {
      this.onChangeCb?.();
    });
    try {
      await wc.connect();
      await wc.mailboxOpen('INBOX');
      this.reconnectDelayMs = 1000; // reset backoff after a successful connect
    } catch {
      if (this.shouldWatch) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, 60_000);
    const timer = setTimeout(() => {
      void this.openWatchConnection();
    }, delay);
    timer.unref();
  }

  async stopWatching(): Promise<void> {
    this.shouldWatch = false;
    const wc = this.watchClient;
    this.watchClient = null;
    if (wc) await wc.logout().catch(() => undefined);
  }

  async sendMessage(input: SendInput): Promise<{ providerMessageId: string }> {
    const transport = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: { user: this.config.auth.user, pass: this.config.auth.pass },
      tls: { rejectUnauthorized: this.config.smtp.rejectUnauthorized },
    });
    try {
      const info = await transport.sendMail({
        from: this.config.auth.user,
        to: input.to.map((a) => a.address),
        cc: input.cc?.map((a) => a.address),
        bcc: input.bcc?.map((a) => a.address),
        subject: input.subject ?? '',
        text: input.bodyText,
        ...(input.bodyHtml ? { html: input.bodyHtml } : {}),
        ...(input.inReplyToMessageId
          ? { inReplyTo: input.inReplyToMessageId, references: input.inReplyToMessageId }
          : {}),
      });
      return { providerMessageId: info.messageId };
    } finally {
      transport.close();
    }
  }

  async markRead(providerMessageId: string, isRead: boolean): Promise<void> {
    const lock = await this.client.getMailboxLock('INBOX');
    try {
      const flags = ['\\Seen'];
      if (isRead) await this.client.messageFlagsAdd(providerMessageId, flags, { uid: true });
      else await this.client.messageFlagsRemove(providerMessageId, flags, { uid: true });
    } finally {
      lock.release();
    }
  }

  private async parse(
    msg: FetchMessageObject,
    source: Buffer,
    direction: 'inbound' | 'outbound',
    folder: string,
  ): Promise<RawMessage> {
    const p = await simpleParser(source);
    const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
    const flags = msg.flags ?? new Set<string>();
    const from = addrs(p.from)[0] ?? { address: 'unknown@unknown' };
    const text = p.text ?? undefined;
    // internalDate may be Date or string
    const dateRaw = msg.internalDate;
    const dateMs =
      dateRaw instanceof Date
        ? dateRaw.getTime()
        : typeof dateRaw === 'string'
          ? new Date(dateRaw).getTime()
          : undefined;
    return {
      providerId: String(msg.uid),
      ...(p.messageId ? { messageIdHeader: p.messageId } : {}),
      ...(p.inReplyTo ? { inReplyTo: p.inReplyTo } : {}),
      references: refs,
      from,
      to: addrs(p.to),
      cc: addrs(p.cc),
      bcc: addrs(p.bcc),
      ...(p.subject ? { subject: p.subject } : {}),
      ...(text ? { bodyText: text } : {}),
      ...(typeof p.html === 'string' ? { bodyHtml: p.html } : {}),
      snippet: snippetOf(text),
      direction,
      ...(p.date ? { dateSent: p.date.getTime(), dateReceived: p.date.getTime() } : {}),
      ...(dateMs !== undefined ? { dateReceived: dateMs } : {}),
      isRead: flags.has('\\Seen'),
      isStarred: flags.has('\\Flagged'),
      folder,
      labels: [folder],
      attachmentsMeta: (p.attachments ?? []).map((a) => ({
        filename: a.filename ?? 'attachment',
        size: a.size,
        contentType: a.contentType,
      })),
      ...(msg.size ? { rawSizeBytes: msg.size } : {}),
    };
  }
}
