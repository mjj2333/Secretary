import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveVoiceGuide } from '../server/agent/voiceGuide.js';

function promptsDirWith(baseline: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'secretary-prompts-'));
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'voice-baseline.md'), baseline);
  return join(dir, 'prompts');
}
const fakeSettings = (val: unknown) => ({ get: <T>(_k: string): T | undefined => val as T });

describe('resolveVoiceGuide', () => {
  it('returns the baseline + isDefault when there is no override', () => {
    const out = resolveVoiceGuide(fakeSettings(undefined), promptsDirWith('BASELINE VOICE'));
    expect(out).toEqual({ styleGuide: 'BASELINE VOICE', isDefault: true });
  });
  it('returns a non-empty override + not-default', () => {
    const out = resolveVoiceGuide(fakeSettings('MY VOICE'), promptsDirWith('BASELINE VOICE'));
    expect(out).toEqual({ styleGuide: 'MY VOICE', isDefault: false });
  });
  it('treats a whitespace-only override as default (baseline)', () => {
    const out = resolveVoiceGuide(fakeSettings('   '), promptsDirWith('BASELINE VOICE'));
    expect(out.isDefault).toBe(true);
    expect(out.styleGuide).toBe('BASELINE VOICE');
  });
});
