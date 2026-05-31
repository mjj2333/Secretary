import type { DiffOp } from '@secretary/shared-types';

/**
 * Minimal LCS-based line diff. Pure. Returns an op-tagged line sequence.
 * Note: an empty string splits to a single empty line (`''.split('\n')` === `['']`),
 * so `lineDiff('', '')` yields `[{op:'eq', line:''}]`. In practice both inputs are non-empty.
 */
export function lineDiff(before: string, after: string): DiffOp[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const ai = a[i] as string;
    const row = dp[i] as number[];
    const nextRow = dp[i + 1] as number[];
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] =
        ai === (b[j] as string)
          ? (nextRow[j + 1] as number) + 1
          : Math.max(nextRow[j] as number, row[j + 1] as number);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if ((a[i] as string) === (b[j] as string)) {
      ops.push({ op: 'eq', line: a[i] as string });
      i += 1;
      j += 1;
    } else if ((dp[i + 1] as number[])[j]! >= (dp[i] as number[])[j + 1]!) {
      ops.push({ op: 'del', line: a[i] as string });
      i += 1;
    } else {
      ops.push({ op: 'add', line: b[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ op: 'del', line: a[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ op: 'add', line: b[j] as string });
    j += 1;
  }
  return ops;
}
