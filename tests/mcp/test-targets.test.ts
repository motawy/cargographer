import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../../src/db/repositories/reference-repository.js';
import { DbSchemaRepository } from '../../src/db/repositories/db-schema-repository.js';
import { SymbolSchemaRepository } from '../../src/db/repositories/symbol-schema-repository.js';
import { handleTestTargets } from '../../src/mcp/tools/test-targets.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('cartograph_test_targets', () => {
  it('suggests companion tests for a symbol and file', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      runMigrations(db);
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const refRepo = new ReferenceRepository(db);

      const repo = repoRepo.findOrCreate('/test/repo-targets', 'targets');
      const prodFile = fileRepo.upsert(repo.id, 'src/Model/RecurringQuoteModel.php', 'php', 'tt1', 20);
      fileRepo.upsert(repo.id, 'tests/Model/RecurringQuoteModelTest.php', 'php', 'tt2', 20);
      fileRepo.upsert(repo.id, 'tests/Integration/RecurringQuoteFlowTest.php', 'php', 'tt3', 20);
      fileRepo.upsert(repo.id, 'tests/Other/InvoicesTest.php', 'php', 'tt4', 20);

      const model: ParsedSymbol = {
        name: 'RecurringQuoteModel',
        qualifiedName: 'App\\Model\\RecurringQuoteModel',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 20,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [],
      };

      symbolRepo.replaceFileSymbols(prodFile.id, [model]);

      const bySymbol = handleTestTargets({
        repoId: repo.id,
        fileRepo,
        symbolRepo,
        refRepo,
      }, {
        symbol: 'App\\Model\\RecurringQuoteModel',
        limit: 5,
      });

      expect(bySymbol).toContain('tests/Model/RecurringQuoteModelTest.php');
      expect(bySymbol).not.toContain('tests/Other/InvoicesTest.php');

      const byFile = handleTestTargets({
        repoId: repo.id,
        fileRepo,
        symbolRepo,
        refRepo,
      }, {
        file: 'src/Model/RecurringQuoteModel.php',
        limit: 5,
      });

      expect(byFile).toContain('tests/Model/RecurringQuoteModelTest.php');
    } finally {
      db.close();
    }
  });

  it('suggests tests that directly mention a table name', () => {
    const db = openDatabase({ path: ':memory:' });
    const tmpDir = '/tmp/cartograph-test-targets-table-test';

    try {
      mkdirSync(`${tmpDir}/src/Entity`, { recursive: true });
      mkdirSync(`${tmpDir}/tests/Integration`, { recursive: true });
      writeFileSync(`${tmpDir}/src/Entity/Quote.php`, [
        '<?php',
        'namespace App\\Entity;',
        'class Quote {}',
      ].join('\n'));
      writeFileSync(`${tmpDir}/tests/Integration/QuotesTableTest.php`, [
        '<?php',
        'namespace Tests\\Integration;',
        'class QuotesTableTest {',
        '    public function testQuotesTable(): void',
        '    {',
        "        $this->assertSame('quotes', 'quotes');",
        '    }',
        '}',
      ].join('\n'));
      writeFileSync(`${tmpDir}/tests/Integration/UnrelatedTest.php`, [
        '<?php',
        'namespace Tests\\Integration;',
        'class UnrelatedTest {}',
      ].join('\n'));

      runMigrations(db);
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const refRepo = new ReferenceRepository(db);
      const schemaRepo = new DbSchemaRepository(db);
      const symbolSchemaRepo = new SymbolSchemaRepository(db);

      const repo = repoRepo.findOrCreate(tmpDir, 'table-targets');
      const entityFile = fileRepo.upsert(repo.id, 'src/Entity/Quote.php', 'php', 'ttt1', 3);
      fileRepo.upsert(repo.id, 'tests/Integration/QuotesTableTest.php', 'php', 'ttt2', 8);
      fileRepo.upsert(repo.id, 'tests/Integration/UnrelatedTest.php', 'php', 'ttt3', 3);

      const entity: ParsedSymbol = {
        name: 'Quote',
        qualifiedName: 'App\\Entity\\Quote',
        kind: 'class',
        visibility: null,
        lineStart: 3,
        lineEnd: 3,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [],
      };

      const symbolMap = symbolRepo.replaceFileSymbols(entityFile.id, [entity]);
      symbolSchemaRepo.replaceFileLinks(entityFile.id, symbolMap, [
        {
          sourceQualifiedName: 'App\\Entity\\Quote',
          tableName: 'quotes',
          normalizedTableName: 'quotes',
          linkKind: 'entity_table',
        },
      ], []);

      schemaRepo.replaceCurrentSchemaFromImport(repo.id, [
        {
          name: 'quotes',
          normalizedName: 'quotes',
          sourcePath: null,
          lineStart: null,
          lineEnd: null,
          columns: [],
          foreignKeys: [],
        },
      ]);

      const result = handleTestTargets({
        repoId: repo.id,
        repoPath: tmpDir,
        fileRepo,
        symbolRepo,
        refRepo,
        schemaRepo,
        symbolSchemaRepo,
      }, {
        table: 'quotes',
        limit: 5,
      });

      expect(result).toContain('tests/Integration/QuotesTableTest.php');
      expect(result).not.toContain('tests/Integration/UnrelatedTest.php');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      db.close();
    }
  });
});
