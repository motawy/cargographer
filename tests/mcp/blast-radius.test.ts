import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../../src/db/repositories/reference-repository.js';
import { handleBlastRadius } from '../../src/mcp/tools/blast-radius.js';
import type { ToolDeps } from '../../src/mcp/types.js';
import type { ParsedSymbol } from '../../src/types.js';

const TEST_DB = {
  host: 'localhost', port: 5435,
  database: 'cartograph_test', user: 'cartograph', password: 'localdev',
};

describe('cartograph_blast_radius', () => {
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

    // Target file: has a class with a method
    const f1 = await fileRepo.upsert(repo.id, 'app/Services/UserService.php', 'php', 'h1', 40);
    // Dependent files
    const f2 = await fileRepo.upsert(repo.id, 'app/Controllers/UserController.php', 'php', 'h2', 30);
    const f3 = await fileRepo.upsert(repo.id, 'app/Jobs/SyncUsers.php', 'php', 'h3', 15);

    const svc: ParsedSymbol = {
      name: 'UserService', qualifiedName: 'App\\Services\\UserService',
      kind: 'class', visibility: null, lineStart: 1, lineEnd: 40,
      signature: null, returnType: null, docblock: null, metadata: {},
      children: [{
        name: 'create', qualifiedName: 'App\\Services\\UserService::create',
        kind: 'method', visibility: 'public', lineStart: 25, lineEnd: 30,
        signature: null, returnType: null, docblock: null, children: [], metadata: {},
      }],
    };

    const mkClass = (name: string, qn: string): ParsedSymbol => ({
      name, qualifiedName: qn, kind: 'class', visibility: null,
      lineStart: 1, lineEnd: 10, signature: null, returnType: null,
      docblock: null, children: [], metadata: {},
    });

    await symbolRepo.replaceFileSymbols(f1.id, [svc]);
    const ids2 = await symbolRepo.replaceFileSymbols(f2.id, [mkClass('UserController', 'App\\Controllers\\UserController')]);
    const ids3 = await symbolRepo.replaceFileSymbols(f3.id, [mkClass('SyncUsers', 'App\\Jobs\\SyncUsers')]);

    // Controller references UserService (the class), SyncUsers references UserService::create (the method)
    await refRepo.replaceFileReferences(f2.id, ids2, [
      { sourceQualifiedName: 'App\\Controllers\\UserController', targetQualifiedName: 'app\\services\\userservice', kind: 'instantiation', line: 10 },
    ]);
    await refRepo.replaceFileReferences(f3.id, ids3, [
      { sourceQualifiedName: 'App\\Jobs\\SyncUsers', targetQualifiedName: 'app\\services\\userservice::create', kind: 'static_call', line: 8 },
    ]);
    await refRepo.resolveTargets(repo.id);

    deps = { repoId: repo.id, symbolRepo, refRepo };
  });

  afterAll(async () => {
    await pool.end();
  });

  it('shows affected files and symbols', async () => {
    const result = await handleBlastRadius(deps, { file: 'app/Services/UserService.php' });
    expect(result).toContain('app/Controllers/UserController.php');
    expect(result).toContain('app/Jobs/SyncUsers.php');
    expect(result).toContain('Symbols in file:');
    expect(result).toContain('Affected');
  });

  it('returns not-found for unknown file', async () => {
    const result = await handleBlastRadius(deps, { file: 'nonexistent.php' });
    expect(result).toContain('not found');
  });

  it('returns no-impact message for file with no dependents', async () => {
    const result = await handleBlastRadius(deps, { file: 'app/Jobs/SyncUsers.php' });
    expect(result).toContain('No external dependents');
  });
});
