let lastSyncAt: string | null = null;
const listeners = new Set<() => void>();

export function markSynced(iso: string = new Date().toISOString()): void {
  lastSyncAt = iso;
  listeners.forEach((l) => l());
}
export function getLastSync(): string | null {
  return lastSyncAt;
}
export function subscribeLastSync(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
