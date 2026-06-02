/** True if `now` (local time) falls in the [start, end) window. Handles overnight wrap (start > end). Equal start/end = never quiet. */
export function isQuietHours(now: Date, start: string, end: string): boolean {
  const toMin = (hhmm: string): number => {
    const [h = '0', m = '0'] = hhmm.split(':');
    return Number(h) * 60 + Number(m);
  };
  const s = toMin(start);
  const e = toMin(end);
  if (s === e) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}
