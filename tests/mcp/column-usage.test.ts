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
import { handleColumnUsage } from '../../src/mcp/tools/column-usage.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('cartograph_column_usage', () => {
  it('shows mapped properties and scoped write-like column refs', () => {
    const db = openDatabase({ path: ':memory:' });
    const tmpDir = '/tmp/cartograph-column-usage-test';

    try {
      runMigrations(db);
      mkdirSync(`${tmpDir}/src/Builder`, { recursive: true });
      mkdirSync(`${tmpDir}/src/Entity`, { recursive: true });

      writeFileSync(`${tmpDir}/src/Builder/RecurringQuoteSectionsBuilder.php`, [
        '<?php',
        'class RecurringQuoteSectionsBuilder {',
        '    protected function reorder(): void',
        '    {',
        "        $sql = 'UPDATE recurring_quote_sections SET display_order = :display_order WHERE section_id = :section_id';",
        "        $sort = 'ORDER BY display_order ASC';",
        '    }',
        '}',
      ].join('\n'));

      writeFileSync(`${tmpDir}/src/Entity/RecurringQuoteSection.php`, [
        '<?php',
        'class RecurringQuoteSection {',
        "    #[ORM\\Column(name: 'display_order')]",
        '    private int $displayOrder;',
        '}',
      ].join('\n'));

      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const schemaRepo = new DbSchemaRepository(db);
      const symbolSchemaRepo = new SymbolSchemaRepository(db);
      const tableReferenceRepo = new TableReferenceRepository(db);
      const repo = repoRepo.findOrCreate(tmpDir, 'column-usage');

      const builderFile = fileRepo.upsert(repo.id, 'src/Builder/RecurringQuoteSectionsBuilder.php', 'php', 'cu1', 8);
      const entityFile = fileRepo.upsert(repo.id, 'src/Entity/RecurringQuoteSection.php', 'php', 'cu2', 5);

      const builder: ParsedSymbol = {
        name: 'RecurringQuoteSectionsBuilder',
        qualifiedName: 'App\\Builder\\RecurringQuoteSectionsBuilder',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 8,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [
          {
            name: 'reorder',
            qualifiedName: 'App\\Builder\\RecurringQuoteSectionsBuilder::reorder',
            kind: 'method',
            visibility: 'protected',
            lineStart: 3,
            lineEnd: 7,
            signature: 'reorder(): void',
            returnType: 'void',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };
      const entity: ParsedSymbol = {
        name: 'RecurringQuoteSection',
        qualifiedName: 'App\\Entity\\RecurringQuoteSection',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 5,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [
          {
            name: 'displayOrder',
            qualifiedName: 'App\\Entity\\RecurringQuoteSection::$displayOrder',
            kind: 'property',
            visibility: 'private',
            lineStart: 4,
            lineEnd: 4,
            signature: null,
            returnType: 'int',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

      const builderMap = symbolRepo.replaceFileSymbols(builderFile.id, [builder]);
      const entityMap = symbolRepo.replaceFileSymbols(entityFile.id, [entity]);

      symbolSchemaRepo.replaceFileLinks(entityFile.id, entityMap, [
        {
          sourceQualifiedName: 'App\\Entity\\RecurringQuoteSection',
          tableName: 'recurring_quote_sections',
          normalizedTableName: 'recurring_quote_sections',
          linkKind: 'entity_table',
        },
      ], [
        {
          sourceQualifiedName: 'App\\Entity\\RecurringQuoteSection::$displayOrder',
          tableName: 'recurring_quote_sections',
          normalizedTableName: 'recurring_quote_sections',
          columnName: 'display_order',
          normalizedColumnName: 'display_order',
          referencedColumnName: null,
          normalizedReferencedColumnName: null,
          linkKind: 'entity_column',
        },
      ]);

      schemaRepo.replaceCurrentSchemaFromImport(repo.id, [
        {
          name: 'recurring_quote_sections',
          normalizedName: 'recurring_quote_sections',
          sourcePath: null,
          lineStart: null,
          lineEnd: null,
          columns: [
            {
              name: 'display_order',
              normalizedName: 'display_order',
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

      tableReferenceRepo.replaceRepoReferences(repo.id, [
        {
          sourceFileId: builderFile.id,
          sourceSymbolId: builderMap.get('App\\Builder\\RecurringQuoteSectionsBuilder::reorder') ?? null,
          tableName: 'recurring_quote_sections',
          normalizedTableName: 'recurring_quote_sections',
          referenceKind: 'sql_literal',
          lineNumber: 5,
          preview: "UPDATE recurring_quote_sections SET display_order = :display_order WHERE section_id = :section_id",
        },
      ]);

      const result = handleColumnUsage({
        repoId: repo.id,
        repoPath: tmpDir,
        schemaRepo,
        symbolSchemaRepo,
        tableReferenceRepo,
        symbolRepo,
      }, {
        table: 'recurring_quote_sections',
        column: 'display_order',
      });

      expect(result).toContain('## Column Usage: recurring_quote_sections.display_order');
      expect(result).toContain('App\\Entity\\RecurringQuoteSection::$displayOrder');
      expect(result).toContain('### Likely write refs');
      expect(result).toContain('App\\Builder\\RecurringQuoteSectionsBuilder::reorder');
      expect(result).toContain('UPDATE recurring_quote_sections SET display_order');
      expect(result).toContain('### Other column refs');
      expect(result).toContain('ORDER BY display_order ASC');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      db.close();
    }
  });
});
