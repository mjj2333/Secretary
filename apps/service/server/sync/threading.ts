export interface ThreadLookups {
  /** Returns the thread id whose messages include any of these Message-IDs, else undefined. */
  threadIdForMessageIds(messageIds: string[]): string | undefined;
  /** Returns the thread id with this normalized subject (most recent), else undefined. */
  threadIdForSubject(subjectNormalized: string): string | undefined;
}

const PREFIX_RE = /^(\s*(re|fwd|fw)\s*:\s*)+/i;

export function normalizeSubject(subject: string | undefined): string {
  return (subject ?? '').replace(PREFIX_RE, '').trim().toLowerCase();
}

export interface ThreadCandidate {
  inReplyTo?: string;
  references: string[];
  subject?: string;
}

/**
 * Resolves which existing thread a message belongs to: first by reply-chain
 * (In-Reply-To / References matching a known Message-ID), then by normalized
 * subject. Returns null when no existing thread matches (caller creates one).
 */
export function resolveThreadId(msg: ThreadCandidate, lookups: ThreadLookups): string | null {
  const refIds = [msg.inReplyTo, ...msg.references].filter((x): x is string => Boolean(x));
  if (refIds.length > 0) {
    const byRef = lookups.threadIdForMessageIds(refIds);
    if (byRef) return byRef;
  }
  const subj = normalizeSubject(msg.subject);
  if (subj) {
    const bySubj = lookups.threadIdForSubject(subj);
    if (bySubj) return bySubj;
  }
  return null;
}
