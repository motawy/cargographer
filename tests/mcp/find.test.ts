import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../../src/db/repositories/reference-repository.js';
import { handleFind } from '../../src/mcp/tools/find.js';
import type { ToolDeps } from '../../src/mcp/types.js';
import type { ParsedSymbol } from '../../src/types.js';

const TEST_DB = {
  host: 'localhost', port: 5435,
  database: 'cartograph_test', user: 'cartograph', password: 'localdev',
};

function makeClass(name: string, qn: string): ParsedSymbol {
  return {
    name, qualifiedName: qn, kind: 'class', visibility: null,
    lineStart: 1, lineEnd: 10, signature: null, returnType: null,
    docblock: null, children: [], metadata: {},
  };
}

describe('cartograph_find', () => {
  let pool: pg.Pool;
  let deps: ToolDeps;
  let repoId: number;

  beforeAll(async () => {
    pool = new pg.Pool(TEST_DB);
    const repoRepo = new RepoRepository(pool);
    const fileRepo = new FileRepository(pool);
    const symbolRepo = new SymbolRepository(pool);
    const refRepo = new ReferenceRepository(pool);

    // Clean + seed
    await pool.query('DELETE FROM symbol_references');
    await pool.query('DELETE FROM symbols');
    await pool.query('DELETE FROM files');
    await pool.query('DELETE FROM repos');

    const repo = await repoRepo.findOrCreate('/test/repo', 'test');
    repoId = repo.id;

    const f1 = await fileRepo.upsert(repoId, 'app/Services/UserService.php', 'php', 'h1', 40);
    const f2 = await fileRepo.upsert(repoId, 'app/Models/User.php', 'php', 'h2', 30);
    const f3 = await fileRepo.upsert(repoId, 'app/Services/OrderService.php', 'php', 'h3', 20);

    await symbolRepo.replaceFileSymbols(f1.id, [makeClass('UserService', 'App\\Services\\UserService')]);
    await symbolRepo.replaceFileSymbols(f2.id, [makeClass('User', 'App\\Models\\User')]);
    await symbolRepo.replaceFileSymbols(f3.id, [makeClass('OrderService', 'App\\Services\\OrderService')]);

    deps = { repoId, symbolRepo, refRepo };
  });

  afterAll(async () => {
    await pool.end();
  });

  it('finds symbols by substring', async () => {
    const result = await handleFind(deps, { query: 'Service' });
    expect(result).toContain('UserService');
    expect(result).toContain('OrderService');
    expect(result).toContain('## Search:');
    expect(result).toContain('Found');
  });

  it('finds symbols by wildcard pattern', async () => {
    const result = await handleFind(deps, { query: 'App\\Services\\*' });
    expect(result).toContain('UserService');
    expect(result).toContain('OrderService');
  });

  it('filters by kind', async () => {
    const result = await handleFind(deps, { query: 'User', kind: 'class' });
    expect(result).toContain('class');
  });

  it('respects limit', async () => {
    const result = await handleFind(deps, { query: '%', limit: 1 });
    // Should contain exactly 1 table row (after header row)
    const tableRows = result.split('\n').filter(l => l.startsWith('|') && !l.includes('---') && !l.includes('Symbol'));
    expect(tableRows).toHaveLength(1);
  });

  it('returns no-results message', async () => {
    const result = await handleFind(deps, { query: 'Nonexistent' });
    expect(result).toContain('No symbols found');
  });

  it('filters by file path', async () => {
    const result = await handleFind(deps, { query: '%', path: 'app/Services' });
    expect(result).toContain('UserService');
    expect(result).toContain('OrderService');
    expect(result).not.toContain('App\\Models\\User'); // User is in app/Models, not app/Services
  });
});
