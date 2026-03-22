import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../../src/db/repositories/reference-repository.js';
import { renderScaffoldPlanForRepo } from '../../src/cli/scaffold-plan.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('renderScaffoldPlanForRepo', () => {
  it('renders a scaffold plan for an indexed repo', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      runMigrations(db);
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const refRepo = new ReferenceRepository(db);
      const repo = repoRepo.findOrCreate('/test/repo', 'test');
      const routeFile = fileRepo.upsert(repo.id, 'src/Route/QuoteRoute.php', 'php', 'scp1', 10);
      const controllerFile = fileRepo.upsert(repo.id, 'src/Controller/QuoteController.php', 'php', 'scp2', 10);

      const route: ParsedSymbol = {
        name: 'QuoteRoute',
        qualifiedName: 'App\\Route\\QuoteRoute',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 10,
        signature: null,
        returnType: null,
        docblock: null,
        metadata: {},
        children: [
          {
            name: 'getControllerName',
            qualifiedName: 'App\\Route\\QuoteRoute::getControllerName',
            kind: 'method',
            visibility: 'public',
            lineStart: 4,
            lineEnd: 6,
            signature: null,
            returnType: null,
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

      const controller: ParsedSymbol = {
        name: 'QuoteController',
        qualifiedName: 'App\\Controller\\QuoteController',
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

      const routeMap = symbolRepo.replaceFileSymbols(routeFile.id, [route]);
      symbolRepo.replaceFileSymbols(controllerFile.id, [controller]);
      refRepo.replaceFileReferences(routeFile.id, routeMap, [
        {
          sourceQualifiedName: 'App\\Route\\QuoteRoute::getControllerName',
          targetQualifiedName: 'app\\controller\\quotecontroller',
          kind: 'class_reference',
          line: 5,
        },
      ]);
      refRepo.resolveTargets(repo.id);

      const result = renderScaffoldPlanForRepo(db, '/test/repo', 'App\\Route\\QuoteRoute', 'RecurringQuote');
      expect(result).toContain('Scaffold Plan');
      expect(result).toContain('src/Route/RecurringQuoteRoute.php');
      expect(result).toContain('src/Controller/RecurringQuoteController.php');
    } finally {
      db.close();
    }
  });
});
