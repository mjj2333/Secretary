/** Compact relative time: "just now", "5m", "3h", "2d", or an ISO date past 30 days. `now` is injectable for tests. */
export function formatTimeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day <= 30) return `${day}d`;
  return new Date(then).toISOString().slice(0, 10);
}
