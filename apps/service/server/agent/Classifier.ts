import type { ClassificationResult } from '@secretary/shared-types';
import type { GatewayClient } from '../llm/GatewayClient.js';
import type { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import type { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import type { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { SettingsRepository } from '../db/repositories/SettingsRepository.js';
import type { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import type { EventBus } from '../eventBus.js';
import type { StateMachine } from './StateMachine.js';
import type { PromptAssembler } from './PromptAssembler.js';
import {
  CLASSIFICATION_JSON_SCHEMA,
  STRICT_JSON_PREAMBLE,
  parseClassification,
} from './classificationSchema.js';

const DEFAULT_MODEL = 'qwen2.5:14b-instruct-q5_K_M';
const DEFAULT_CLASSIFY_TEMPERATURE = 0.1;
const MAX_TOKENS = 300;

/** Minimal logger surface (pino satisfies this structurally). */
export interface MiniLogger {
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
}

export class Classifier {
  constructor(
    private readonly prompts: PromptAssembler,
    private readonly gateway: GatewayClient | null,
    private readonly stateMachine: StateMachine,
    private readonly threads: ThreadsRepository,
    private readonly messages: MessagesRepository,
    private readonly actions: ActionLogRepository,
    private readonly eventBus: EventBus,
    private readonly settings: SettingsRepository,
    private readonly contacts: ContactsRepository,
    private readonly log: MiniLogger,
    private readonly now: () => number = Date.now,
    private readonly onDraftEligible?: (threadId: string) => void,
  ) {}

  /** Classify one inbound message. Never throws — safe to drive from the queue. */
  async classify(messageId: string): Promise<void> {
    const message = this.messages.getById(messageId);
    if (!message) return;
    const threadId = message.thread_id;

    if (!this.gateway) {
      this.log.warn({ threadId }, 'gateway not configured; leaving thread needs_classification');
      return;
    }

    try {
      const { system, prompt } = this.prompts.buildClassificationPrompt(messageId);
      const model = this.settings.get<string>('llm.model') ?? DEFAULT_MODEL;
      const temperature =
        this.settings.get<number>('llm.temperature.classify') ?? DEFAULT_CLASSIFY_TEMPERATURE;

      let result = await this.attempt(this.gateway, model, system, prompt, temperature);
      if (!result) {
        result = await this.attempt(
          this.gateway,
          model,
          `${STRICT_JSON_PREAMBLE}\n\n${system}`,
          prompt,
          temperature,
        );
      }
      if (!result) {
        this.markFailed(threadId);
        return;
      }

      const thread = this.threads.get(threadId);
      if (!thread) return;
      const { state, urgency, slaDeadline } = this.stateMachine.onInboundClassified(
        thread,
        result,
        message,
      );
      this.threads.applyClassification(threadId, {
        state,
        urgency,
        summary: result.summary,
        slaDeadline,
        stateChangedAt: this.now(),
        stateReason: 'classified',
      });
      this.actions.append({
        actor: 'agent',
        action: 'classified',
        targetType: 'thread',
        targetId: threadId,
        details: {
          intent: result.intent,
          urgency: result.urgency,
          requires_response: result.requires_response,
          category_suggestion: result.category_suggestion,
        },
      });
      this.eventBus.emit({
        type: 'thread:updated',
        payload: { threadId, accountId: message.account_id },
      });
      // Auto-draft eligibility is isolated: a fault here (settings/contacts read, or a throwing
      // hook) must never turn an already-successful classification into a classification_failed.
      if (result.requires_response && this.onDraftEligible) {
        try {
          if (this.settings.get<boolean>('agent.autodraft_on_inbound') === true) {
            const contact = this.contacts.findByEmail(message.from_address);
            if (contact?.do_not_auto_draft !== 1) {
              this.onDraftEligible(threadId);
            }
          }
        } catch (hookErr) {
          this.log.warn(
            { threadId, err: hookErr instanceof Error ? hookErr.message : 'unknown' },
            'auto-draft eligibility check failed; skipping hook',
          );
        }
      }
    } catch (err) {
      this.log.warn(
        { threadId, err: err instanceof Error ? err.message : 'unknown' },
        'classification error',
      );
      this.markFailed(threadId);
    }
  }

  private async attempt(
    gateway: GatewayClient,
    model: string,
    system: string,
    prompt: string,
    temperature: number,
  ): Promise<ClassificationResult | null> {
    const res = await gateway.complete({
      model,
      system,
      prompt,
      temperature,
      format: 'json',
      json_schema: CLASSIFICATION_JSON_SCHEMA as Record<string, unknown>,
      max_tokens: MAX_TOKENS,
    });
    return parseClassification(res.response);
  }

  /** Leaves the thread in its current state (needs_classification for a fresh thread) and records the failure. */
  private markFailed(threadId: string): void {
    this.actions.append({
      actor: 'agent',
      action: 'classification_failed',
      targetType: 'thread',
      targetId: threadId,
    });
    this.eventBus.emit({ type: 'thread:updated', payload: { threadId } });
  }
}
