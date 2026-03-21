import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../../src/db/repositories/reference-repository.js';
import { DbSchemaRepository } from '../../src/db/repositories/db-schema-repository.js';
import { handleStatus } from '../../src/mcp/tools/status.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('cartograph_status', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports additional sources and unresolved trust breakdown', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      runMigrations(db);

      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const refRepo = new ReferenceRepository(db);
      const schemaRepo = new DbSchemaRepository(db);

      const repo = repoRepo.findOrCreate('/test/repo', 'test');
      repoRepo.updateLastIndexed(repo.id);

      const appFile = fileRepo.upsert(repo.id, 'src/Foo.php', 'php', 'h1', 10);
      const barFile = fileRepo.upsert(repo.id, 'src/Bar.php', 'php', 'h2', 10);
      const testFile = fileRepo.upsert(repo.id, 'tests/FooTest.php', 'php', 'h3', 10);
      const cacheFile = fileRepo.upsert(repo.id, 'cache/Container.php', 'php', 'h4', 10);
      const schemaFile = fileRepo.upsert(repo.id, 'db/001_create_users.sql', 'sql', 'h-schema', 10);
      fileRepo.upsert(repo.id, '@shared/BaseThing.php', 'php', 'h5', 10);

      const fooSymbol: ParsedSymbol = {
        name: 'Foo',
        qualifiedName: 'App\\Foo',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 10,
        signature: null,
        returnType: null,
        docblock: null,
        children: [],
        metadata: {},
      };
      const barSymbol: ParsedSymbol = {
        name: 'Bar',
        qualifiedName: 'App\\Bar',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 10,
        signature: null,
        returnType: null,
        docblock: null,
        children: [],
        metadata: {},
      };
      const testSymbol: ParsedSymbol = {
        name: 'FooTest',
        qualifiedName: 'Tests\\FooTest',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 10,
        signature: null,
        returnType: null,
        docblock: null,
        children: [],
        metadata: {},
      };
      const cacheSymbol: ParsedSymbol = {
        name: 'Container',
        qualifiedName: 'Container\\Generated',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 10,
        signature: null,
        returnType: null,
        docblock: null,
        children: [],
        metadata: {},
      };

      const fooMap = symbolRepo.replaceFileSymbols(appFile.id, [fooSymbol]);
      symbolRepo.replaceFileSymbols(barFile.id, [barSymbol]);
      const testMap = symbolRepo.replaceFileSymbols(testFile.id, [testSymbol]);
      const cacheMap = symbolRepo.replaceFileSymbols(cacheFile.id, [cacheSymbol]);

      refRepo.replaceFileReferences(appFile.id, fooMap, [
        { sourceQualifiedName: 'App\\Foo', targetQualifiedName: 'App\\Bar', kind: 'type_hint', line: 2 },
        { sourceQualifiedName: 'App\\Foo', targetQualifiedName: 'Symfony\\Component\\HttpFoundation\\Request', kind: 'type_hint', line: 3 },
        { sourceQualifiedName: 'App\\Foo', targetQualifiedName: 'DateTime', kind: 'instantiation', line: 4 },
        { sourceQualifiedName: 'App\\Foo', targetQualifiedName: 'SystemConfig', kind: 'instantiation', line: 5 },
      ]);
      refRepo.replaceFileReferences(testFile.id, testMap, [
        { sourceQualifiedName: 'Tests\\FooTest', targetQualifiedName: 'Phake::mock', kind: 'static_call', line: 6 },
      ]);
      refRepo.replaceFileReferences(cacheFile.id, cacheMap, [
        { sourceQualifiedName: 'Container\\Generated', targetQualifiedName: 'Symfony\\Component\\HttpFoundation\\Request', kind: 'type_hint', line: 7 },
      ]);
      refRepo.resolveTargets(repo.id);
      schemaRepo.replaceFileSchema(schemaFile.id, [
        {
          name: 'users',
          normalizedName: 'users',
          lineStart: 1,
          lineEnd: 4,
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
          ],
          foreignKeys: [],
        },
      ]);
      schemaRepo.replaceCurrentSchema(
        repo.id,
        [
          {
            name: 'users',
            normalizedName: 'users',
            sourcePath: schemaFile.path,
            lineStart: 1,
            lineEnd: 4,
            columns: [
              {
                name: 'id',
                normalizedName: 'id',
                dataType: 'INTEGER',
                isNullable: false,
                defaultValue: null,
                ordinalPosition: 1,
                sourcePath: schemaFile.path,
                lineNumber: 2,
              },
            ],
            foreignKeys: [],
          },
        ],
        new Map([[schemaFile.path, schemaFile.id]])
      );

      const result = handleStatus({ db, repoId: repo.id });

      expect(result).toContain('Additional sources: shared (1 files)');
      expect(result).toContain('DB schema: 1 current tables, 1 columns, 0 foreign keys (from 1 SQL files, 1 raw definitions)');
      expect(result).toContain('Raw resolution rate: 16.7%');
      expect(result).toContain('Production trust rate: 75% (potential internal/cross-repo gaps: 1)');
      expect(result).toContain('Potential internal / cross-repo gaps: 1 (20%)');
      expect(result).toContain('PHP builtins: 1 (20%)');
      expect(result).toContain('External vendor / framework: 1 (20%)');
      expect(result).toContain('Test framework / mocks: 1 (20%)');
      expect(result).toContain('Generated cache: 1 (20%)');
    } finally {
      db.close();
    }
  });

  it('caps non-perfect trust below 100 percent', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      runMigrations(db);

      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const refRepo = new ReferenceRepository(db);

      const repo = repoRepo.findOrCreate('/test/almost-perfect', 'almost-perfect');
      repoRepo.updateLastIndexed(repo.id);

      const files = Array.from({ length: 1000 }, (_, idx) =>
        fileRepo.upsert(repo.id, `src/File${idx}.php`, 'php', `h${idx}`, 1)
      );

      const symbols = files.map((file, idx) => {
        const parsedSymbol: ParsedSymbol = {
          name: `Thing${idx}`,
          qualifiedName: `App\\Thing${idx}`,
          kind: 'class',
          visibility: null,
          lineStart: 1,
          lineEnd: 1,
          signature: null,
          returnType: null,
          docblock: null,
          children: [],
          metadata: {},
        };

        const map = symbolRepo.replaceFileSymbols(file.id, [parsedSymbol]);
        return {
          fileId: file.id,
          qualifiedName: parsedSymbol.qualifiedName,
          symbolId: map.get(parsedSymbol.qualifiedName)!,
        };
      });

      for (let idx = 0; idx < symbols.length - 1; idx++) {
        refRepo.replaceFileReferences(symbols[idx].fileId, new Map([[symbols[idx].qualifiedName, symbols[idx].symbolId]]), [
          {
            sourceQualifiedName: symbols[idx].qualifiedName,
            targetQualifiedName: symbols[idx + 1].qualifiedName,
            kind: 'type_hint',
            line: 1,
          },
        ]);
      }

      refRepo.replaceFileReferences(
        symbols[symbols.length - 1].fileId,
        new Map([[symbols[symbols.length - 1].qualifiedName, symbols[symbols.length - 1].symbolId]]),
        [
          {
            sourceQualifiedName: symbols[symbols.length - 1].qualifiedName,
            targetQualifiedName: 'App\\MissingThing',
            kind: 'type_hint',
            line: 1,
          },
        ]
      );

      refRepo.resolveTargets(repo.id);

      const result = handleStatus({ db, repoId: repo.id });

      expect(result).toContain('References: 1000 (999 resolved, 1 unresolved)');
      expect(result).toContain('Raw resolution rate: 99.9%');
      expect(result).toContain('Production trust rate: 99.9% (potential internal/cross-repo gaps: 1)');
    } finally {
      db.close();
    }
  });

  it('indicates when current schema came from a live import', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      runMigrations(db);

      const repoRepo = new RepoRepository(db);
      const schemaRepo = new DbSchemaRepository(db);

      const repo = repoRepo.findOrCreate('/test/live-schema', 'live-schema');
      repoRepo.updateLastIndexed(repo.id);

      schemaRepo.replaceCurrentSchemaFromImport(repo.id, [
        {
          name: 'quotes',
          normalizedName: 'quotes',
          sourcePath: null,
          lineStart: null,
          lineEnd: null,
          columns: [
            {
              name: 'id',
              normalizedName: 'id',
              dataType: 'integer',
              isNullable: false,
              defaultValue: null,
              ordinalPosition: 1,
              sourcePath: null,
              lineNumber: null,
            },
          ],
          foreignKeys: [],
        },
      ]);

      const result = handleStatus({ db, repoId: repo.id });

      expect(result).toContain('DB schema: 1 current tables, 1 columns, 0 foreign keys (from 0 SQL files, 0 raw definitions)');
      expect(result).toContain('DB schema source: live database import');
    } finally {
      db.close();
    }
  });

  it('treats sqlite repo timestamps as UTC when computing age', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-21T10:00:05.000Z'));

      runMigrations(db);

      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findOrCreate('/test/utc-status', 'utc-status');
      db.prepare("UPDATE repos SET last_indexed_at = '2026-03-21 10:00:00' WHERE id = ?").run(repo.id);

      const result = handleStatus({ db, repoId: repo.id });

      expect(result).toContain('Last indexed (UTC): 2026-03-21T10:00:00.000Z (5s ago)');
    } finally {
      db.close();
    }
  });
});
