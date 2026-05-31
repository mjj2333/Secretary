export interface ServerEvent {
  type: 'thread:updated' | 'draft:ready' | 'account:status' | 'sync:progress';
  payload: { threadId?: string; draftId?: string; accountId?: string } & Record<string, unknown>;
}

export type QueryKey = (string | undefined)[];

/** Pure: which TanStack Query keys a server event should invalidate. */
export function eventToInvalidations(event: ServerEvent): QueryKey[] {
  const { type, payload } = event;
  const tid = typeof payload.threadId === 'string' ? payload.threadId : undefined;
  switch (type) {
    case 'thread:updated':
      return tid
        ? [['needs-attention'], ['thread', tid], ['threads']]
        : [['needs-attention'], ['threads']];
    case 'draft:ready':
      return tid ? [['needs-attention'], ['thread', tid]] : [['needs-attention']];
    case 'account:status':
      return [['accounts']];
    case 'sync:progress':
    default:
      return [];
  }
}

/** Opens the SSE stream and invalidates query keys on each event. Auto-reconnects with backoff. */
export function createEventStream(
  token: string,
  onEvent: (event: ServerEvent) => void,
  EventSourceImpl: typeof EventSource = EventSource,
): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let backoff = 1000;
  const types: ServerEvent['type'][] = [
    'thread:updated',
    'draft:ready',
    'account:status',
    'sync:progress',
  ];

  const connect = (): void => {
    if (closed) return;
    es = new EventSourceImpl(`/api/v1/events?token=${encodeURIComponent(token)}`);
    es.onopen = () => {
      backoff = 1000;
    };
    for (const t of types) {
      es.addEventListener(t, (ev) => {
        let payload: ServerEvent['payload'] = {};
        try {
          payload = JSON.parse((ev as MessageEvent).data) as ServerEvent['payload'];
        } catch {
          payload = {};
        }
        onEvent({ type: t, payload });
      });
    }
    es.onerror = () => {
      es?.close();
      if (closed) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
  };
  connect();
  return () => {
    closed = true;
    es?.close();
  };
}
