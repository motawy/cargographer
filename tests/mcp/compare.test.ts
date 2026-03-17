import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../../src/db/repositories/reference-repository.js';
import { handleCompare } from '../../src/mcp/tools/compare.js';
import type { ToolDeps } from '../../src/mcp/types.js';
import type { ParsedSymbol } from '../../src/types.js';

const TEST_DB = {
  host: 'localhost', port: 5435,
  database: 'cartograph_test', user: 'cartograph', password: 'localdev',
};

function makeClassWithMethods(
  name: string,
  qn: string,
  methods: { name: string; signature?: string; visibility?: string; line: number }[]
): ParsedSymbol {
  return {
    name, qualifiedName: qn, kind: 'class', visibility: null,
    lineStart: 1, lineEnd: 50, signature: null, returnType: null,
    docblock: null, metadata: {},
    children: methods.map(m => ({
      name: m.name,
      qualifiedName: `${qn}::${m.name}`,
      kind: 'method' as const,
      visibility: (m.visibility ?? 'public') as 'public',
      lineStart: m.line, lineEnd: m.line + 5,
      signature: m.signature ?? null, returnType: null,
      docblock: null, children: [], metadata: {},
    })),
  };
}

describe('cartograph_compare', () => {
  let pool: pg.Pool;
  let deps: ToolDeps;

  beforeAll(async () => {
    pool = new pg.Pool(TEST_DB);
    const repoRepo = new RepoRepository(pool);
    const fileRepo = new FileRepository(pool);
    const symbolRepo = new SymbolRepository(pool);
    const refRepo = new ReferenceRepository(pool);

    await pool.query('DELETE FROM symbol_references');
    await pool.query('DELETE FROM symbols');
    await pool.query('DELETE FROM files');
    await pool.query('DELETE FROM repos');

    const repo = await repoRepo.findOrCreate('/test/repo', 'test');
    const f1 = await fileRepo.upsert(repo.id, 'app/Routes/JobCostCenters.php', 'php', 'h1', 50);
    const f2 = await fileRepo.upsert(repo.id, 'app/Routes/RecurringJobCostCenters.php', 'php', 'h2', 50);

    await symbolRepo.replaceFileSymbols(f1.id, [
      makeClassWithMethods('JobCostCenters', 'App\\Routes\\JobCostCenters', [
        { name: 'getControllerName', line: 10, signature: 'getControllerName(): string' },
        { name: 'getBuilderName', line: 15, signature: 'getBuilderName(): string' },
        { name: 'getSubRouteFolder', line: 20, signature: 'getSubRouteFolder(): string' },
        { name: 'getModelName', line: 25, signature: 'getModelName(): string' },
      ]),
    ]);

    await symbolRepo.replaceFileSymbols(f2.id, [
      makeClassWithMethods('RecurringJobCostCenters', 'App\\Routes\\RecurringJobCostCenters', [
        { name: 'getControllerName', line: 10, signature: 'getControllerName(): string' },
        { name: 'getBuilderName', line: 15, signature: 'getBuilderName(): string' },
        { name: 'getModelName', line: 20, signature: 'getModelName(): string' },
      ]),
    ]);

    deps = { repoId: repo.id, symbolRepo, refRepo };
  });

  afterAll(async () => {
    await pool.end();
  });

  it('shows methods in A but not in B', async () => {
    const result = await handleCompare(deps, {
      symbolA: 'App\\Routes\\JobCostCenters',
      symbolB: 'App\\Routes\\RecurringJobCostCenters',
    });
    expect(result).toContain('getSubRouteFolder');
    expect(result).toContain('In App\\Routes\\JobCostCenters but NOT in');
  });

  it('shows shared methods', async () => {
    const result = await handleCompare(deps, {
      symbolA: 'App\\Routes\\JobCostCenters',
      symbolB: 'App\\Routes\\RecurringJobCostCenters',
    });
    expect(result).toContain('Shared');
    expect(result).toContain('getControllerName');
    expect(result).toContain('getBuilderName');
    expect(result).toContain('getModelName');
  });

  it('shows nothing missing when B has extra', async () => {
    const result = await handleCompare(deps, {
      symbolA: 'App\\Routes\\RecurringJobCostCenters',
      symbolB: 'App\\Routes\\JobCostCenters',
    });
    // RecurringJobCostCenters has nothing that JobCostCenters doesn't
    expect(result).toContain('(none)');
  });

  it('returns not-found for unknown symbol', async () => {
    const result = await handleCompare(deps, {
      symbolA: 'App\\Nonexistent',
      symbolB: 'App\\Routes\\JobCostCenters',
    });
    expect(result).toContain('not found');
  });

  it('handles suffix name lookup', async () => {
    const result = await handleCompare(deps, {
      symbolA: 'JobCostCenters',
      symbolB: 'RecurringJobCostCenters',
    });
    expect(result).toContain('getSubRouteFolder');
  });
});
