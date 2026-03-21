import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../../src/db/repositories/reference-repository.js';
import { SymbolSchemaRepository } from '../../src/db/repositories/symbol-schema-repository.js';
import { handleSymbol } from '../../src/mcp/tools/symbol.js';
import type { ToolDeps, RepoStats } from '../../src/mcp/types.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('cartograph_symbol', () => {
  let db: Database.Database;
  let deps: ToolDeps;
  let stats: RepoStats;

  beforeAll(() => {
    db = openDatabase({ path: ':memory:' });
    runMigrations(db);
    const repoRepo = new RepoRepository(db);
    const fileRepo = new FileRepository(db);
    const symbolRepo = new SymbolRepository(db);
    const refRepo = new ReferenceRepository(db);

    const repo = repoRepo.findOrCreate('/test/repo', 'test');

    const f1 = fileRepo.upsert(repo.id, 'app/Services/UserService.php', 'php', 'h1', 40);
    const f2 = fileRepo.upsert(repo.id, 'app/Contracts/UserServiceInterface.php', 'php', 'h2', 10);
    const f3 = fileRepo.upsert(repo.id, 'app/Repositories/UserRepository.php', 'php', 'h3', 20);

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

    const ids1 = symbolRepo.replaceFileSymbols(f1.id, [svcSymbol]);
    const ids2 = symbolRepo.replaceFileSymbols(f2.id, [ifaceSymbol]);
    const ids3 = symbolRepo.replaceFileSymbols(f3.id, [repoSymbol]);

    // Add references: UserService implements UserServiceInterface, instantiates UserRepository
    refRepo.replaceFileReferences(f1.id, ids1, [
      { sourceQualifiedName: 'App\\Services\\UserService', targetQualifiedName: 'app\\contracts\\userserviceinterface', kind: 'implementation', line: 9 },
      { sourceQualifiedName: 'App\\Services\\UserService', targetQualifiedName: 'app\\repositories\\userrepository', kind: 'instantiation', line: 13 },
    ]);
    refRepo.resolveTargets(repo.id);

    deps = { repoId: repo.id, symbolRepo, refRepo };
    stats = { totalClasses: 2, classesWithInterface: 1, classesWithBaseClass: 0, classesWithTraits: 0 };
  });

  afterAll(() => {
    db.close();
  });

  it('finds symbol by exact qualified name', () => {
    const result = handleSymbol(deps, stats, { name: 'App\\Services\\UserService' });
    expect(result).toContain('App\\Services\\UserService');
    expect(result).toContain('class');
    expect(result).toContain('app/Services/UserService.php');
  });

  it('falls back to suffix match for short names', () => {
    const result = handleSymbol(deps, stats, { name: 'UserService' });
    expect(result).toContain('App\\Services\\UserService');
  });

  it('includes depends-on section', () => {
    const result = handleSymbol(deps, stats, { name: 'App\\Services\\UserService' });
    expect(result).toContain('Depends on');
    expect(result).toContain('implementation');
  });

  it('includes used-by section when dependents exist', () => {
    const result = handleSymbol(deps, stats, { name: 'App\\Contracts\\UserServiceInterface' });
    expect(result).toContain('Used by');
  });

  it('includes conventions context for classes', () => {
    const result = handleSymbol(deps, stats, { name: 'App\\Services\\UserService' });
    expect(result).toContain('Context:');
    // Should mention interface implementation since UserService implements one
    expect(result).toMatch(/[Ii]mplements/);
  });

  it('returns not-found message', () => {
    const result = handleSymbol(deps, stats, { name: 'Nonexistent' });
    expect(result).toContain('not found');
    expect(result).toContain('cartograph_find');
  });

  it('suggests similar symbols when lookup fails', () => {
    const result = handleSymbol(deps, stats, { name: 'UserServce' });
    expect(result).toContain('Did you mean');
    expect(result).toContain('App\\Services\\UserService');
  });

  it('deep mode shows stack with class_reference wiring', () => {
    const repoRepo = new RepoRepository(db);
    const fileRepo = new FileRepository(db);
    const symbolRepo = new SymbolRepository(db);
    const refRepo = new ReferenceRepository(db);

    const repo = repoRepo.findOrCreate('/test/deep-mode', 'test-deep');
    const f1 = fileRepo.upsert(repo.id, 'route.php', 'php', 'dp1', 30);
    const f2 = fileRepo.upsert(repo.id, 'controller.php', 'php', 'dp2', 10);
    const f3 = fileRepo.upsert(repo.id, 'base.php', 'php', 'dp3', 50);

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

    const ids1 = symbolRepo.replaceFileSymbols(f1.id, [routeSymbol]);
    symbolRepo.replaceFileSymbols(f2.id, [ctrlSymbol]);
    symbolRepo.replaceFileSymbols(f3.id, [baseSymbol]);

    refRepo.replaceFileReferences(f1.id, ids1, [
      { sourceQualifiedName: 'App\\MyRoute', targetQualifiedName: 'app\\baseroute', kind: 'inheritance', line: 1 },
      { sourceQualifiedName: 'App\\MyRoute::getControllerName', targetQualifiedName: 'app\\mycontroller', kind: 'class_reference', line: 12 },
    ]);
    refRepo.resolveTargets(repo.id);

    const deepDeps: ToolDeps = { repoId: repo.id, symbolRepo, refRepo };
    const deepStats: RepoStats = { totalClasses: 3, classesWithInterface: 0, classesWithBaseClass: 1, classesWithTraits: 0 };

    const result = handleSymbol(deepDeps, deepStats, { name: 'App\\MyRoute', deep: true });

    expect(result).toContain('Stack');
    expect(result).toContain('Extends');
    expect(result).toContain('BaseRoute');
    expect(result).toContain('getControllerName');
    expect(result).toContain('MyController');
  });

  it('deep mode shows context requirements from method metadata', () => {
    const repoRepo = new RepoRepository(db);
    const fileRepo = new FileRepository(db);
    const symbolRepo = new SymbolRepository(db);
    const refRepo = new ReferenceRepository(db);

    const repo = repoRepo.findOrCreate('/test/ctx-req', 'test-ctx-req');
    const f1 = fileRepo.upsert(repo.id, 'builder.php', 'php', 'ctx1', 40);

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

    symbolRepo.replaceFileSymbols(f1.id, [builderSymbol]);

    const ctxDeps: ToolDeps = { repoId: repo.id, symbolRepo, refRepo };
    const ctxStats: RepoStats = { totalClasses: 1, classesWithInterface: 0, classesWithBaseClass: 0, classesWithTraits: 0 };

    const result = handleSymbol(ctxDeps, ctxStats, { name: 'App\\Builders\\JobNotesBuilder', deep: true });

    expect(result).toContain('Context requirements');
    expect(result).toContain('Route args consumed:');
    expect(result).toContain('jobID (via getReferenceID())');
    expect(result).toContain('sectionID (via getFilters())');
    expect(result).toContain('Request params consumed:');
    expect(result).toContain('page (via getFilters())');
    expect(result).toContain('limit (via getFilters())');
  });

  it('shows mapped tables when schema links exist for the symbol', () => {
    const repoRepo = new RepoRepository(db);
    const fileRepo = new FileRepository(db);
    const symbolRepo = new SymbolRepository(db);
    const refRepo = new ReferenceRepository(db);
    const symbolSchemaRepo = new SymbolSchemaRepository(db);

    const repo = repoRepo.findOrCreate('/test/entity-map', 'test-entity-map');
    const file = fileRepo.upsert(repo.id, 'src/Entity/Quote.php', 'php', 'em1', 10);
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

    const result = handleSymbol(
      { repoId: repo.id, symbolRepo, refRepo, symbolSchemaRepo },
      { totalClasses: 1, classesWithInterface: 0, classesWithBaseClass: 0, classesWithTraits: 0 },
      { name: 'App\\Entity\\Quote' }
    );

    expect(result).toContain('Mapped tables: quotes');
  });
});
