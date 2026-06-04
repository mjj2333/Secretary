import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSession } from '../api/session.js';
import { createEventStream, eventToInvalidations } from './events.js';
import { markSynced } from '../util/syncStatus.js';

/** Starts the SSE stream under the authenticated app; invalidates queries on each event. */
export function useServerEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const token = getSession();
    if (!token) return undefined;
    return createEventStream(token, (event) => {
      markSynced();
      if (event.type === 'mining:progress') {
        const done = Number(event.payload.done ?? 0);
        const total = Number(event.payload.total ?? 0);
        qc.setQueryData(['mining-status'], { running: total > 0 && done < total, total, done });
        if (total > 0 && done >= total) void qc.invalidateQueries({ queryKey: ['style-examples'] });
        return;
      }
      for (const key of eventToInvalidations(event)) void qc.invalidateQueries({ queryKey: key });
    });
  }, [qc]);
}
