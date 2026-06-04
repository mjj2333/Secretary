import { z } from 'zod';
import type { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import type { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { SettingsRepository } from '../db/repositories/SettingsRepository.js';
import type { StyleExamplesRepository } from '../db/repositories/StyleExamplesRepository.js';
import type { GatewayClient } from '../llm/GatewayClient.js';
import type { EventBus } from '../eventBus.js';
import type { MessageRow } from '../db/schema.js';
import type { MiniLogger } from './Classifier.js';
import type { MiningJob } from './MiningJob.js';
import type { PromptAssembler } from './PromptAssembler.js';

const DEFAULT_MODEL = 'qwen2.5:14b-instruct-q5_K_M';
const MINING_TEMPERATURE = 0.2;
const MINING_MAX_TOKENS = 200;

const miningResultSchema = z.object({
  context_summary: z.string(),
  tags: z.array(z.string()),
});

/** Extracts the first balanced {...} JSON object from a (possibly chatty) model response.
 *  String-aware: braces inside double-quoted string values are ignored. */
function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function firstRecipient(json: string | null): string | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json) as Array<{ address?: string }>;
    return arr[0]?.address ?? null;
  } catch {
    return null;
  }
}

/** Mines one sent outbound message into a pending style example. Never throws (queue-safe). */
export class SentMailMiner {
  constructor(
    private readonly prompts: PromptAssembler,
    private readonly gateway: GatewayClient | null,
    private readonly messages: MessagesRepository,
    private readonly contacts: ContactsRepository,
    private readonly styleExamples: StyleExamplesRepository,
    private readonly miningJob: MiningJob,
    private readonly eventBus: EventBus,
    private readonly log: MiniLogger,
    private readonly settings: SettingsRepository,
  ) {}

  async mine(messageId: string): Promise<void> {
    if (!this.gateway) return;
    try {
      const msg = this.messages.getById(messageId);
      if (
        !msg ||
        msg.direction !== 'outbound' ||
        !msg.body_text ||
        msg.body_text.trim() === '' ||
        msg.is_draft === 1
      ) {
        return;
      }
      if (this.styleExamples.existsForMessage(messageId)) return;

      const inbound = this.messages.latestInboundForThread(msg.thread_id);
      const category = this.resolveCategory(msg, inbound);
      const inboundContext = inbound ? (inbound.body_text ?? inbound.snippet ?? null) : null;

      const { system, prompt } = this.prompts.buildMiningPrompt({
        subject: msg.subject,
        sentReply: msg.body_text,
        inboundContext,
      });
      const model = this.settings.get<string>('llm.model') ?? DEFAULT_MODEL;
      const res = await this.gateway.complete({
        model,
        system,
        prompt,
        temperature: MINING_TEMPERATURE,
        max_tokens: MINING_MAX_TOKENS,
      });
      const parsed = miningResultSchema.safeParse(extractJson(res.response));
      if (!parsed.success) {
        this.log.warn({ messageId }, 'mining: could not parse extraction; skipping');
        return;
      }
      this.styleExamples.insertPending({
        sourceMessageId: messageId,
        contactCategory: category,
        contextSummary: parsed.data.context_summary,
        replyText: msg.body_text.trim(),
        tags: JSON.stringify(parsed.data.tags),
      });
    } catch (err) {
      this.log.warn(
        { messageId, err: err instanceof Error ? err.message : 'unknown' },
        'mining error',
      );
    } finally {
      this.miningJob.tick();
      const { done, total } = this.miningJob.snapshot();
      this.eventBus.emit({ type: 'mining:progress', payload: { done, total } });
    }
  }

  private resolveCategory(msg: MessageRow, inbound: MessageRow | undefined): string {
    if (inbound) return this.contacts.findByEmail(inbound.from_address)?.category ?? 'unknown';
    const addr = firstRecipient(msg.to_addresses);
    if (addr) return this.contacts.findByEmail(addr)?.category ?? 'unknown';
    return 'unknown';
  }
}
