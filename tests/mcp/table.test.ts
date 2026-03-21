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
    const createFile = fileRepo.upsert(repo.id, 'db/migrations/001_create_users.sql', 'sql', 'h1', 20);
    const alterFile = fileRepo.upsert(repo.id, 'db/migrations/002_add_account_fk.sql', 'sql', 'h2', 20);
    const ordersFile = fileRepo.upsert(repo.id, 'db/migrations/003_create_orders.sql', 'sql', 'h3', 20);

    schemaRepo.replaceCurrentSchema(
      repo.id,
      [
        {
          name: 'users',
          normalizedName: 'users',
          sourcePath: alterFile.path,
          lineStart: 1,
          lineEnd: 2,
          columns: [
            {
              name: 'id',
              normalizedName: 'id',
              dataType: 'INTEGER',
              isNullable: false,
              defaultValue: null,
              ordinalPosition: 1,
              sourcePath: createFile.path,
              lineNumber: 2,
            },
            {
              name: 'account_id',
              normalizedName: 'account_id',
              dataType: 'INTEGER',
              isNullable: true,
              defaultValue: null,
              ordinalPosition: 2,
              sourcePath: alterFile.path,
              lineNumber: 1,
            },
          ],
          foreignKeys: [
            {
              constraintName: null,
              sourceColumns: ['account_id'],
              targetTable: 'accounts',
              normalizedTargetTable: 'accounts',
              targetColumns: ['id'],
              sourcePath: alterFile.path,
              lineNumber: 2,
            },
          ],
        },
        {
          name: 'orders',
          normalizedName: 'orders',
          sourcePath: ordersFile.path,
          lineStart: 1,
          lineEnd: 5,
          columns: [
            {
              name: 'user_id',
              normalizedName: 'user_id',
              dataType: 'INTEGER',
              isNullable: false,
              defaultValue: null,
              ordinalPosition: 1,
              sourcePath: ordersFile.path,
              lineNumber: 2,
            },
          ],
          foreignKeys: [
            {
              constraintName: null,
              sourceColumns: ['user_id'],
              targetTable: 'users',
              normalizedTargetTable: 'users',
              targetColumns: ['id'],
              sourcePath: ordersFile.path,
              lineNumber: 3,
            },
          ],
        },
      ],
      new Map([
        [createFile.path, createFile.id],
        [alterFile.path, alterFile.id],
        [ordersFile.path, ordersFile.id],
      ])
    );

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
    expect(result).toContain("Current schema state from Cartograph's canonical schema layer.");
    expect(result).toContain('Last table-level change: db/migrations/002_add_account_fk.sql:1-2');
    expect(result).toContain('### Columns (2, current state)');
    expect(result).toContain('- id INTEGER NOT NULL');
    expect(result).toContain('- account_id INTEGER NULL');
    expect(result).toContain('### Outbound Foreign Keys (1)');
    expect(result).toContain('- account_id -> accounts(id)');
    expect(result).toContain('### Incoming Foreign Keys From Tables (1)');
    expect(result).toContain('- orders(user_id)');
  });
});
