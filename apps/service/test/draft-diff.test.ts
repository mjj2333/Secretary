import { describe, expect, it } from 'vitest';
import { lineDiff, divergenceRatio } from '../server/agent/draftDiff.js';

describe('lineDiff', () => {
  it('marks identical text as all eq', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { op: 'eq', line: 'a' },
      { op: 'eq', line: 'b' },
    ]);
  });

  it('detects an added line', () => {
    expect(lineDiff('a\nc', 'a\nb\nc')).toEqual([
      { op: 'eq', line: 'a' },
      { op: 'add', line: 'b' },
      { op: 'eq', line: 'c' },
    ]);
  });

  it('detects a removed line', () => {
    expect(lineDiff('a\nb\nc', 'a\nc')).toEqual([
      { op: 'eq', line: 'a' },
      { op: 'del', line: 'b' },
      { op: 'eq', line: 'c' },
    ]);
  });

  it('represents a full rewrite as del-then-add', () => {
    const d = lineDiff('old line', 'new line');
    expect(d).toEqual([
      { op: 'del', line: 'old line' },
      { op: 'add', line: 'new line' },
    ]);
  });

  it('treats an empty string as a single empty line', () => {
    expect(lineDiff('', '')).toEqual([{ op: 'eq', line: '' }]);
    expect(lineDiff('', 'x')).toEqual([
      { op: 'del', line: '' },
      { op: 'add', line: 'x' },
    ]);
  });
});

describe('divergenceRatio', () => {
  it('is 0 for identical text', () => {
    expect(divergenceRatio('the quick brown fox', 'the quick brown fox')).toBe(0);
  });

  it('is 1 for fully disjoint text', () => {
    expect(divergenceRatio('alpha beta gamma', 'one two three four')).toBe(1);
  });

  it('is below 0.30 for a one-word change in many', () => {
    const gen = 'the quick brown fox jumps over the lazy dog today';
    const sent = 'the quick brown fox jumps over the lazy dog tonight';
    expect(divergenceRatio(gen, sent)).toBeLessThan(0.3);
  });

  it('is 0 when both are empty', () => {
    expect(divergenceRatio('', '')).toBe(0);
    expect(divergenceRatio('   ', '')).toBe(0);
  });
});
