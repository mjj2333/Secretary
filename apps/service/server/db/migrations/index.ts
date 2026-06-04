import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Migration } from '../migrate.js';

const here = dirname(fileURLToPath(import.meta.url));

function load(version: number, name: string): Migration {
  const file = `${String(version).padStart(4, '0')}_${name}.sql`;
  return { version, name, sql: readFileSync(join(here, file), 'utf8') };
}

export const migrations: Migration[] = [load(1, 'init'), load(2, 'phase_6b')];
