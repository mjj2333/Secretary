import type Database from 'better-sqlite3-multiple-ciphers';
import type { RawMessage } from '@secretary/shared-types';
import type { EventBus } from '../eventBus.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import { resolveThreadId, normalizeSubject } from './threading.js';
import { participantsOf } from './normalize.js';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export class SyncManager {
  private readonly contacts: ContactsRepository;
  private readonly threads: ThreadsRepository;
  private readonly messages: MessagesRepository;
  private readonly actions: ActionLogRepository;

  constructor(
    private readonly db: Database.Database,
    private readonly registry: ProviderRegistry,
    private readonly eventBus: EventBus,
    private readonly now: () => number = Date.now,
  ) {
    this.contacts = new ContactsRepository(db);
    this.threads = new ThreadsRepository(db);
    this.messages = new MessagesRepository(db);
    this.actions = new ActionLogRepository(db);
  }

  /**
   * First sync for an account: connect, fetch last 90 days, persist, then watch.
   * Fire-and-forget safe: it catches its own errors (never rejects), so callers
   * can `void` it without risking an unhandled rejection that crashes the process.
   */
  async initialSync(accountId: string): Promise<void> {
    const provider = this.registry.get(accountId);
    if (!provider) return;
    try {
      await provider.connect();
      const msgs = await provider.syncFull(this.now() - NINETY_DAYS_MS);
      const changed = this.persistBatch(accountId, msgs);
      this.markSynced(accountId);
      if (changed) this.eventBus.emit({ type: 'thread:updated', payload: { accountId } });
      await provider.startWatching(() => {
        void this.incrementalSync(accountId);
      });
    } catch (err) {
      console.error(
        `[secretary] initial sync failed (${accountId}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Pull just-arrived messages and persist them. Catches its own errors (never rejects). */
  async incrementalSync(accountId: string): Promise<void> {
    const provider = this.registry.get(accountId);
    if (!provider) return;
    try {
      const { newMessages } = await provider.syncIncremental();
      const changed = this.persistBatch(accountId, newMessages);
      this.markSynced(accountId);
      if (changed) this.eventBus.emit({ type: 'thread:updated', payload: { accountId } });
    } catch (err) {
      console.error(
        `[secretary] incremental sync failed (${accountId}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Persists a batch best-effort: a single bad message is recorded in the action
   * log and skipped — it never aborts the batch (so a poison message can't break
   * the whole account's sync). Returns true if any message was newly persisted.
   */
  private persistBatch(accountId: string, msgs: RawMessage[]): boolean {
    let any = false;
    for (const raw of msgs) {
      try {
        if (this.persist(accountId, raw)) any = true;
      } catch {
        try {
          this.actions.append({
            actor: 'system',
            action: 'message_sync_failed',
            targetType: 'message',
            targetId: raw.providerId,
          });
        } catch {
          /* audit append is best-effort */
        }
      }
    }
    return any;
  }

  /**
   * Persists one new message (contact + thread + message + action log) in a
   * transaction. Skips entirely (no writes) if the message already exists, so
   * re-syncs don't double-count contacts or orphan threads. Returns whether it
   * persisted anything.
   */
  private persist(accountId: string, raw: RawMessage): boolean {
    const when = raw.dateReceived ?? raw.dateSent ?? this.now();
    let changed = false;
    const tx = this.db.transaction(() => {
      if (this.messages.existsByProviderId(accountId, raw.providerId)) return;
      this.contacts.recordSeen(raw.from, raw.direction, when);
      const candidate = {
        references: raw.references,
        ...(raw.inReplyTo ? { inReplyTo: raw.inReplyTo } : {}),
        ...(raw.subject ? { subject: raw.subject } : {}),
      };
      const threadId =
        resolveThreadId(candidate, {
          threadIdForMessageIds: (ids) => this.threads.threadIdForMessageIds(accountId, ids),
          threadIdForSubject: (s) => this.threads.threadIdForSubject(accountId, s),
        }) ??
        this.threads.create(accountId, normalizeSubject(raw.subject), participantsOf(raw), when);
      this.messages.insert(accountId, threadId, raw);
      this.threads.touch(threadId, {
        lastMessageAt: when,
        ...(raw.direction === 'inbound' ? { lastInboundAt: when } : { lastOutboundAt: when }),
      });
      this.actions.append({
        actor: 'system',
        action: 'message_synced',
        targetType: 'message',
        targetId: raw.providerId,
        details: { direction: raw.direction, folder: raw.folder },
      });
      changed = true;
    });
    tx();
    return changed;
  }

  private markSynced(accountId: string): void {
    this.db
      .prepare("UPDATE accounts SET last_synced_at = ?, sync_state = 'idle' WHERE id = ?")
      .run(this.now(), accountId);
  }
}
