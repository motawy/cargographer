import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { DbSchemaRepository } from '../../src/db/repositories/db-schema-repository.js';
import { SymbolSchemaRepository } from '../../src/db/repositories/symbol-schema-repository.js';
import { renderTableUsageForRepo } from '../../src/cli/table-usage.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('renderTableUsageForRepo', () => {
  it('renders schema-to-code usage for an indexed repo', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      runMigrations(db);
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const schemaRepo = new DbSchemaRepository(db);
      const symbolSchemaRepo = new SymbolSchemaRepository(db);
      const repo = repoRepo.findOrCreate('/test/repo', 'test');
      const file = fileRepo.upsert(repo.id, 'src/Entity/Quote.php', 'php', 'h1', 10);

      const entity: ParsedSymbol = {
        name: 'Quote',
        qualifiedName: 'App\\Entity\\Quote',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 10,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [],
      };
      const symbolMap = symbolRepo.replaceFileSymbols(file.id, [entity]);

      symbolSchemaRepo.replaceFileLinks(file.id, symbolMap, [
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

      const result = renderTableUsageForRepo(db, '/test/repo', 'quotes');
      expect(result).toContain('Table Usage: quotes');
      expect(result).toContain('App\\Entity\\Quote');
    } finally {
      db.close();
    }
  });
});
