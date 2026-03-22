import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { DbSchemaRepository } from '../../src/db/repositories/db-schema-repository.js';
import { SymbolSchemaRepository } from '../../src/db/repositories/symbol-schema-repository.js';
import { TableReferenceRepository } from '../../src/db/repositories/table-reference-repository.js';
import { renderColumnUsageForRepo } from '../../src/cli/column-usage.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('renderColumnUsageForRepo', () => {
  it('renders scoped column usage for an indexed repo', () => {
    const db = openDatabase({ path: ':memory:' });
    const tmpDir = '/tmp/cartograph-cli-column-usage-test';

    try {
      runMigrations(db);
      mkdirSync(`${tmpDir}/src/Builder`, { recursive: true });
      writeFileSync(`${tmpDir}/src/Builder/Foo.php`, [
        '<?php',
        'class Foo {',
        "  protected function update(): void { $sql = 'UPDATE quotes SET quote_total = :quote_total'; }",
        '}',
      ].join('\n'));

      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const schemaRepo = new DbSchemaRepository(db);
      const symbolSchemaRepo = new SymbolSchemaRepository(db);
      const tableReferenceRepo = new TableReferenceRepository(db);
      const repo = repoRepo.findOrCreate(tmpDir, 'cli-column-usage');

      const file = fileRepo.upsert(repo.id, 'src/Builder/Foo.php', 'php', 'cc1', 4);
      const foo: ParsedSymbol = {
        name: 'Foo',
        qualifiedName: 'App\\Foo',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 4,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [
          {
            name: 'update',
            qualifiedName: 'App\\Foo::update',
            kind: 'method',
            visibility: 'protected',
            lineStart: 3,
            lineEnd: 3,
            signature: 'update(): void',
            returnType: 'void',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };
      const symbolMap = symbolRepo.replaceFileSymbols(file.id, [foo]);

      schemaRepo.replaceCurrentSchemaFromImport(repo.id, [
        {
          name: 'quotes',
          normalizedName: 'quotes',
          sourcePath: null,
          lineStart: null,
          lineEnd: null,
          columns: [
            {
              name: 'quote_total',
              normalizedName: 'quote_total',
              dataType: 'numeric',
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

      symbolSchemaRepo.replaceFileLinks(file.id, symbolMap, [], []);
      tableReferenceRepo.replaceRepoReferences(repo.id, [
        {
          sourceFileId: file.id,
          sourceSymbolId: symbolMap.get('App\\Foo::update') ?? null,
          tableName: 'quotes',
          normalizedTableName: 'quotes',
          referenceKind: 'sql_clause',
          lineNumber: 3,
          preview: 'UPDATE quotes SET quote_total = :quote_total',
        },
      ]);

      const result = renderColumnUsageForRepo(db, tmpDir, 'quotes', 'quote_total');
      expect(result).toContain('## Column Usage: quotes.quote_total');
      expect(result).toContain('App\\Foo::update');
      expect(result).toContain('UPDATE quotes SET quote_total');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      db.close();
    }
  });
});
