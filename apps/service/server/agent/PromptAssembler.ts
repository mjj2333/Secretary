import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotFoundError, ValidationError, type ContactCategory } from '@secretary/shared-types';
import type { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import type { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { SettingsRepository } from '../db/repositories/SettingsRepository.js';
import type { StyleExamplesRepository } from '../db/repositories/StyleExamplesRepository.js';
import type { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import { resolveVoiceGuide } from './voiceGuide.js';

const CONTACT_NOTES_MAX = 500;
const SNIPPET_MAX = 200;
const BODY_MAX = 2000;
const DRAFT_BODY_MAX = 4000;
const CONTEXT_MESSAGES = 3;
const FEW_SHOT = 3;

const here = dirname(fileURLToPath(import.meta.url));

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…[truncated]`;
}

const TONE: Record<ContactCategory, string> = {
  client_established: 'warm and professional',
  client_new: 'warm, professional, and welcoming',
  screening: 'polite, brief, and a little cautious',
  personal: 'casual and friendly',
  vendor: 'brief and professional',
  noise: 'brief and professional',
  unknown: 'warm and professional',
};

export class PromptAssembler {
  private classifierSystem: string | null = null;
  private drafterSystem: string | null = null;

  constructor(
    private readonly messages: MessagesRepository,
    private readonly threads: ThreadsRepository,
    private readonly contacts: ContactsRepository,
    private readonly settings: SettingsRepository,
    private readonly styleExamples: StyleExamplesRepository,
    private readonly promptsDir: string = join(here, '..', 'prompts'),
  ) {}

  private classifierSystemPrompt(): string {
    if (this.classifierSystem === null) {
      this.classifierSystem = readFileSync(join(this.promptsDir, 'classifier.md'), 'utf8');
    }
    return this.classifierSystem;
  }

  private drafterSystemPrompt(): string {
    if (this.drafterSystem === null) {
      this.drafterSystem = readFileSync(join(this.promptsDir, 'drafter.md'), 'utf8');
    }
    return this.drafterSystem;
  }

  private voiceGuide(): string {
    return resolveVoiceGuide(this.settings, this.promptsDir).styleGuide;
  }

  buildClassificationPrompt(messageId: string): { system: string; prompt: string } {
    const message = this.messages.getById(messageId);
    if (!message) throw new NotFoundError('Message not found');
    const contact = this.contacts.findByEmail(message.from_address);
    const prior = this.messages
      .listByThread(message.thread_id)
      .filter((m) => m.id !== messageId)
      .slice(-CONTEXT_MESSAGES);

    const lines: string[] = [];
    lines.push('## Contact');
    lines.push(`Name: ${contact?.display_name ?? message.from_name ?? message.from_address}`);
    lines.push(`Category: ${contact?.category ?? 'unknown'}`);
    if (contact?.notes) lines.push(`Notes: ${truncate(contact.notes, CONTACT_NOTES_MAX)}`);
    lines.push('');

    if (prior.length > 0) {
      lines.push('## Recent thread context (chronological)');
      for (const m of prior) {
        // snippet is already ≤200 chars from the insert path; body_text is the fallback when absent.
        const body = truncate(m.snippet ?? m.body_text ?? '', SNIPPET_MAX);
        lines.push(`- ${m.direction} · ${m.from_address} · ${body}`);
      }
      lines.push('');
    }

    lines.push('## New message');
    lines.push(`Subject: ${message.subject ?? '(no subject)'}`);
    lines.push('Body:');
    lines.push(truncate(message.body_text ?? '', BODY_MAX));
    lines.push('');
    lines.push(
      'Return ONLY a JSON object with keys: intent, category_suggestion, urgency, requires_response, summary.',
    );

    return { system: this.classifierSystemPrompt(), prompt: lines.join('\n') };
  }

  buildDraftPrompt(
    threadId: string,
    opts?: { rawIntent?: string },
  ): { system: string; prompt: string; systemPromptUsed: string } {
    const thread = this.threads.get(threadId);
    if (!thread) throw new NotFoundError('Thread not found');
    const target = this.messages.latestInboundForThread(threadId);
    if (!target) throw new ValidationError('No inbound message to reply to');
    const contact = this.contacts.findByEmail(target.from_address);
    const category: ContactCategory = contact?.category ?? 'unknown';
    const system = `${this.drafterSystemPrompt()}\n\n${this.voiceGuide()}`;

    const lines: string[] = [];
    lines.push('## Contact');
    lines.push(`Name: ${contact?.display_name ?? target.from_name ?? target.from_address}`);
    lines.push(`Category: ${category}`);
    if (contact?.notes) lines.push(`Notes: ${truncate(contact.notes, CONTACT_NOTES_MAX)}`);
    if (contact?.style_notes) {
      lines.push(`Style notes: ${truncate(contact.style_notes, CONTACT_NOTES_MAX)}`);
    }
    lines.push('');

    lines.push('## Tone & length');
    lines.push(`Tone: ${TONE[category]}`);
    lines.push('Length: 1-3 short paragraphs.');
    lines.push('');

    const examples = this.styleExamples.sample(category, FEW_SHOT);
    if (examples.length > 0) {
      lines.push('## Style examples (match this voice)');
      for (const ex of examples) {
        lines.push(`Context: ${truncate(ex.context_summary ?? '', SNIPPET_MAX)}`);
        lines.push(`Reply: ${truncate(ex.reply_text ?? '', BODY_MAX)}`);
        lines.push('');
      }
    }

    const prior = this.messages
      .listByThread(threadId)
      .filter((m) => m.id !== target.id)
      .slice(-CONTEXT_MESSAGES);
    if (prior.length > 0) {
      lines.push('## Thread history (chronological)');
      for (const m of prior) {
        lines.push(
          `- ${m.direction} · ${m.from_address} · ${truncate(m.snippet ?? m.body_text ?? '', SNIPPET_MAX)}`,
        );
      }
      lines.push('');
    }

    lines.push('## Message to reply to');
    lines.push(`From: ${target.from_name ?? target.from_address} <${target.from_address}>`);
    lines.push(`Subject: ${target.subject ?? '(no subject)'}`);
    lines.push('Body:');
    lines.push(truncate(target.body_text ?? '', DRAFT_BODY_MAX));
    lines.push('');

    if (opts?.rawIntent) {
      lines.push("## Principal's intent (polish this into the reply)");
      lines.push(opts.rawIntent);
      lines.push('');
    }

    lines.push('Write only the reply body — no subject line, no quoted original.');

    return { system, prompt: lines.join('\n'), systemPromptUsed: system };
  }
}

/**
 * Reply subject for an outbound draft: preserves the original casing and adds a single
 * "Re: " prefix when absent. Intentionally does NOT strip Re:/Fwd: chains (a reply to
 * "Fwd: Notes" should read "Re: Fwd: Notes"), so it does not use normalizeSubject.
 */
export function replySubject(subject: string | null): string {
  const base = subject && subject.trim().length > 0 ? subject.trim() : '(no subject)';
  if (/^re:/i.test(base)) return base;
  return `Re: ${base}`;
}
