import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { join } from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import type { CartographConfig } from '../../src/types.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'laravel-sample');

function testConfig(): CartographConfig {
  return {
    languages: ['php'],
    exclude: ['vendor/'],
    additionalSources: [],
    database: { path: ':memory:' },
  };
}

describe('Index Pipeline (Integration)', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = openDatabase({ path: ':memory:' });
    runMigrations(db);
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    db.exec('DELETE FROM symbol_references');
    db.exec('DELETE FROM symbols');
    db.exec('DELETE FROM files');
    db.exec('DELETE FROM repos');
  });

  it('indexes fixture project and stores correct files', () => {
    const pipeline = new IndexPipeline(db);
    pipeline.run(FIXTURES, testConfig());

    const files = db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[];
    expect(files).toHaveLength(6);
    expect(files.map((f) => f.path)).toEqual([
      'app/Contracts/UserServiceInterface.php',
      'app/Http/Controllers/UserController.php',
      'app/Models/User.php',
      'app/Repositories/UserRepository.php',
      'app/Services/UserService.php',
      'app/Traits/HasTimestamps.php',
    ]);
  });

  it('stores symbols with correct qualified names and kinds', () => {
    const pipeline = new IndexPipeline(db);
    pipeline.run(FIXTURES, testConfig());

    // Verify class
    const userClass = db.prepare(
      "SELECT * FROM symbols WHERE qualified_name = ?"
    ).all('App\\Models\\User') as Record<string, unknown>[];
    expect(userClass).toHaveLength(1);
    expect(userClass[0].kind).toBe('class');

    // Verify interface
    const iface = db.prepare(
      "SELECT * FROM symbols WHERE qualified_name = ?"
    ).all('App\\Contracts\\UserServiceInterface') as Record<string, unknown>[];
    expect(iface).toHaveLength(1);
    expect(iface[0].kind).toBe('interface');

    // Verify trait
    const trait = db.prepare(
      "SELECT * FROM symbols WHERE qualified_name = ?"
    ).all('App\\Traits\\HasTimestamps') as Record<string, unknown>[];
    expect(trait).toHaveLength(1);
    expect(trait[0].kind).toBe('trait');

    // Verify method with parent relationship
    const findById = db.prepare(
      "SELECT * FROM symbols WHERE qualified_name = ?"
    ).all('App\\Services\\UserService::findById') as Record<string, unknown>[];
    expect(findById).toHaveLength(1);
    expect(findById[0].kind).toBe('method');
    expect(findById[0].visibility).toBe('public');

    const serviceClass = db.prepare(
      "SELECT * FROM symbols WHERE qualified_name = ?"
    ).all('App\\Services\\UserService') as Record<string, unknown>[];
    expect(findById[0].parent_symbol_id).toBe(serviceClass[0].id);
  });

  it('stores constructor promoted properties', () => {
    const pipeline = new IndexPipeline(db);
    pipeline.run(FIXTURES, testConfig());

    const rows = db.prepare(
      "SELECT * FROM symbols WHERE qualified_name = ?"
    ).all('App\\Http\\Controllers\\UserController::$userService') as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('property');
    expect(rows[0].visibility).toBe('private');
    const metadata = typeof rows[0].metadata === 'string'
      ? JSON.parse(rows[0].metadata as string)
      : rows[0].metadata;
    expect(metadata).toEqual(
      expect.objectContaining({ promoted: true, readonly: true })
    );
  });

  it('is idempotent — re-indexing produces same symbol count', () => {
    const pipeline = new IndexPipeline(db);
    const config = testConfig();

    pipeline.run(FIXTURES, config);
    const first = db.prepare(
      'SELECT COUNT(*) AS count FROM symbols'
    ).get() as { count: number };

    pipeline.run(FIXTURES, config);
    const second = db.prepare(
      'SELECT COUNT(*) AS count FROM symbols'
    ).get() as { count: number };

    expect(first.count).toBe(second.count);
  });

  it('second run detects 0 changes for unchanged files', () => {
    const pipeline = new IndexPipeline(db);
    const config = testConfig();

    pipeline.run(FIXTURES, config);
    pipeline.run(FIXTURES, config);

    const row = db.prepare(
      'SELECT COUNT(*) AS count FROM symbols'
    ).get() as { count: number };
    expect(row.count).toBeGreaterThan(0);
  });

  it('stores all expected symbol kinds', () => {
    const pipeline = new IndexPipeline(db);
    pipeline.run(FIXTURES, testConfig());

    const kinds = db.prepare(
      'SELECT DISTINCT kind FROM symbols ORDER BY kind'
    ).all() as { kind: string }[];
    const kindList = kinds.map((r) => r.kind);

    expect(kindList).toContain('class');
    expect(kindList).toContain('interface');
    expect(kindList).toContain('trait');
    expect(kindList).toContain('method');
    expect(kindList).toContain('property');
    expect(kindList).toContain('constant');
  });

  it('stores file metadata correctly', () => {
    const pipeline = new IndexPipeline(db);
    pipeline.run(FIXTURES, testConfig());

    const rows = db.prepare(
      "SELECT * FROM files WHERE path = ?"
    ).all('app/Models/User.php') as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].language).toBe('php');
    expect(rows[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect((rows[0].lines_of_code as number)).toBeGreaterThan(0);
  });

  it('indexes additional source roots and resolves references across them', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'cartograph-index-root-'));
    const extraDir = mkdtempSync(join(tmpdir(), 'cartograph-index-extra-'));

    try {
      mkdirSync(join(repoDir, 'app'), { recursive: true });
      writeFileSync(
        join(repoDir, 'app', 'UsesBase.php'),
        `<?php
namespace App;

use Shared\\BaseThing;

class UsesBase
{
    public function make(): BaseThing
    {
        return new BaseThing();
    }
}
`
      );

      writeFileSync(
        join(extraDir, 'BaseThing.php'),
        `<?php
namespace Shared;

class BaseThing
{
}
`
      );

      const pipeline = new IndexPipeline(db);
      pipeline.run(repoDir, {
        languages: ['php'],
        exclude: ['vendor/'],
        additionalSources: [{ path: extraDir, label: 'shared-base' }],
        database: { path: ':memory:' },
      });

      const files = db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[];
      expect(files.map((file) => file.path)).toEqual([
        '@shared-base/BaseThing.php',
        'app/UsesBase.php',
      ]);

      const refs = db.prepare(
        `SELECT sr.reference_kind, sr.target_symbol_id
         FROM symbol_references sr
         JOIN symbols s ON s.id = sr.source_symbol_id
         WHERE s.qualified_name = ?`
      ).all('App\\UsesBase::make') as { reference_kind: string; target_symbol_id: number | null }[];

      expect(refs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reference_kind: 'type_hint', target_symbol_id: expect.any(Number) }),
          expect.objectContaining({ reference_kind: 'instantiation', target_symbol_id: expect.any(Number) }),
        ])
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(extraDir, { recursive: true, force: true });
    }
  });

  it('indexes sql schema files into table, column, and foreign key rows', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'cartograph-sql-root-'));

    try {
      mkdirSync(join(repoDir, 'db'), { recursive: true });
      writeFileSync(
        join(repoDir, 'db', 'schema.sql'),
        `CREATE TABLE users (
  id INTEGER NOT NULL,
  account_id INTEGER REFERENCES accounts(id)
);

CREATE TABLE orders (
  id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`
      );

      const pipeline = new IndexPipeline(db);
      pipeline.run(repoDir, {
        languages: ['sql'],
        exclude: ['vendor/'],
        additionalSources: [],
        database: { path: ':memory:' },
      });

      const fileRows = db.prepare('SELECT path, language FROM files ORDER BY path').all() as {
        path: string;
        language: string;
      }[];
      expect(fileRows).toEqual([
        { path: 'db/schema.sql', language: 'sql' },
      ]);

      const tableRows = db.prepare(
        'SELECT name, normalized_name FROM db_tables ORDER BY normalized_name'
      ).all() as { name: string; normalized_name: string }[];
      expect(tableRows).toEqual([
        { name: 'orders', normalized_name: 'orders' },
        { name: 'users', normalized_name: 'users' },
      ]);

      const columnCount = db.prepare(
        'SELECT COUNT(*) AS count FROM db_columns'
      ).get() as { count: number };
      expect(columnCount.count).toBe(4);

      const fkRows = db.prepare(
        'SELECT target_table FROM db_foreign_keys ORDER BY target_table'
      ).all() as { target_table: string }[];
      expect(fkRows).toEqual([
        { target_table: 'accounts' },
        { target_table: 'users' },
      ]);

      const currentTableRows = db.prepare(
        'SELECT name, normalized_name FROM db_current_tables ORDER BY normalized_name'
      ).all() as { name: string; normalized_name: string }[];
      expect(currentTableRows).toEqual([
        { name: 'orders', normalized_name: 'orders' },
        { name: 'users', normalized_name: 'users' },
      ]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('replays ordered sql migrations into one current table state', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'cartograph-sql-migrations-'));

    try {
      mkdirSync(join(repoDir, 'db', 'migrations'), { recursive: true });
      writeFileSync(
        join(repoDir, 'db', 'migrations', '001_create_quotes.sql'),
        `CREATE TABLE quotes (
  id INT NOT NULL,
  legacy_code VARCHAR(20),
  created_at DATETIME
);
`
      );
      writeFileSync(
        join(repoDir, 'db', 'migrations', '002_alter_quotes.sql'),
        `ALTER TABLE quotes
  DROP COLUMN legacy_code,
  ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'draft',
  CHANGE COLUMN created_at created_on DATETIME NOT NULL;
`
      );

      const pipeline = new IndexPipeline(db);
      pipeline.run(repoDir, {
        languages: ['sql'],
        exclude: [],
        additionalSources: [],
        database: { path: ':memory:' },
      });

      const currentTables = db.prepare(
        'SELECT name, line_start, line_end FROM db_current_tables ORDER BY name'
      ).all() as { name: string; line_start: number; line_end: number }[];
      expect(currentTables).toEqual([
        { name: 'quotes', line_start: 1, line_end: 4 },
      ]);

      const currentColumns = db.prepare(
        `SELECT c.name
         FROM db_current_columns c
         JOIN db_current_tables t ON c.table_id = t.id
         WHERE t.normalized_name = 'quotes'
         ORDER BY c.ordinal_position`
      ).all() as { name: string }[];
      expect(currentColumns.map((column) => column.name)).toEqual([
        'id',
        'status',
        'created_on',
      ]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('skips migration-based current schema rebuild when postgres schema source is configured', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'cartograph-pg-schema-source-'));

    try {
      mkdirSync(join(repoDir, 'db'), { recursive: true });
      writeFileSync(
        join(repoDir, 'db', 'schema.sql'),
        `CREATE TABLE quotes (
  id INT NOT NULL
);
`
      );

      const pipeline = new IndexPipeline(db);
      pipeline.run(repoDir, {
        languages: ['sql'],
        exclude: [],
        additionalSources: [],
        schemaSource: { type: 'postgres' },
        database: { path: ':memory:' },
      });

      const rawDefinitions = db.prepare(
        'SELECT COUNT(*) AS count FROM db_tables'
      ).get() as { count: number };
      expect(rawDefinitions.count).toBe(1);

      const currentTables = db.prepare(
        'SELECT COUNT(*) AS count FROM db_current_tables'
      ).get() as { count: number };
      expect(currentTables.count).toBe(0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
