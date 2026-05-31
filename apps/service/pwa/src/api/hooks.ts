import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  ContactView,
  DraftView,
  NeedsAttentionItem,
  ThreadSummary,
  ThreadWithMessages,
} from '@secretary/shared-types';
import { apiFetch } from './client.js';

export function useNeedsAttention(): UseQueryResult<NeedsAttentionItem[]> {
  return useQuery({
    queryKey: ['needs-attention'],
    queryFn: () => apiFetch<NeedsAttentionItem[]>('/threads/needs-attention'),
  });
}

export function useThreads(): UseQueryResult<ThreadSummary[]> {
  return useQuery({ queryKey: ['threads'], queryFn: () => apiFetch<ThreadSummary[]>('/threads') });
}

export function useThread(id: string): UseQueryResult<ThreadWithMessages> {
  return useQuery({
    queryKey: ['thread', id],
    queryFn: () => apiFetch<ThreadWithMessages>(`/threads/${id}`),
    enabled: id.length > 0,
  });
}

export function useContacts(): UseQueryResult<ContactView[]> {
  return useQuery({ queryKey: ['contacts'], queryFn: () => apiFetch<ContactView[]>('/contacts') });
}

export function useSettings(): UseQueryResult<Record<string, unknown>> {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => apiFetch<Record<string, unknown>>('/settings'),
  });
}

/** Create a draft for a thread (synchronous on the server). */
export function useCreateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { threadId: string; rawIntent?: string }) =>
      apiFetch<DraftView>('/drafts', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['thread', vars.threadId] });
    },
  });
}

/** Send a draft; flips the thread to awaiting_their_reply server-side. */
export function useSendDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { draftId: string }) =>
      apiFetch<{ providerMessageId: string; threadState: string }>(`/drafts/${vars.draftId}/send`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['needs-attention'] });
    },
  });
}
