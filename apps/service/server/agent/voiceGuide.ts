import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SettingsRepository } from '../db/repositories/SettingsRepository.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPTS_DIR = join(here, '..', 'prompts');
const baselineCache = new Map<string, string>();

function baseline(promptsDir: string): string {
  let cached = baselineCache.get(promptsDir);
  if (cached === undefined) {
    cached = readFileSync(join(promptsDir, 'voice-baseline.md'), 'utf8');
    baselineCache.set(promptsDir, cached);
  }
  return cached;
}

/** The effective voice guide: a non-empty `style_guide` setting override, else the baseline markdown. */
export function resolveVoiceGuide(
  settings: Pick<SettingsRepository, 'get'>,
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): { styleGuide: string; isDefault: boolean } {
  const override = settings.get<string>('style_guide');
  if (typeof override === 'string' && override.trim().length > 0) {
    return { styleGuide: override, isDefault: false };
  }
  return { styleGuide: baseline(promptsDir), isDefault: true };
}
