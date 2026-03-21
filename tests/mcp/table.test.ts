import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { DbSchemaRepository } from '../../src/db/repositories/db-schema-repository.js';
import { handleTable } from '../../src/mcp/tools/table.js';
import type { ToolDeps } from '../../src/mcp/types.js';

describe('cartograph_table', () => {
  let db: Database.Database;
  let deps: ToolDeps;

  beforeAll(() => {
    db = openDatabase({ path: ':memory:' });
    runMigrations(db);

    const repoRepo = new RepoRepository(db);
    const fileRepo = new FileRepository(db);
    const schemaRepo = new DbSchemaRepository(db);

    const repo = repoRepo.findOrCreate('/test/repo', 'test');
    const schemaFile = fileRepo.upsert(repo.id, 'db/schema.sql', 'sql', 'h1', 20);

    schemaRepo.replaceFileSchema(schemaFile.id, [
      {
        name: 'users',
        normalizedName: 'users',
        lineStart: 1,
        lineEnd: 5,
        columns: [
          {
            name: 'id',
            normalizedName: 'id',
            dataType: 'INTEGER',
            isNullable: false,
            defaultValue: null,
            ordinalPosition: 1,
            lineNumber: 2,
          },
          {
            name: 'account_id',
            normalizedName: 'account_id',
            dataType: 'INTEGER',
            isNullable: true,
            defaultValue: null,
            ordinalPosition: 2,
            lineNumber: 3,
          },
        ],
        foreignKeys: [
          {
            constraintName: null,
            sourceColumns: ['account_id'],
            targetTable: 'accounts',
            normalizedTargetTable: 'accounts',
            targetColumns: ['id'],
            lineNumber: 3,
          },
        ],
      },
      {
        name: 'orders',
        normalizedName: 'orders',
        lineStart: 7,
        lineEnd: 12,
        columns: [
          {
            name: 'user_id',
            normalizedName: 'user_id',
            dataType: 'INTEGER',
            isNullable: false,
            defaultValue: null,
            ordinalPosition: 1,
            lineNumber: 8,
          },
        ],
        foreignKeys: [
          {
            constraintName: null,
            sourceColumns: ['user_id'],
            targetTable: 'users',
            normalizedTargetTable: 'users',
            targetColumns: ['id'],
            lineNumber: 8,
          },
        ],
      },
    ]);

    deps = {
      repoId: repo.id,
      symbolRepo: undefined as never,
      refRepo: undefined as never,
      schemaRepo,
    };
  });

  afterAll(() => {
    db.close();
  });

  it('renders columns and foreign key relationships for a table', () => {
    const result = handleTable(deps, { name: 'users' });

    expect(result).toContain('## users');
    expect(result).toContain('File: db/schema.sql:1-5');
    expect(result).toContain('### Columns (2)');
    expect(result).toContain('- id INTEGER NOT NULL');
    expect(result).toContain('- account_id INTEGER NULL');
    expect(result).toContain('### Foreign Keys Out (1)');
    expect(result).toContain('- account_id -> accounts(id)');
    expect(result).toContain('### Referenced By (1)');
    expect(result).toContain('- orders(user_id)');
  });
});
