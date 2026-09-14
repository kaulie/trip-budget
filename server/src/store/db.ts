import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';

/**
 * `node:sqlite` ships with Node (>=22.5) but is not an npm package, so it is
 * loaded through `createRequire` — bundlers and test runners otherwise try to
 * resolve it as a dependency.
 */
const require = createRequire(import.meta.url);
const { DatabaseSync: SqliteDatabase } = require('node:sqlite') as typeof import('node:sqlite');

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new SqliteDatabase(path);
  db.exec(SCHEMA_SQL);
  return db;
}
