import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../../src/db/repositories/reference-repository.js';
import { handleFlow } from '../../src/mcp/tools/flow.js';
import type { ToolDeps } from '../../src/mcp/types.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('cartograph_flow', () => {
  let db: Database.Database;
  let deps: ToolDeps;

  beforeAll(() => {
    db = openDatabase({ path: ':memory:' });
    runMigrations(db);
    const repoRepo = new RepoRepository(db);
    const fileRepo = new FileRepository(db);
    const symbolRepo = new SymbolRepository(db);
    const refRepo = new ReferenceRepository(db);

    const repo = repoRepo.findOrCreate('/test/repo', 'test');
    const f1 = fileRepo.upsert(repo.id, 'a.php', 'php', 'h1', 10);
    const f2 = fileRepo.upsert(repo.id, 'b.php', 'php', 'h2', 10);
    const f3 = fileRepo.upsert(repo.id, 'c.php', 'php', 'h3', 10);
    const f4 = fileRepo.upsert(repo.id, 'd.php', 'php', 'h4', 10);

    const mkClass = (name: string, qn: string): ParsedSymbol => ({
      name, qualifiedName: qn, kind: 'class', visibility: null,
      lineStart: 1, lineEnd: 10, signature: null, returnType: null,
      docblock: null, children: [], metadata: {},
    });

    const f5 = fileRepo.upsert(repo.id, 'e.php', 'php', 'h5', 10);

    const ids1 = symbolRepo.replaceFileSymbols(f1.id, [mkClass('A', 'Ns\\A')]);
    const ids2 = symbolRepo.replaceFileSymbols(f2.id, [mkClass('B', 'Ns\\B')]);
    symbolRepo.replaceFileSymbols(f3.id, [mkClass('C', 'Ns\\C')]);
    symbolRepo.replaceFileSymbols(f4.id, [mkClass('Base', 'Ns\\Base')]);
    symbolRepo.replaceFileSymbols(f5.id, [mkClass('E', 'Ns\\E')]);

    // A instantiates B (call), A inherits Base (structural — should be excluded)
    // B instantiates C (call), A references E via ::class (class_reference)
    refRepo.replaceFileReferences(f1.id, ids1, [
      { sourceQualifiedName: 'Ns\\A', targetQualifiedName: 'ns\\b', kind: 'instantiation', line: 5 },
      { sourceQualifiedName: 'Ns\\A', targetQualifiedName: 'ns\\base', kind: 'inheritance', line: 1 },
      { sourceQualifiedName: 'Ns\\A', targetQualifiedName: 'ns\\e', kind: 'class_reference', line: 6 },
    ]);
    refRepo.replaceFileReferences(f2.id, ids2, [
      { sourceQualifiedName: 'Ns\\B', targetQualifiedName: 'ns\\c', kind: 'static_call', line: 3 },
    ]);
    refRepo.resolveTargets(repo.id);

    deps = { repoId: repo.id, symbolRepo, refRepo };
  });

  afterAll(() => {
    db.close();
  });

  it('traces call flow excluding structural refs', () => {
    const result = handleFlow(deps, { symbol: 'Ns\\A', depth: 5 });
    expect(result).toContain('Ns\\B');
    expect(result).toContain('Ns\\C');
    // Structural ref (inheritance) should not appear in flow
    expect(result).not.toContain('Ns\\Base');
  });

  it('respects depth limit', () => {
    const result = handleFlow(deps, { symbol: 'Ns\\A', depth: 1 });
    expect(result).toContain('Ns\\B');
    expect(result).not.toContain('Ns\\C');
  });

  it('returns not-found for unknown symbol', () => {
    const result = handleFlow(deps, { symbol: 'Ns\\Z' });
    expect(result).toContain('not found');
  });

  it('follows class_reference edges', () => {
    const result = handleFlow(deps, { symbol: 'Ns\\A', depth: 5 });
    expect(result).toContain('Ns\\E');
  });

  it('traces through parent template methods to child overrides', () => {
    // Setup: Route extends BaseRoute. BaseRoute::init calls $this->getControllerName().
    // Route::getControllerName returns Controller::class.
    // Flow should trace: Route → Controller (via init() → getControllerName())
    const repoRepo = new RepoRepository(db);
    const fileRepo = new FileRepository(db);
    const symbolRepo = new SymbolRepository(db);
    const refRepo = new ReferenceRepository(db);

    const repo = repoRepo.findOrCreate('/test/template-flow', 'test-tpl');
    const fBase = fileRepo.upsert(repo.id, 'baseroute.php', 'php', 'tb1', 50);
    const fRoute = fileRepo.upsert(repo.id, 'route.php', 'php', 'tb2', 30);
    const fCtrl = fileRepo.upsert(repo.id, 'controller.php', 'php', 'tb3', 10);

    // BaseRoute with init() method that self_calls getControllerName()
    const baseIds = symbolRepo.replaceFileSymbols(fBase.id, [{
      name: 'BaseRoute', qualifiedName: 'App\\BaseRoute', kind: 'class', visibility: null,
      lineStart: 1, lineEnd: 50, signature: null, returnType: null,
      docblock: null, metadata: {},
      children: [{
        name: 'init', qualifiedName: 'App\\BaseRoute::init', kind: 'method',
        visibility: 'public', lineStart: 10, lineEnd: 20, signature: null, returnType: null,
        docblock: null, children: [], metadata: {},
      }],
    }]);

    // Route with getControllerName() that returns Controller::class
    const routeIds = symbolRepo.replaceFileSymbols(fRoute.id, [{
      name: 'MyRoute', qualifiedName: 'App\\MyRoute', kind: 'class', visibility: null,
      lineStart: 1, lineEnd: 30, signature: null, returnType: null,
      docblock: null, metadata: {},
      children: [{
        name: 'getControllerName', qualifiedName: 'App\\MyRoute::getControllerName', kind: 'method',
        visibility: 'public', lineStart: 10, lineEnd: 13, signature: null, returnType: null,
        docblock: null, children: [], metadata: {},
      }],
    }]);

    symbolRepo.replaceFileSymbols(fCtrl.id, [{
      name: 'MyController', qualifiedName: 'App\\MyController', kind: 'class', visibility: null,
      lineStart: 1, lineEnd: 10, signature: null, returnType: null,
      docblock: null, children: [], metadata: {},
    }]);

    // BaseRoute::init self_calls BaseRoute::getControllerName
    refRepo.replaceFileReferences(fBase.id, baseIds, [
      { sourceQualifiedName: 'App\\BaseRoute::init', targetQualifiedName: 'app\\baseroute::getcontrollername', kind: 'self_call', line: 15 },
    ]);

    // Route inherits BaseRoute, getControllerName has class_reference to Controller
    refRepo.replaceFileReferences(fRoute.id, routeIds, [
      { sourceQualifiedName: 'App\\MyRoute', targetQualifiedName: 'app\\baseroute', kind: 'inheritance', line: 1 },
      { sourceQualifiedName: 'App\\MyRoute::getControllerName', targetQualifiedName: 'app\\mycontroller', kind: 'class_reference', line: 12 },
    ]);
    refRepo.resolveTargets(repo.id);

    const flowDeps: ToolDeps = { repoId: repo.id, symbolRepo, refRepo };
    const result = handleFlow(flowDeps, { symbol: 'App\\MyRoute', depth: 3 });

    // Flow should trace through parent's init() → child's getControllerName() → Controller
    expect(result).toContain('App\\MyController');
  });

  it('surfaces thrown and caught exceptions along the traced flow', () => {
    const repoRepo = new RepoRepository(db);
    const fileRepo = new FileRepository(db);
    const symbolRepo = new SymbolRepository(db);
    const refRepo = new ReferenceRepository(db);

    const repo = repoRepo.findOrCreate('/test/exception-flow', 'test-ex-flow');
    const fRoute = fileRepo.upsert(repo.id, 'route.php', 'php', 'xf1', 40);
    const fBuilder = fileRepo.upsert(repo.id, 'builder.php', 'php', 'xf2', 60);

    const routeIds = symbolRepo.replaceFileSymbols(fRoute.id, [{
      name: 'OrdersRoute', qualifiedName: 'App\\OrdersRoute', kind: 'class', visibility: null,
      lineStart: 1, lineEnd: 40, signature: null, returnType: null,
      docblock: null, metadata: {},
      children: [{
        name: 'getBuilderName', qualifiedName: 'App\\OrdersRoute::getBuilderName', kind: 'method',
        visibility: 'protected', lineStart: 10, lineEnd: 13, signature: null, returnType: null,
        docblock: null, children: [], metadata: {},
      }],
    }]);

    symbolRepo.replaceFileSymbols(fBuilder.id, [{
      name: 'OrdersBuilder', qualifiedName: 'App\\OrdersBuilder', kind: 'class', visibility: null,
      lineStart: 1, lineEnd: 60, signature: null, returnType: null,
      docblock: null, metadata: {},
      children: [
        {
          name: 'persist', qualifiedName: 'App\\OrdersBuilder::persist', kind: 'method',
          visibility: 'protected', lineStart: 12, lineEnd: 20, signature: null, returnType: null,
          docblock: null, children: [], metadata: {
            thrownExceptions: ['RuntimeException'],
            documentedThrows: ['DomainException'],
          },
        },
        {
          name: 'respond', qualifiedName: 'App\\OrdersBuilder::respond', kind: 'method',
          visibility: 'protected', lineStart: 22, lineEnd: 30, signature: null, returnType: null,
          docblock: null, children: [], metadata: {
            caughtExceptions: ['Throwable'],
          },
        },
      ],
    }]);

    refRepo.replaceFileReferences(fRoute.id, routeIds, [
      { sourceQualifiedName: 'App\\OrdersRoute::getBuilderName', targetQualifiedName: 'app\\ordersbuilder', kind: 'class_reference', line: 11 },
    ]);
    refRepo.resolveTargets(repo.id);

    const flowDeps: ToolDeps = { repoId: repo.id, symbolRepo, refRepo };
    const result = handleFlow(flowDeps, { symbol: 'App\\OrdersRoute', depth: 2 });

    expect(result).toContain('App\\OrdersBuilder');
    expect(result).toContain('throws: DomainException [docblock] via App\\OrdersBuilder::persist()');
    expect(result).toContain('RuntimeException via App\\OrdersBuilder::persist()');
    expect(result).toContain('catches: Throwable via App\\OrdersBuilder::respond()');
  });
});
