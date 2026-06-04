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

/** Cap inputs so the O(n·m) LCS stays bounded on pathological bodies. */
const MAX_DIVERGENCE_WORDS = 2000;

/**
 * Word-level divergence in [0,1]: 0 = identical, 1 = no shared words.
 * `1 - 2·LCS / (genWords + sentWords)` over whitespace-split words.
 * Both-empty → 0. Used to flag heavily-edited drafts on send.
 */
export function divergenceRatio(generated: string, finalSent: string): number {
  const a = generated.trim().split(/\s+/).filter(Boolean).slice(0, MAX_DIVERGENCE_WORDS);
  const b = finalSent.trim().split(/\s+/).filter(Boolean).slice(0, MAX_DIVERGENCE_WORDS);
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return 0;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lcs = dp[0]![0]!;
  const ratio = 1 - (2 * lcs) / (n + m);
  return Math.min(1, Math.max(0, ratio));
}
