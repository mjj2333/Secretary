import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretStore } from '../auth/SecretStore.js';

export const NEEDS_SETUP_FILE = 'needs-setup.flag';

export interface FirstRunStatus {
  needsSetup: boolean;
  missing: string[];
}

/**
 * Determines whether onboarding is required. In local-direct dev (useCfHeaders=false)
 * only the gateway API key + payload key are required; the Cloudflare token is added
 * to the requirements when CF headers are enabled. Writes/removes the needs-setup flag.
 */
export function evaluateFirstRun(
  store: SecretStore,
  dataDir: string,
  useCfHeaders: boolean,
): FirstRunStatus {
  const required = ['app.gateway-api-key', 'app.payload-key'];
  if (useCfHeaders) required.push('app.cf-access-id', 'app.cf-access-secret');

  const missing = required.filter((k) => !store.has(k));
  const needsSetup = missing.length > 0;

  const flagPath = join(dataDir, NEEDS_SETUP_FILE);
  if (needsSetup) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(flagPath, JSON.stringify({ missing }), 'utf8');
  } else {
    rmSync(flagPath, { force: true });
  }
  return { needsSetup, missing };
}
