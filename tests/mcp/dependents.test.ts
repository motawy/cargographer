import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../../src/db/repositories/reference-repository.js';
import { handleDependents } from '../../src/mcp/tools/dependents.js';
import type { ToolDeps } from '../../src/mcp/types.js';
import type { ParsedSymbol } from '../../src/types.js';

const TEST_DB = {
  host: 'localhost', port: 5435,
  database: 'cartograph_test', user: 'cartograph', password: 'localdev',
};

describe('cartograph_dependents', () => {
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
    const f1 = await fileRepo.upsert(repo.id, 'app/Controllers/UserController.php', 'php', 'h1', 30);
    const f2 = await fileRepo.upsert(repo.id, 'app/Services/UserService.php', 'php', 'h2', 40);
    const f3 = await fileRepo.upsert(repo.id, 'app/Repositories/UserRepository.php', 'php', 'h3', 20);

    const mkClass = (name: string, qn: string): ParsedSymbol => ({
      name, qualifiedName: qn, kind: 'class', visibility: null,
      lineStart: 1, lineEnd: 10, signature: null, returnType: null,
      docblock: null, children: [], metadata: {},
    });

    const ids1 = await symbolRepo.replaceFileSymbols(f1.id, [mkClass('UserController', 'App\\Controllers\\UserController')]);
    const ids2 = await symbolRepo.replaceFileSymbols(f2.id, [mkClass('UserService', 'App\\Services\\UserService')]);
    await symbolRepo.replaceFileSymbols(f3.id, [mkClass('UserRepository', 'App\\Repositories\\UserRepository')]);

    // Controller → Service, Service → Repository
    await refRepo.replaceFileReferences(f1.id, ids1, [
      { sourceQualifiedName: 'App\\Controllers\\UserController', targetQualifiedName: 'app\\services\\userservice', kind: 'instantiation', line: 12 },
    ]);
    await refRepo.replaceFileReferences(f2.id, ids2, [
      { sourceQualifiedName: 'App\\Services\\UserService', targetQualifiedName: 'app\\repositories\\userrepository', kind: 'instantiation', line: 13 },
    ]);
    await refRepo.resolveTargets(repo.id);

    deps = { repoId: repo.id, symbolRepo, refRepo };
  });

  afterAll(async () => {
    await pool.end();
  });

  it('shows immediate dependents at depth 1', async () => {
    const result = await handleDependents(deps, { symbol: 'App\\Repositories\\UserRepository', depth: 1 });
    expect(result).toContain('App\\Services\\UserService');
    expect(result).not.toContain('App\\Controllers\\UserController');
  });

  it('shows transitive dependents at depth 2', async () => {
    const result = await handleDependents(deps, { symbol: 'App\\Repositories\\UserRepository', depth: 2 });
    expect(result).toContain('App\\Services\\UserService');
    expect(result).toContain('App\\Controllers\\UserController');
  });

  it('groups by file path', async () => {
    const result = await handleDependents(deps, { symbol: 'App\\Repositories\\UserRepository', depth: 2 });
    expect(result).toContain('app/Services/UserService.php');
    expect(result).toContain('app/Controllers/UserController.php');
  });

  it('returns no-dependents message', async () => {
    const result = await handleDependents(deps, { symbol: 'App\\Controllers\\UserController' });
    expect(result).toContain('No dependents');
  });

  it('returns not-found for unknown symbol', async () => {
    const result = await handleDependents(deps, { symbol: 'App\\Nonexistent' });
    expect(result).toContain('not found');
  });
});
