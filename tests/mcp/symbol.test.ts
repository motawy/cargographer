import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../../src/db/repositories/reference-repository.js';
import { handleSymbol } from '../../src/mcp/tools/symbol.js';
import type { ToolDeps, RepoStats } from '../../src/mcp/types.js';
import type { ParsedSymbol } from '../../src/types.js';

const TEST_DB = {
  host: 'localhost', port: 5435,
  database: 'cartograph_test', user: 'cartograph', password: 'localdev',
};

describe('cartograph_symbol', () => {
  let pool: pg.Pool;
  let deps: ToolDeps;
  let stats: RepoStats;

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

    const f1 = await fileRepo.upsert(repo.id, 'app/Services/UserService.php', 'php', 'h1', 40);
    const f2 = await fileRepo.upsert(repo.id, 'app/Contracts/UserServiceInterface.php', 'php', 'h2', 10);
    const f3 = await fileRepo.upsert(repo.id, 'app/Repositories/UserRepository.php', 'php', 'h3', 20);

    const svcSymbol: ParsedSymbol = {
      name: 'UserService', qualifiedName: 'App\\Services\\UserService',
      kind: 'class', visibility: null, lineStart: 9, lineEnd: 39,
      signature: null, returnType: null, docblock: null, metadata: {},
      children: [{
        name: 'findById', qualifiedName: 'App\\Services\\UserService::findById',
        kind: 'method', visibility: 'public', lineStart: 21, lineEnd: 24,
        signature: 'findById(int $id): ?User', returnType: '?User',
        docblock: null, children: [], metadata: {},
      }],
    };
    const ifaceSymbol: ParsedSymbol = {
      name: 'UserServiceInterface', qualifiedName: 'App\\Contracts\\UserServiceInterface',
      kind: 'interface', visibility: null, lineStart: 10, lineEnd: 17,
      signature: null, returnType: null, docblock: null, children: [], metadata: {},
    };
    const repoSymbol: ParsedSymbol = {
      name: 'UserRepository', qualifiedName: 'App\\Repositories\\UserRepository',
      kind: 'class', visibility: null, lineStart: 7, lineEnd: 29,
      signature: null, returnType: null, docblock: null, children: [], metadata: {},
    };

    const ids1 = await symbolRepo.replaceFileSymbols(f1.id, [svcSymbol]);
    const ids2 = await symbolRepo.replaceFileSymbols(f2.id, [ifaceSymbol]);
    const ids3 = await symbolRepo.replaceFileSymbols(f3.id, [repoSymbol]);

    // Add references: UserService implements UserServiceInterface, instantiates UserRepository
    await refRepo.replaceFileReferences(f1.id, ids1, [
      { sourceQualifiedName: 'App\\Services\\UserService', targetQualifiedName: 'app\\contracts\\userserviceinterface', kind: 'implementation', line: 9 },
      { sourceQualifiedName: 'App\\Services\\UserService', targetQualifiedName: 'app\\repositories\\userrepository', kind: 'instantiation', line: 13 },
    ]);
    await refRepo.resolveTargets(repo.id);

    deps = { repoId: repo.id, symbolRepo, refRepo };
    stats = { totalClasses: 2, classesWithInterface: 1, classesWithBaseClass: 0, classesWithTraits: 0 };
  });

  afterAll(async () => {
    await pool.end();
  });

  it('finds symbol by exact qualified name', async () => {
    const result = await handleSymbol(deps, stats, { name: 'App\\Services\\UserService' });
    expect(result).toContain('App\\Services\\UserService');
    expect(result).toContain('class');
    expect(result).toContain('app/Services/UserService.php');
  });

  it('falls back to suffix match for short names', async () => {
    const result = await handleSymbol(deps, stats, { name: 'UserService' });
    expect(result).toContain('App\\Services\\UserService');
  });

  it('includes depends-on section', async () => {
    const result = await handleSymbol(deps, stats, { name: 'App\\Services\\UserService' });
    expect(result).toContain('Depends on');
    expect(result).toContain('implementation');
  });

  it('includes used-by section when dependents exist', async () => {
    const result = await handleSymbol(deps, stats, { name: 'App\\Contracts\\UserServiceInterface' });
    expect(result).toContain('Used by');
  });

  it('includes conventions context for classes', async () => {
    const result = await handleSymbol(deps, stats, { name: 'App\\Services\\UserService' });
    expect(result).toContain('Context:');
    // Should mention interface implementation since UserService implements one
    expect(result).toMatch(/[Ii]mplements/);
  });

  it('returns not-found message', async () => {
    const result = await handleSymbol(deps, stats, { name: 'Nonexistent' });
    expect(result).toContain('not found');
    expect(result).toContain('cartograph_find');
  });

  it('deep mode shows stack with class_reference wiring', async () => {
    const repoRepo = new RepoRepository(pool);
    const fileRepo = new FileRepository(pool);
    const symbolRepo = new SymbolRepository(pool);
    const refRepo = new ReferenceRepository(pool);

    const repo = await repoRepo.findOrCreate('/test/deep-mode', 'test-deep');
    const f1 = await fileRepo.upsert(repo.id, 'route.php', 'php', 'dp1', 30);
    const f2 = await fileRepo.upsert(repo.id, 'controller.php', 'php', 'dp2', 10);
    const f3 = await fileRepo.upsert(repo.id, 'base.php', 'php', 'dp3', 50);

    const routeSymbol: ParsedSymbol = {
      name: 'MyRoute', qualifiedName: 'App\\MyRoute',
      kind: 'class', visibility: null, lineStart: 1, lineEnd: 30,
      signature: null, returnType: null, docblock: null, metadata: {},
      children: [{
        name: 'getControllerName', qualifiedName: 'App\\MyRoute::getControllerName',
        kind: 'method', visibility: 'public', lineStart: 10, lineEnd: 13,
        signature: null, returnType: null, docblock: null, children: [], metadata: {},
      }],
    };
    const ctrlSymbol: ParsedSymbol = {
      name: 'MyController', qualifiedName: 'App\\MyController',
      kind: 'class', visibility: null, lineStart: 1, lineEnd: 10,
      signature: null, returnType: null, docblock: null, children: [], metadata: {},
    };
    const baseSymbol: ParsedSymbol = {
      name: 'BaseRoute', qualifiedName: 'App\\BaseRoute',
      kind: 'class', visibility: null, lineStart: 1, lineEnd: 50,
      signature: null, returnType: null, docblock: null, children: [], metadata: {},
    };

    const ids1 = await symbolRepo.replaceFileSymbols(f1.id, [routeSymbol]);
    await symbolRepo.replaceFileSymbols(f2.id, [ctrlSymbol]);
    await symbolRepo.replaceFileSymbols(f3.id, [baseSymbol]);

    await refRepo.replaceFileReferences(f1.id, ids1, [
      { sourceQualifiedName: 'App\\MyRoute', targetQualifiedName: 'app\\baseroute', kind: 'inheritance', line: 1 },
      { sourceQualifiedName: 'App\\MyRoute::getControllerName', targetQualifiedName: 'app\\mycontroller', kind: 'class_reference', line: 12 },
    ]);
    await refRepo.resolveTargets(repo.id);

    const deepDeps: ToolDeps = { repoId: repo.id, symbolRepo, refRepo };
    const deepStats: RepoStats = { totalClasses: 3, classesWithInterface: 0, classesWithBaseClass: 1, classesWithTraits: 0 };

    const result = await handleSymbol(deepDeps, deepStats, { name: 'App\\MyRoute', deep: true });

    expect(result).toContain('Stack');
    expect(result).toContain('Extends');
    expect(result).toContain('BaseRoute');
    expect(result).toContain('getControllerName');
    expect(result).toContain('MyController');
  });

  it('deep mode shows context requirements from method metadata', async () => {
    const repoRepo = new RepoRepository(pool);
    const fileRepo = new FileRepository(pool);
    const symbolRepo = new SymbolRepository(pool);
    const refRepo = new ReferenceRepository(pool);

    const repo = await repoRepo.findOrCreate('/test/ctx-req', 'test-ctx-req');
    const f1 = await fileRepo.upsert(repo.id, 'builder.php', 'php', 'ctx1', 40);

    const builderSymbol: ParsedSymbol = {
      name: 'JobNotesBuilder', qualifiedName: 'App\\Builders\\JobNotesBuilder',
      kind: 'class', visibility: null, lineStart: 1, lineEnd: 40,
      signature: null, returnType: null, docblock: null, metadata: {},
      children: [
        {
          name: 'getReferenceID', qualifiedName: 'App\\Builders\\JobNotesBuilder::getReferenceID',
          kind: 'method', visibility: 'protected', lineStart: 5, lineEnd: 8,
          signature: null, returnType: null, docblock: null, children: [],
          metadata: { contextArgs: ['jobID'] },
        },
        {
          name: 'getFilters', qualifiedName: 'App\\Builders\\JobNotesBuilder::getFilters',
          kind: 'method', visibility: 'protected', lineStart: 10, lineEnd: 15,
          signature: null, returnType: null, docblock: null, children: [],
          metadata: { contextArgs: ['sectionID'], contextParams: ['page', 'limit'] },
        },
        {
          name: 'getName', qualifiedName: 'App\\Builders\\JobNotesBuilder::getName',
          kind: 'method', visibility: 'public', lineStart: 17, lineEnd: 20,
          signature: null, returnType: null, docblock: null, children: [],
          metadata: {},
        },
      ],
    };

    await symbolRepo.replaceFileSymbols(f1.id, [builderSymbol]);

    const ctxDeps: ToolDeps = { repoId: repo.id, symbolRepo, refRepo };
    const ctxStats: RepoStats = { totalClasses: 1, classesWithInterface: 0, classesWithBaseClass: 0, classesWithTraits: 0 };

    const result = await handleSymbol(ctxDeps, ctxStats, { name: 'App\\Builders\\JobNotesBuilder', deep: true });

    expect(result).toContain('Context requirements');
    expect(result).toContain('Route args consumed:');
    expect(result).toContain('jobID (via getReferenceID())');
    expect(result).toContain('sectionID (via getFilters())');
    expect(result).toContain('Request params consumed:');
    expect(result).toContain('page (via getFilters())');
    expect(result).toContain('limit (via getFilters())');
  });
});
