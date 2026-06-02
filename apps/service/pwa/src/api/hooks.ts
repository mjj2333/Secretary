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

/** Generate the first draft for a thread (no draft yet). */
export function useGenerateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { threadId: string; rawIntent?: string }) =>
      apiFetch<DraftView>('/drafts', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['thread', vars.threadId] });
      void qc.invalidateQueries({ queryKey: ['needs-attention'] });
    },
  });
}

/** Regenerate a thread's draft (new version), optionally with a new raw intent. */
export function useRegenerateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { threadId: string; rawIntent?: string }) =>
      apiFetch<DraftView>('/drafts', {
        method: 'POST',
        body: JSON.stringify({ ...vars, regenerate: true }),
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['thread', vars.threadId] });
    },
  });
}

/** Save edits to a draft's body/subject. */
export function useEditDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      draftId: string;
      threadId: string;
      bodyText?: string;
      subject?: string;
    }) =>
      apiFetch<DraftView>(`/drafts/${vars.draftId}`, {
        method: 'PATCH',
        body: JSON.stringify({ bodyText: vars.bodyText, subject: vars.subject }),
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['thread', vars.threadId] });
    },
  });
}

/** Discard a draft. */
export function useDiscardDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { draftId: string; threadId: string }) =>
      apiFetch<{ discarded: boolean }>(`/drafts/${vars.draftId}`, { method: 'DELETE' }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['thread', vars.threadId] });
      void qc.invalidateQueries({ queryKey: ['needs-attention'] });
    },
  });
}

/** Send a draft; flips the thread to awaiting_their_reply server-side. */
export function useSendDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { draftId: string; threadId: string }) =>
      apiFetch<{ providerMessageId: string; threadState: string }>(`/drafts/${vars.draftId}/send`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['needs-attention'] });
      void qc.invalidateQueries({ queryKey: ['thread', vars.threadId] });
    },
  });
}

export function useStyleGuide(): UseQueryResult<{ styleGuide: string; isDefault: boolean }> {
  return useQuery({
    queryKey: ['style-guide'],
    queryFn: () => apiFetch<{ styleGuide: string; isDefault: boolean }>('/settings/style-guide'),
  });
}

export function useSaveStyleGuide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { styleGuide: string }) =>
      apiFetch<Record<string, unknown>>('/settings', {
        method: 'PATCH',
        body: JSON.stringify({ style_guide: vars.styleGuide }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['style-guide'] });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

export function useContact(id: string): UseQueryResult<ContactView> {
  return useQuery({
    queryKey: ['contact', id],
    queryFn: () => apiFetch<ContactView>(`/contacts/${id}`),
    enabled: id.length > 0,
  });
}

export function usePatchContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      category?: string;
      notes?: string;
      styleNotes?: string;
      doNotAutoDraft?: boolean;
    }) => {
      const { id, ...fields } = vars;
      return apiFetch<ContactView>(`/contacts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
      });
    },
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['contact', vars.id] });
      void qc.invalidateQueries({ queryKey: ['contacts'] });
    },
  });
}
