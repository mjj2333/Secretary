import type Database from 'better-sqlite3-multiple-ciphers';
import type { RawMessage } from '@secretary/shared-types';
import type { EventBus } from '../eventBus.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import { SettingsRepository } from '../db/repositories/SettingsRepository.js';
import { resolveThreadId, normalizeSubject } from './threading.js';
import { participantsOf } from './normalize.js';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/** Side-effects fired after a thread's newest message is persisted. */
export interface SyncHooks {
  enqueueClassification(messageId: string): void;
  onOutbound(threadId: string): void;
}

const NOOP_HOOKS: SyncHooks = {
  enqueueClassification() {},
  onOutbound() {},
};

export class SyncManager {
  private readonly contacts: ContactsRepository;
  private readonly threads: ThreadsRepository;
  private readonly messages: MessagesRepository;
  private readonly actions: ActionLogRepository;
  private readonly settings: SettingsRepository;

  constructor(
    private readonly db: Database.Database,
    private readonly registry: ProviderRegistry,
    private readonly eventBus: EventBus,
    private readonly now: () => number = Date.now,
    private readonly hooks: SyncHooks = NOOP_HOOKS,
  ) {
    this.contacts = new ContactsRepository(db);
    this.threads = new ThreadsRepository(db);
    this.messages = new MessagesRepository(db);
    this.actions = new ActionLogRepository(db);
    this.settings = new SettingsRepository(db);
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
   * Persists a batch best-effort (a poison message is logged and skipped), in
   * chronological order so thread aggregates settle correctly, then routes each
   * touched thread by its newest message to the right side-effect.
   */
  private persistBatch(accountId: string, msgs: RawMessage[]): boolean {
    const sorted = [...msgs].sort(
      (a, b) => (a.dateReceived ?? a.dateSent ?? 0) - (b.dateReceived ?? b.dateSent ?? 0),
    );
    const touched = new Set<string>();
    let any = false;
    for (const raw of sorted) {
      try {
        const threadId = this.persist(accountId, raw);
        if (threadId) {
          any = true;
          touched.add(threadId);
        }
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
    for (const threadId of touched) {
      // Routing fires the agent hooks (classify enqueue / outbound state change). A throw here
      // must not abort the batch's markSynced/emit — isolate it per thread (fire-and-forget contract).
      try {
        this.route(threadId);
      } catch (err) {
        console.error(
          `[secretary] post-sync routing failed (thread ${threadId}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return any;
  }

  /** Routes the thread by its newest message: outbound -> state change; inbound -> classify. */
  private route(threadId: string): void {
    const latest = this.messages.latestForThread(threadId);
    if (!latest) return;
    if (latest.direction === 'outbound') {
      this.hooks.onOutbound(threadId);
      return;
    }
    if (this.settings.get<boolean>('agent.classify_on_inbound') !== false) {
      this.hooks.enqueueClassification(latest.id);
    }
  }

  /**
   * Persists one new message in a transaction. Skips entirely if it already
   * exists. Returns the thread id it was persisted into, or null if nothing changed.
   */
  private persist(accountId: string, raw: RawMessage): string | null {
    const when = raw.dateReceived ?? raw.dateSent ?? this.now();
    let result: string | null = null;
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
      result = threadId;
    });
    tx();
    return result;
  }

  private markSynced(accountId: string): void {
    this.db
      .prepare("UPDATE accounts SET last_synced_at = ?, sync_state = 'idle' WHERE id = ?")
      .run(this.now(), accountId);
  }
}
