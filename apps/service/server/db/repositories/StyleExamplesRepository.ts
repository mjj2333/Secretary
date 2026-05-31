import type Database from 'better-sqlite3-multiple-ciphers';
import type { ContactCategory } from '@secretary/shared-types';
import type { StyleExampleRow } from '../schema.js';

export class StyleExamplesRepository {
  constructor(private readonly db: Database.Database) {}

  /** Up to `limit` examples for the category; falls back to any when none match. (Empty in v1.) */
  sample(category: ContactCategory, limit: number): StyleExampleRow[] {
    const matched = this.db
      .prepare('SELECT * FROM style_examples WHERE contact_category = ? LIMIT ?')
      .all(category, limit) as StyleExampleRow[];
    if (matched.length >= limit) return matched;
    if (matched.length > 0) return matched;
    return this.db.prepare('SELECT * FROM style_examples LIMIT ?').all(limit) as StyleExampleRow[];
  }
}
