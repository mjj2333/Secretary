import type { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import type { DraftsRepository } from '../db/repositories/DraftsRepository.js';
import type { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { SettingsRepository } from '../db/repositories/SettingsRepository.js';
import type { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import type { GatewayClient } from '../llm/GatewayClient.js';
import type { EventBus } from '../eventBus.js';
import type { DraftRow } from '../db/schema.js';
import type { MiniLogger } from './Classifier.js';
import { PromptAssembler, replySubject } from './PromptAssembler.js';
import { lineDiff } from './draftDiff.js';

const DEFAULT_MODEL = 'qwen2.5:14b-instruct-q5_K_M';
const DEFAULT_DRAFT_TEMPERATURE = 0.5;
const MAX_TOKENS = 800;

/** Strips a stray leading "Subject:" line a model might add (with or without a trailing newline). */
function cleanBody(raw: string): string {
  return raw.replace(/^\s*subject:[^\n]*\n*/i, '').trim();
}

export class Drafter {
  constructor(
    private readonly prompts: PromptAssembler,
    private readonly gateway: GatewayClient | null,
    private readonly drafts: DraftsRepository,
    private readonly messages: MessagesRepository,
    private readonly threads: ThreadsRepository,
    private readonly actions: ActionLogRepository,
    private readonly eventBus: EventBus,
    private readonly settings: SettingsRepository,
    private readonly log: MiniLogger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Draft a reply for a thread's latest inbound message. Never throws (queue-safe). */
  async draft(threadId: string, opts?: { rawIntent?: string }): Promise<DraftRow | null> {
    if (!this.gateway) {
      this.log.warn({ threadId }, 'gateway not configured; skipping draft');
      return null;
    }
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    const target = this.messages.latestInboundForThread(threadId);
    if (!target) {
      this.log.warn({ threadId }, 'no inbound message to reply to; skipping draft');
      return null;
    }

    try {
      const { prompt, systemPromptUsed } = this.prompts.buildDraftPrompt(
        threadId,
        opts?.rawIntent ? { rawIntent: opts.rawIntent } : undefined,
      );
      const model = this.settings.get<string>('llm.model') ?? DEFAULT_MODEL;
      const temperature =
        this.settings.get<number>('llm.temperature.draft') ?? DEFAULT_DRAFT_TEMPERATURE;
      const res = await this.gateway.complete({
        model,
        system: systemPromptUsed,
        prompt,
        temperature,
        max_tokens: MAX_TOKENS,
      });
      const body = cleanBody(res.response);
      const rawIntent = opts?.rawIntent ?? null;
      const polishDiff = rawIntent ? lineDiff(rawIntent, body) : null;

      const id = this.drafts.insert({
        threadId,
        accountId: thread.account_id,
        version: this.drafts.nextVersion(threadId),
        inReplyToMessageId: target.id,
        to: target.from_name
          ? [{ address: target.from_address, name: target.from_name }]
          : [{ address: target.from_address }],
        cc: [],
        subject: replySubject(target.subject),
        bodyText: body,
        generatedBodyText: body,
        rawIntent,
        polishDiff,
        systemPromptUsed,
        modelUsed: res.model,
        tokensIn: res.tokens_in,
        tokensOut: res.tokens_out,
        latencyMs: res.duration_ms,
        createdAt: this.now(),
      });
      const row = this.drafts.getById(id) ?? null;
      this.actions.append({
        actor: 'agent',
        action: 'draft_created',
        targetType: 'draft',
        targetId: id,
        details: { threadId, version: row?.version, regenerate: opts !== undefined },
      });
      this.eventBus.emit({
        type: 'draft:ready',
        payload: { threadId, draftId: id, accountId: thread.account_id },
      });
      return row;
    } catch (err) {
      this.log.warn(
        { threadId, err: err instanceof Error ? err.message : 'unknown' },
        'draft generation error',
      );
      try {
        this.actions.append({
          actor: 'agent',
          action: 'draft_failed',
          targetType: 'thread',
          targetId: threadId,
        });
      } catch {
        /* audit append is best-effort; a DB failure here must not break the never-throws contract */
      }
      return null;
    }
  }
}
