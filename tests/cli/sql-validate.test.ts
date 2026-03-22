import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { DbSchemaRepository } from '../../src/db/repositories/db-schema-repository.js';
import { renderSqlValidateForRepo } from '../../src/cli/sql-validate.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('renderSqlValidateForRepo', () => {
  it('renders file-scoped SQL validation results for an indexed repo', () => {
    const db = openDatabase({ path: ':memory:' });
    const tmpDir = '/tmp/cartograph-cli-sql-validate-test';

    try {
      runMigrations(db);
      mkdirSync(`${tmpDir}/src/Builder`, { recursive: true });
      writeFileSync(`${tmpDir}/src/Builder/QuotesBuilder.php`, [
        '<?php',
        'class QuotesBuilder {',
        '  protected function update(): void',
        '  {',
        "    $sql = 'UPDATE quotes SET quote_totl = :quote_total WHERE quote_id = :quote_id';",
        '  }',
        '}',
      ].join('\n'));

      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const schemaRepo = new DbSchemaRepository(db);
      const repo = repoRepo.findOrCreate(tmpDir, 'cli-sql-validate');
      const file = fileRepo.upsert(repo.id, 'src/Builder/QuotesBuilder.php', 'php', 'csv1', 7);

      const builder: ParsedSymbol = {
        name: 'QuotesBuilder',
        qualifiedName: 'App\\Builder\\QuotesBuilder',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 7,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [
          {
            name: 'update',
            qualifiedName: 'App\\Builder\\QuotesBuilder::update',
            kind: 'method',
            visibility: 'protected',
            lineStart: 3,
            lineEnd: 6,
            signature: 'update(): void',
            returnType: 'void',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };
      symbolRepo.replaceFileSymbols(file.id, [builder]);

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
            {
              name: 'quote_id',
              normalizedName: 'quote_id',
              dataType: 'integer',
              isNullable: false,
              defaultValue: null,
              ordinalPosition: 2,
              sourcePath: null,
              lineNumber: null,
            },
          ],
          foreignKeys: [],
        },
      ]);

      const result = renderSqlValidateForRepo(db, tmpDir, {
        file: 'src/Builder/QuotesBuilder.php',
      });

      expect(result).toContain('## SQL Validation: src/Builder/QuotesBuilder.php');
      expect(result).toContain('Missing column in current schema: quotes.quote_totl');
      expect(result).toContain('Verified column: quotes.quote_id');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      db.close();
    }
  });
});
