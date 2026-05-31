import type { RawMessage } from '@secretary/shared-types';

const SNIPPET_MAX = 200;

export function snippetOf(bodyText: string | undefined): string {
  if (!bodyText) return '';
  return bodyText.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);
}

/** Unique, lowercased participant addresses across from/to/cc (excludes bcc). */
export function participantsOf(raw: RawMessage): string[] {
  const all = [raw.from, ...raw.to, ...raw.cc].map((a) => a.address.toLowerCase());
  return [...new Set(all)];
}
