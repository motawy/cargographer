import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { renderRoutePairsForRepo } from '../../src/cli/route-pairs.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('renderRoutePairsForRepo', () => {
  it('renders nested-vs-flat route pairs for an indexed repo', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      runMigrations(db);
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const repo = repoRepo.findOrCreate('/test/route-cli', 'route-cli');

      const flatFile = fileRepo.upsert(repo.id, 'src/Route/Root/Companies/CostCenterAssetsInterface.php', 'php', 'rp1', 10);
      const nestedFile = fileRepo.upsert(repo.id, 'src/Route/Root/Companies/Jobs/Sections/CostCenters/AssetsInterface.php', 'php', 'rp2', 10);

      const flat: ParsedSymbol = {
        name: 'CostCenterAssetsInterface',
        qualifiedName: 'App\\Route\\Root\\Companies\\CostCenterAssetsInterface',
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
      const nested: ParsedSymbol = {
        name: 'AssetsInterface',
        qualifiedName: 'App\\Route\\Root\\Companies\\Jobs\\Sections\\CostCenters\\AssetsInterface',
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

      symbolRepo.replaceFileSymbols(flatFile.id, [flat]);
      symbolRepo.replaceFileSymbols(nestedFile.id, [nested]);

      const result = renderRoutePairsForRepo(db, '/test/route-cli', 'CostCenters');
      expect(result).toContain('Jobs/Sections/CostCenters/Assets');
      expect(result).toContain('CostCenterAssetsInterface');
    } finally {
      db.close();
    }
  });
});
