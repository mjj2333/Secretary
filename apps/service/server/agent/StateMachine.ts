import {
  NotFoundError,
  type ClassificationResult,
  type ContactCategory,
  type ThreadState,
} from '@secretary/shared-types';
import type { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import type { SettingsRepository } from '../db/repositories/SettingsRepository.js';
import type { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import type { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import type { EventBus } from '../eventBus.js';
import type { MessageRow, ThreadRow } from '../db/schema.js';

const HOUR_MS = 3_600_000;
const DEFAULT_AWAITING_YOUR_REPLY_HOURS = 24;
const DEFAULT_AWAITING_THEIR_REPLY_HOURS = 72;

/** Pure: the new state for an inbound message given the previous state (BRIEF §11.1, extended). */
export function nextStateForInbound(prev: ThreadState, requiresResponse: boolean): ThreadState {
  if (requiresResponse) return 'awaiting_your_reply';
  if (prev === 'awaiting_their_reply' || prev === 'needs_classification') return 'informational';
  return prev; // awaiting_your_reply / informational / scheduled_followup / closed: unchanged
}

/** Pure: outbound always moves the thread to awaiting_their_reply. */
export function nextStateForOutbound(): ThreadState {
  return 'awaiting_their_reply';
}

export interface ClassifiedTransition {
  state: ThreadState;
  urgency: ClassificationResult['urgency'];
  slaDeadline: number | null;
}

export class StateMachine {
  constructor(
    private readonly threads: ThreadsRepository,
    private readonly contacts: ContactsRepository,
    private readonly settings: SettingsRepository,
    private readonly actions: ActionLogRepository,
    private readonly eventBus: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  /** Read-only: SLA deadline anchored to the relevant message timestamp; null for non-active states. */
  computeSlaDeadline(
    state: ThreadState,
    category: ContactCategory,
    thread: Pick<ThreadRow, 'last_inbound_at' | 'last_outbound_at'>,
  ): number | null {
    if (state === 'awaiting_your_reply') {
      const hours =
        this.settings.get<number>(`agent.sla.${category}.awaiting_your_reply_hours`) ??
        DEFAULT_AWAITING_YOUR_REPLY_HOURS;
      return (thread.last_inbound_at ?? this.now()) + hours * HOUR_MS;
    }
    if (state === 'awaiting_their_reply') {
      const hours =
        this.settings.get<number>('agent.sla.default.awaiting_their_reply_hours') ??
        DEFAULT_AWAITING_THEIR_REPLY_HOURS;
      return (thread.last_outbound_at ?? this.now()) + hours * HOUR_MS;
    }
    return null;
  }

  /** Compute (no write) the transition for a classified inbound message. */
  onInboundClassified(
    thread: ThreadRow,
    result: ClassificationResult,
    message: Pick<MessageRow, 'from_address'>,
  ): ClassifiedTransition {
    const state = nextStateForInbound(thread.state, result.requires_response);
    const category = this.contacts.findByEmail(message.from_address)?.category ?? 'unknown';
    return {
      state,
      urgency: result.urgency,
      slaDeadline: this.computeSlaDeadline(state, category, thread),
    };
  }

  /** Write: an outbound message moves the thread to awaiting_their_reply. */
  onOutbound(threadId: string): void {
    const thread = this.threads.get(threadId);
    // Thread may have been deleted mid-sync; treat as a no-op rather than crashing the pipeline.
    if (!thread) return;
    const state = nextStateForOutbound();
    const slaDeadline = this.computeSlaDeadline(state, 'unknown', thread);
    this.threads.setState(threadId, {
      state,
      slaDeadline,
      stateChangedAt: this.now(),
      stateReason: 'outbound_sent',
    });
    this.actions.append({
      actor: 'system',
      action: 'state_outbound',
      targetType: 'thread',
      targetId: threadId,
    });
    this.eventBus.emit({ type: 'thread:updated', payload: { threadId } });
  }

  /** Write: a manual state override from the user. Throws if the thread is missing. */
  onManual(threadId: string, state: ThreadState, reason?: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) throw new NotFoundError('Thread not found');
    const slaDeadline = this.computeSlaDeadline(state, 'unknown', thread);
    this.threads.setState(threadId, {
      state,
      slaDeadline,
      stateChangedAt: this.now(),
      stateReason: reason ?? 'manual_override',
    });
    this.actions.append({
      actor: 'user',
      action: 'state_override',
      targetType: 'thread',
      targetId: threadId,
      details: { state, ...(reason ? { reason } : {}) },
    });
    this.eventBus.emit({ type: 'thread:updated', payload: { threadId } });
  }
}
