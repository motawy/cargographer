import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { handleRoutePairs } from '../../src/mcp/tools/route-pairs.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('cartograph_route_pairs', () => {
  it('pairs nested routes with likely flat equivalents and flags missing ones', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      runMigrations(db);
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const repo = repoRepo.findOrCreate('/test/route-pairs', 'test-route-pairs');

      const files = [
        ['src/Route/Root/Companies/CostCenterAssets.php', 'App\\Route\\Root\\Companies\\CostCenterAssets'],
        ['src/Route/Root/Companies/CostCenterAssetsInterface.php', 'App\\Route\\Root\\Companies\\CostCenterAssetsInterface'],
        ['src/Route/Root/Companies/Jobs/Sections/CostCenters/Assets.php', 'App\\Route\\Root\\Companies\\Jobs\\Sections\\CostCenters\\Assets'],
        ['src/Route/Root/Companies/Jobs/Sections/CostCenters/AssetsInterface.php', 'App\\Route\\Root\\Companies\\Jobs\\Sections\\CostCenters\\AssetsInterface'],
        ['src/Route/Root/Companies/Quotes/Sections/CostCenters/AssetsInterface.php', 'App\\Route\\Root\\Companies\\Quotes\\Sections\\CostCenters\\AssetsInterface'],
        ['src/Route/Root/Companies/Jobs/Sections/CostCenters/LaborsInterface.php', 'App\\Route\\Root\\Companies\\Jobs\\Sections\\CostCenters\\LaborsInterface'],
      ] as const;

      for (const [path, qualifiedName] of files) {
        const file = fileRepo.upsert(repo.id, path, 'php', path, 10);
        const symbol: ParsedSymbol = {
          name: qualifiedName.split('\\').pop()!,
          qualifiedName,
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
        symbolRepo.replaceFileSymbols(file.id, [symbol]);
      }

      const result = handleRoutePairs(
        { repoId: repo.id, symbolRepo },
        { query: 'CostCenters', path: 'Route/Root/Companies' }
      );

      expect(result).toContain('## Route Pairs');
      expect(result).toContain('Jobs/Sections/CostCenters/Assets');
      expect(result).toContain('CostCenterAssetsInterface');
      expect(result).toContain('Quotes/Sections/CostCenters/Assets');
      expect(result).toContain('Labors');
      expect(result).toContain('Likely flat equivalent: none found');
      expect(result).toContain('### Flat -> nested');
    } finally {
      db.close();
    }
  });

  it('does not match nested routes to unrelated global leaf-name routes', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      runMigrations(db);
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const repo = repoRepo.findOrCreate('/test/route-pairs-catalogs', 'test-route-pairs-catalogs');

      const files = [
        ['src/Route/Root/Companies/CatalogInterface.php', 'App\\Route\\Root\\Companies\\CatalogInterface'],
        ['src/Route/Root/Companies/CostCenterCatalogsInterface.php', 'App\\Route\\Root\\Companies\\CostCenterCatalogsInterface'],
        ['src/Route/Root/Companies/Jobs/Sections/CostCenters/CatalogsInterface.php', 'App\\Route\\Root\\Companies\\Jobs\\Sections\\CostCenters\\CatalogsInterface'],
      ] as const;

      for (const [path, qualifiedName] of files) {
        const file = fileRepo.upsert(repo.id, path, 'php', path, 10);
        const symbol: ParsedSymbol = {
          name: qualifiedName.split('\\').pop()!,
          qualifiedName,
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
        symbolRepo.replaceFileSymbols(file.id, [symbol]);
      }

      const result = handleRoutePairs(
        { repoId: repo.id, symbolRepo },
        { query: 'Catalog', path: 'Route/Root/Companies' }
      );

      expect(result).toContain('Jobs/Sections/CostCenters/Catalogs');
      expect(result).toContain('App\\Route\\Root\\Companies\\CostCenterCatalogsInterface');
      expect(result).not.toContain('App\\Route\\Root\\Companies\\CatalogInterface');
    } finally {
      db.close();
    }
  });
});
