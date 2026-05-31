import type Database from 'better-sqlite3-multiple-ciphers';
import type { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import type { FollowUpsRepository } from '../db/repositories/FollowUpsRepository.js';
import type { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import type { EventBus } from '../eventBus.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000;

export class FollowUpEngine {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly threads: ThreadsRepository,
    private readonly followUps: FollowUpsRepository,
    private readonly actions: ActionLogRepository,
    private readonly eventBus: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  /** Scans for SLA breaches and records a follow-up for each (deduped in SQL). Returns count created. */
  runOnce(): number {
    const at = this.now();
    const breaches = this.threads.findSlaBreaches(at);
    let created = 0;
    for (const thread of breaches) {
      try {
        const tx = this.db.transaction(() => {
          this.followUps.insert({
            threadId: thread.id,
            triggerAt: at,
            reason: 'sla_breach',
            createdAt: at,
          });
          this.actions.append({
            actor: 'system',
            action: 'followup_created',
            targetType: 'thread',
            targetId: thread.id,
            details: { reason: 'sla_breach' },
          });
        });
        tx();
        this.eventBus.emit({ type: 'thread:updated', payload: { threadId: thread.id } });
        created += 1;
      } catch (err) {
        console.error(
          `[secretary] follow-up creation failed (thread ${thread.id}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return created;
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.runOnce();
      } catch (err) {
        console.error(
          '[secretary] follow-up engine tick failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
