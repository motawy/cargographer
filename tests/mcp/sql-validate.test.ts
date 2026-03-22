import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { DbSchemaRepository } from '../../src/db/repositories/db-schema-repository.js';
import { handleSqlValidate } from '../../src/mcp/tools/sql-validate.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('cartograph_sql_validate', () => {
  it('validates symbol-scoped SQL refs against the current schema', () => {
    const db = openDatabase({ path: ':memory:' });
    const tmpDir = '/tmp/cartograph-sql-validate-test';

    try {
      runMigrations(db);
      mkdirSync(`${tmpDir}/src/Builder`, { recursive: true });
      writeFileSync(`${tmpDir}/src/Builder/RecurringQuoteBuilder.php`, [
        '<?php',
        'class RecurringQuoteBuilder {',
        '    protected function buildQuery(): string',
        '    {',
        '        return "SELECT rqs.display_order, rqs.missing_column',
        'FROM recurring_quote_sections rqs',
        'JOIN recurring_quotes rq ON rq.quote_id = rqs.quote_id',
        'WHERE rqs.section_id = :section_id";',
        '    }',
        '}',
      ].join('\n'));

      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const schemaRepo = new DbSchemaRepository(db);
      const repo = repoRepo.findOrCreate(tmpDir, 'sql-validate');
      const file = fileRepo.upsert(repo.id, 'src/Builder/RecurringQuoteBuilder.php', 'php', 'sv1', 10);

      const builder: ParsedSymbol = {
        name: 'RecurringQuoteBuilder',
        qualifiedName: 'App\\Builder\\RecurringQuoteBuilder',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 10,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [
          {
            name: 'buildQuery',
            qualifiedName: 'App\\Builder\\RecurringQuoteBuilder::buildQuery',
            kind: 'method',
            visibility: 'protected',
            lineStart: 3,
            lineEnd: 9,
            signature: 'buildQuery(): string',
            returnType: 'string',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };
      symbolRepo.replaceFileSymbols(file.id, [builder]);

      schemaRepo.replaceCurrentSchemaFromImport(repo.id, [
        {
          name: 'recurring_quotes',
          normalizedName: 'recurring_quotes',
          sourcePath: null,
          lineStart: null,
          lineEnd: null,
          columns: [
            {
              name: 'quote_id',
              normalizedName: 'quote_id',
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
        {
          name: 'recurring_quote_sections',
          normalizedName: 'recurring_quote_sections',
          sourcePath: null,
          lineStart: null,
          lineEnd: null,
          columns: [
            {
              name: 'quote_id',
              normalizedName: 'quote_id',
              dataType: 'integer',
              isNullable: false,
              defaultValue: null,
              ordinalPosition: 1,
              sourcePath: null,
              lineNumber: null,
            },
            {
              name: 'section_id',
              normalizedName: 'section_id',
              dataType: 'integer',
              isNullable: false,
              defaultValue: null,
              ordinalPosition: 2,
              sourcePath: null,
              lineNumber: null,
            },
            {
              name: 'display_order',
              normalizedName: 'display_order',
              dataType: 'integer',
              isNullable: false,
              defaultValue: null,
              ordinalPosition: 3,
              sourcePath: null,
              lineNumber: null,
            },
          ],
          foreignKeys: [
            {
              constraintName: 'fk_sections_quote',
              sourceColumns: ['quote_id'],
              targetTable: 'recurring_quotes',
              normalizedTargetTable: 'recurring_quotes',
              targetColumns: ['quote_id'],
              sourcePath: null,
              lineNumber: null,
            },
          ],
        },
      ]);

      const result = handleSqlValidate({
        repoId: repo.id,
        repoPath: tmpDir,
        schemaRepo,
        symbolRepo,
        fileRepo,
      }, {
        symbol: 'App\\Builder\\RecurringQuoteBuilder',
      });

      expect(result).toContain('## SQL Validation: App\\Builder\\RecurringQuoteBuilder');
      expect(result).toContain('recurring_quote_sections, recurring_quotes');
      expect(result).toContain('Verified column: recurring_quote_sections.display_order');
      expect(result).toContain('Verified column: recurring_quote_sections.section_id');
      expect(result).toContain('FK-backed join: recurring_quotes.quote_id = recurring_quote_sections.quote_id');
      expect(result).toContain('Missing column in current schema: recurring_quote_sections.missing_column');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      db.close();
    }
  });
});
