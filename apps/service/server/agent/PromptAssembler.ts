import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotFoundError } from '@secretary/shared-types';
import type { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import type { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';

const CONTACT_NOTES_MAX = 500;
const SNIPPET_MAX = 200;
const BODY_MAX = 2000;
const CONTEXT_MESSAGES = 3;

const here = dirname(fileURLToPath(import.meta.url));

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…[truncated]`;
}

export class PromptAssembler {
  private classifierSystem: string | null = null;

  constructor(
    private readonly messages: MessagesRepository,
    // Reserved for buildDraftPrompt (Phase 5); the constructor signature is shared with that path.
    private readonly threads: ThreadsRepository,
    private readonly contacts: ContactsRepository,
    private readonly promptsDir: string = join(here, '..', 'prompts'),
  ) {}

  private system(): string {
    if (this.classifierSystem === null) {
      this.classifierSystem = readFileSync(join(this.promptsDir, 'classifier.md'), 'utf8');
    }
    return this.classifierSystem;
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

    return { system: this.system(), prompt: lines.join('\n') };
  }
}
