import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../../src/db/repositories/reference-repository.js';
import { DbSchemaRepository } from '../../src/db/repositories/db-schema-repository.js';
import { SymbolSchemaRepository } from '../../src/db/repositories/symbol-schema-repository.js';
import { handleTableUsage } from '../../src/mcp/tools/table-usage.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('cartograph_table_usage', () => {
  it('bridges a table to its mapped entity and code touchpoints', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      runMigrations(db);
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const refRepo = new ReferenceRepository(db);
      const schemaRepo = new DbSchemaRepository(db);
      const symbolSchemaRepo = new SymbolSchemaRepository(db);

      const repo = repoRepo.findOrCreate('/test/repo', 'test');
      const entityFile = fileRepo.upsert(repo.id, 'src/Entity/RecurringQuote.php', 'php', 'e1', 20);
      const modelFile = fileRepo.upsert(repo.id, 'src/Model/RecurringQuoteModel.php', 'php', 'm1', 20);

      const entity: ParsedSymbol = {
        name: 'RecurringQuote',
        qualifiedName: 'App\\Entity\\RecurringQuote',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 20,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [
          {
            name: 'id',
            qualifiedName: 'App\\Entity\\RecurringQuote::$id',
            kind: 'property',
            visibility: 'private',
            lineStart: 5,
            lineEnd: 5,
            signature: null,
            returnType: 'int',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

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
        children: [
          {
            name: 'getEntityClass',
            qualifiedName: 'App\\Model\\RecurringQuoteModel::getEntityClass',
            kind: 'method',
            visibility: 'public',
            lineStart: 5,
            lineEnd: 8,
            signature: 'getEntityClass(): string',
            returnType: 'string',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

      const entityMap = symbolRepo.replaceFileSymbols(entityFile.id, [entity]);
      const modelMap = symbolRepo.replaceFileSymbols(modelFile.id, [model]);

      symbolSchemaRepo.replaceFileLinks(
        entityFile.id,
        entityMap,
        [
          {
            sourceQualifiedName: 'App\\Entity\\RecurringQuote',
            tableName: 'recurring_quotes',
            normalizedTableName: 'recurring_quotes',
            linkKind: 'entity_table',
          },
        ],
        [
          {
            sourceQualifiedName: 'App\\Entity\\RecurringQuote::$id',
            tableName: 'recurring_quotes',
            normalizedTableName: 'recurring_quotes',
            columnName: 'quote_id',
            normalizedColumnName: 'quote_id',
            referencedColumnName: null,
            normalizedReferencedColumnName: null,
            linkKind: 'entity_column',
          },
        ]
      );

      refRepo.replaceFileReferences(modelFile.id, modelMap, [
        {
          sourceQualifiedName: 'App\\Model\\RecurringQuoteModel::getEntityClass',
          targetQualifiedName: 'app\\entity\\recurringquote',
          kind: 'class_reference',
          line: 6,
        },
      ]);
      refRepo.resolveTargets(repo.id);

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
      ]);

      const result = handleTableUsage({
        repoId: repo.id,
        schemaRepo,
        symbolSchemaRepo,
        refRepo,
      }, {
        name: 'recurring_quotes',
        depth: 2,
        limit: 10,
      });

      expect(result).toContain('## Table Usage: recurring_quotes');
      expect(result).toContain('App\\Entity\\RecurringQuote');
      expect(result).toContain('$id -> quote_id');
      expect(result).toContain('App\\Model\\RecurringQuoteModel::getEntityClass');
    } finally {
      db.close();
    }
  });
});
