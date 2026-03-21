import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { resetDatabase } from '../../src/cli/reset.js';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'src', 'db', 'migrations');

function listTables(db: ReturnType<typeof openDatabase>): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as { name: string }[]).map((row) => row.name);
}

describe('resetDatabase', () => {
  it('creates the schema when the database is empty', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      resetDatabase(db, MIGRATIONS_DIR);

      expect(listTables(db)).toEqual([
        '_migrations',
        'db_columns',
        'db_foreign_keys',
        'db_tables',
        'files',
        'repos',
        'symbol_references',
        'symbols',
      ]);
    } finally {
      db.close();
    }
  });

  it('drops and recreates an existing schema without foreign key drop errors', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      runMigrations(db, MIGRATIONS_DIR);

      expect(() => resetDatabase(db, MIGRATIONS_DIR)).not.toThrow();
      expect(listTables(db)).toEqual([
        '_migrations',
        'db_columns',
        'db_foreign_keys',
        'db_tables',
        'files',
        'repos',
        'symbol_references',
        'symbols',
      ]);

      const appliedCount = db.prepare(
        'SELECT COUNT(*) AS count FROM _migrations'
      ).get() as { count: number };
      expect(appliedCount.count).toBe(5);
    } finally {
      db.close();
    }
  });
});
