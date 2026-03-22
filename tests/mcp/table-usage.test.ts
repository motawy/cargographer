import { mkdirSync, rmSync, writeFileSync } from 'fs';
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

  it('shows direct table-name references and hides tests by default', () => {
    const db = openDatabase({ path: ':memory:' });
    const tmpDir = '/tmp/cartograph-table-usage-direct-test';

    try {
      mkdirSync(`${tmpDir}/src/Builder`, { recursive: true });
      mkdirSync(`${tmpDir}/tests/Builder`, { recursive: true });
      writeFileSync(`${tmpDir}/src/Builder/RecurringQuoteSectionsBuilder.php`, [
        '<?php',
        'namespace App\\Builder;',
        'class RecurringQuoteSectionsBuilder {',
        '    public function loadArray(): array',
        '    {',
        "        return ['table' => 'recurring_quote_sections'];",
        '    }',
        '}',
      ].join('\n'));
      writeFileSync(`${tmpDir}/tests/Builder/RecurringQuoteSectionsBuilderTest.php`, [
        '<?php',
        'namespace Tests\\Builder;',
        'class RecurringQuoteSectionsBuilderTest {',
        '    public function testUsesTableName(): void',
        '    {',
        "        $this->assertSame('recurring_quote_sections', 'recurring_quote_sections');",
        '    }',
        '}',
      ].join('\n'));

      runMigrations(db);
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const refRepo = new ReferenceRepository(db);
      const schemaRepo = new DbSchemaRepository(db);
      const symbolSchemaRepo = new SymbolSchemaRepository(db);

      const repo = repoRepo.findOrCreate(tmpDir, 'direct-refs');
      const builderFile = fileRepo.upsert(repo.id, 'src/Builder/RecurringQuoteSectionsBuilder.php', 'php', 'b1', 8);
      const testFile = fileRepo.upsert(repo.id, 'tests/Builder/RecurringQuoteSectionsBuilderTest.php', 'php', 't1', 8);

      const builder: ParsedSymbol = {
        name: 'RecurringQuoteSectionsBuilder',
        qualifiedName: 'App\\Builder\\RecurringQuoteSectionsBuilder',
        kind: 'class',
        visibility: null,
        lineStart: 3,
        lineEnd: 8,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [
          {
            name: 'loadArray',
            qualifiedName: 'App\\Builder\\RecurringQuoteSectionsBuilder::loadArray',
            kind: 'method',
            visibility: 'public',
            lineStart: 4,
            lineEnd: 7,
            signature: 'loadArray(): array',
            returnType: 'array',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

      const builderTest: ParsedSymbol = {
        name: 'RecurringQuoteSectionsBuilderTest',
        qualifiedName: 'Tests\\Builder\\RecurringQuoteSectionsBuilderTest',
        kind: 'class',
        visibility: null,
        lineStart: 3,
        lineEnd: 8,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [
          {
            name: 'testUsesTableName',
            qualifiedName: 'Tests\\Builder\\RecurringQuoteSectionsBuilderTest::testUsesTableName',
            kind: 'method',
            visibility: 'public',
            lineStart: 4,
            lineEnd: 7,
            signature: 'testUsesTableName(): void',
            returnType: 'void',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

      symbolRepo.replaceFileSymbols(builderFile.id, [builder]);
      symbolRepo.replaceFileSymbols(testFile.id, [builderTest]);

      schemaRepo.replaceCurrentSchemaFromImport(repo.id, [
        {
          name: 'recurring_quote_sections',
          normalizedName: 'recurring_quote_sections',
          sourcePath: null,
          lineStart: null,
          lineEnd: null,
          columns: [],
          foreignKeys: [],
        },
      ]);

      const result = handleTableUsage({
        repoId: repo.id,
        repoPath: tmpDir,
        fileRepo,
        symbolRepo,
        schemaRepo,
        symbolSchemaRepo,
        refRepo,
      }, {
        name: 'recurring_quote_sections',
        limit: 10,
      });

      expect(result).toContain('No Doctrine-style entity mappings were found for this table.');
      expect(result).toContain('Direct Table Name References');
      expect(result).toContain('App\\Builder\\RecurringQuoteSectionsBuilder::loadArray');
      expect(result).not.toContain('Tests\\Builder\\RecurringQuoteSectionsBuilderTest::testUsesTableName');

      const withTests = handleTableUsage({
        repoId: repo.id,
        repoPath: tmpDir,
        fileRepo,
        symbolRepo,
        schemaRepo,
        symbolSchemaRepo,
        refRepo,
      }, {
        name: 'recurring_quote_sections',
        limit: 10,
        includeTests: true,
      });

      expect(withTests).toContain('#### Tests');
      expect(withTests).toContain('Tests\\Builder\\RecurringQuoteSectionsBuilderTest::testUsesTableName');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      db.close();
    }
  });

  it('filters noisy substring matches for common table names', () => {
    const db = openDatabase({ path: ':memory:' });
    const tmpDir = '/tmp/cartograph-table-usage-noise-test';

    try {
      mkdirSync(`${tmpDir}/src/Builder`, { recursive: true });
      mkdirSync(`${tmpDir}/src/Model`, { recursive: true });
      mkdirSync(`${tmpDir}/src/Misc`, { recursive: true });

      writeFileSync(`${tmpDir}/src/Builder/QuotesBuilder.php`, [
        '<?php',
        'namespace App\\Builder;',
        'class QuotesBuilder {',
        '    public function load(): string',
        '    {',
        '        return "SELECT * FROM quotes q";',
        '    }',
        '}',
      ].join('\n'));

      writeFileSync(`${tmpDir}/src/Model/QuotesModel.php`, [
        '<?php',
        'namespace App\\Model;',
        'class QuotesModel {',
        '    public function getDBTable(): string',
        '    {',
        "        return 'quotes';",
        '    }',
        '}',
      ].join('\n'));

      writeFileSync(`${tmpDir}/src/Misc/Noise.php`, [
        '<?php',
        'namespace App\\Misc;',
        'class Noise {',
        '    public function describe(): void',
        '    {',
        '        ENT_QUOTES;',
        '        $JobsQuotes = [];',
        '        $quoteSigned = true;',
        "        $folder = 'quotesignatures';",
        "        $other = 'quote_quotes';",
        '        $label = "strings escaped and wrapped in quotes";',
        "        $permission = 'CreateQuotes';",
        '    }',
        '}',
      ].join('\n'));

      runMigrations(db);
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const refRepo = new ReferenceRepository(db);
      const schemaRepo = new DbSchemaRepository(db);
      const symbolSchemaRepo = new SymbolSchemaRepository(db);

      const repo = repoRepo.findOrCreate(tmpDir, 'common-name-noise');
      const builderFile = fileRepo.upsert(repo.id, 'src/Builder/QuotesBuilder.php', 'php', 'n1', 8);
      const modelFile = fileRepo.upsert(repo.id, 'src/Model/QuotesModel.php', 'php', 'n2', 8);
      const noiseFile = fileRepo.upsert(repo.id, 'src/Misc/Noise.php', 'php', 'n3', 14);

      const builder: ParsedSymbol = {
        name: 'QuotesBuilder',
        qualifiedName: 'App\\Builder\\QuotesBuilder',
        kind: 'class',
        visibility: null,
        lineStart: 3,
        lineEnd: 8,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [
          {
            name: 'load',
            qualifiedName: 'App\\Builder\\QuotesBuilder::load',
            kind: 'method',
            visibility: 'public',
            lineStart: 4,
            lineEnd: 7,
            signature: 'load(): string',
            returnType: 'string',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

      const model: ParsedSymbol = {
        name: 'QuotesModel',
        qualifiedName: 'App\\Model\\QuotesModel',
        kind: 'class',
        visibility: null,
        lineStart: 3,
        lineEnd: 8,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [
          {
            name: 'getDBTable',
            qualifiedName: 'App\\Model\\QuotesModel::getDBTable',
            kind: 'method',
            visibility: 'public',
            lineStart: 4,
            lineEnd: 7,
            signature: 'getDBTable(): string',
            returnType: 'string',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

      const noise: ParsedSymbol = {
        name: 'Noise',
        qualifiedName: 'App\\Misc\\Noise',
        kind: 'class',
        visibility: null,
        lineStart: 3,
        lineEnd: 14,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [
          {
            name: 'describe',
            qualifiedName: 'App\\Misc\\Noise::describe',
            kind: 'method',
            visibility: 'public',
            lineStart: 4,
            lineEnd: 13,
            signature: 'describe(): void',
            returnType: 'void',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

      symbolRepo.replaceFileSymbols(builderFile.id, [builder]);
      symbolRepo.replaceFileSymbols(modelFile.id, [model]);
      symbolRepo.replaceFileSymbols(noiseFile.id, [noise]);

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

      const result = handleTableUsage({
        repoId: repo.id,
        repoPath: tmpDir,
        fileRepo,
        symbolRepo,
        schemaRepo,
        symbolSchemaRepo,
        refRepo,
      }, {
        name: 'quotes',
        limit: 10,
      });

      expect(result).toContain('App\\Builder\\QuotesBuilder::load');
      expect(result).toContain('App\\Model\\QuotesModel::getDBTable');
      expect(result).not.toContain('App\\Misc\\Noise::describe');
      expect(result).not.toContain('ENT_QUOTES');
      expect(result).not.toContain('quote_quotes');
      expect(result).not.toContain('CreateQuotes');
      expect(result).not.toContain('wrapped in quotes');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      db.close();
    }
  });

  it('groups direct table-name references by architectural layer', () => {
    const db = openDatabase({ path: ':memory:' });
    const tmpDir = '/tmp/cartograph-table-usage-layer-test';

    try {
      mkdirSync(`${tmpDir}/src/Builder`, { recursive: true });
      mkdirSync(`${tmpDir}/src/Model`, { recursive: true });
      mkdirSync(`${tmpDir}/reports`, { recursive: true });
      mkdirSync(`${tmpDir}/staff`, { recursive: true });

      writeFileSync(`${tmpDir}/src/Builder/QuotesBuilder.php`, [
        '<?php',
        'namespace App\\Builder;',
        'class QuotesBuilder {',
        '    public function load(): string',
        '    {',
        '        return "SELECT * FROM quotes";',
        '    }',
        '}',
      ].join('\n'));

      writeFileSync(`${tmpDir}/src/Model/QuotesModel.php`, [
        '<?php',
        'namespace App\\Model;',
        'class QuotesModel {',
        '    public function getDBTable(): string',
        '    {',
        "        return 'quotes';",
        '    }',
        '}',
      ].join('\n'));

      writeFileSync(`${tmpDir}/reports/QuotesReport.php`, [
        '<?php',
        'namespace App\\Reports;',
        'class QuotesReport {',
        '    public function fetch(): string',
        '    {',
        '        return "SELECT * FROM quotes";',
        '    }',
        '}',
      ].join('\n'));

      writeFileSync(`${tmpDir}/staff/QuotesPage.php`, [
        '<?php',
        'namespace App\\Staff;',
        'class QuotesPage {',
        '    public function render(): string',
        '    {',
        '        return "SELECT * FROM quotes";',
        '    }',
        '}',
      ].join('\n'));

      runMigrations(db);
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const refRepo = new ReferenceRepository(db);
      const schemaRepo = new DbSchemaRepository(db);
      const symbolSchemaRepo = new SymbolSchemaRepository(db);

      const repo = repoRepo.findOrCreate(tmpDir, 'layer-groups');
      const builderFile = fileRepo.upsert(repo.id, 'src/Builder/QuotesBuilder.php', 'php', 'lg1', 8);
      const modelFile = fileRepo.upsert(repo.id, 'src/Model/QuotesModel.php', 'php', 'lg2', 8);
      const reportFile = fileRepo.upsert(repo.id, 'reports/QuotesReport.php', 'php', 'lg3', 8);
      const staffFile = fileRepo.upsert(repo.id, 'staff/QuotesPage.php', 'php', 'lg4', 8);

      symbolRepo.replaceFileSymbols(builderFile.id, [{
        name: 'QuotesBuilder',
        qualifiedName: 'App\\Builder\\QuotesBuilder',
        kind: 'class',
        visibility: null,
        lineStart: 3,
        lineEnd: 8,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [{
          name: 'load',
          qualifiedName: 'App\\Builder\\QuotesBuilder::load',
          kind: 'method',
          visibility: 'public',
          lineStart: 4,
          lineEnd: 7,
          signature: 'load(): string',
          returnType: 'string',
          docblock: null,
          metadata: {},
          children: [],
        }],
      }]);

      symbolRepo.replaceFileSymbols(modelFile.id, [{
        name: 'QuotesModel',
        qualifiedName: 'App\\Model\\QuotesModel',
        kind: 'class',
        visibility: null,
        lineStart: 3,
        lineEnd: 8,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [{
          name: 'getDBTable',
          qualifiedName: 'App\\Model\\QuotesModel::getDBTable',
          kind: 'method',
          visibility: 'public',
          lineStart: 4,
          lineEnd: 7,
          signature: 'getDBTable(): string',
          returnType: 'string',
          docblock: null,
          metadata: {},
          children: [],
        }],
      }]);

      symbolRepo.replaceFileSymbols(reportFile.id, [{
        name: 'QuotesReport',
        qualifiedName: 'App\\Reports\\QuotesReport',
        kind: 'class',
        visibility: null,
        lineStart: 3,
        lineEnd: 8,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [{
          name: 'fetch',
          qualifiedName: 'App\\Reports\\QuotesReport::fetch',
          kind: 'method',
          visibility: 'public',
          lineStart: 4,
          lineEnd: 7,
          signature: 'fetch(): string',
          returnType: 'string',
          docblock: null,
          metadata: {},
          children: [],
        }],
      }]);

      symbolRepo.replaceFileSymbols(staffFile.id, [{
        name: 'QuotesPage',
        qualifiedName: 'App\\Staff\\QuotesPage',
        kind: 'class',
        visibility: null,
        lineStart: 3,
        lineEnd: 8,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [{
          name: 'render',
          qualifiedName: 'App\\Staff\\QuotesPage::render',
          kind: 'method',
          visibility: 'public',
          lineStart: 4,
          lineEnd: 7,
          signature: 'render(): string',
          returnType: 'string',
          docblock: null,
          metadata: {},
          children: [],
        }],
      }]);

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

      const result = handleTableUsage({
        repoId: repo.id,
        repoPath: tmpDir,
        fileRepo,
        symbolRepo,
        schemaRepo,
        symbolSchemaRepo,
        refRepo,
      }, {
        name: 'quotes',
        limit: 10,
      });

      expect(result).toContain('#### Builder (1)');
      expect(result).toContain('App\\Builder\\QuotesBuilder::load');
      expect(result).toContain('#### Model (1)');
      expect(result).toContain('App\\Model\\QuotesModel::getDBTable');
      expect(result).toContain('#### Report (1)');
      expect(result).toContain('App\\Reports\\QuotesReport::fetch');
      expect(result).toContain('#### Staff Page (1)');
      expect(result).toContain('App\\Staff\\QuotesPage::render');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      db.close();
    }
  });
});
