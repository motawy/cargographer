import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../../src/db/repositories/reference-repository.js';
import { handleScaffoldPlan } from '../../src/mcp/tools/scaffold-plan.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('cartograph_scaffold_plan', () => {
  it('plans analogous files and summarizes gaps for existing targets', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      runMigrations(db);
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const refRepo = new ReferenceRepository(db);

      const repo = repoRepo.findOrCreate('/test/repo-plan', 'plan');
      const routeFile = fileRepo.upsert(repo.id, 'src/Route/QuoteRoute.php', 'php', 'sp1', 10);
      const controllerFile = fileRepo.upsert(repo.id, 'src/Controller/QuoteController.php', 'php', 'sp2', 10);
      const builderFile = fileRepo.upsert(repo.id, 'src/Builder/QuoteBuilder.php', 'php', 'sp3', 10);
      const modelFile = fileRepo.upsert(repo.id, 'src/Model/QuoteModel.php', 'php', 'sp4', 10);
      const targetModelFile = fileRepo.upsert(repo.id, 'src/Model/RecurringQuoteModel.php', 'php', 'sp5', 10);

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
            signature: 'getControllerName(): string',
            returnType: 'string',
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
        children: [
          {
            name: 'getBuilderName',
            qualifiedName: 'App\\Controller\\QuoteController::getBuilderName',
            kind: 'method',
            visibility: 'public',
            lineStart: 4,
            lineEnd: 6,
            signature: 'getBuilderName(): string',
            returnType: 'string',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

      const builder: ParsedSymbol = {
        name: 'QuoteBuilder',
        qualifiedName: 'App\\Builder\\QuoteBuilder',
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
            name: 'getModelName',
            qualifiedName: 'App\\Builder\\QuoteBuilder::getModelName',
            kind: 'method',
            visibility: 'public',
            lineStart: 4,
            lineEnd: 6,
            signature: 'getModelName(): string',
            returnType: 'string',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

      const model: ParsedSymbol = {
        name: 'QuoteModel',
        qualifiedName: 'App\\Model\\QuoteModel',
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
            name: 'load',
            qualifiedName: 'App\\Model\\QuoteModel::load',
            kind: 'method',
            visibility: 'public',
            lineStart: 4,
            lineEnd: 7,
            signature: 'load(): void',
            returnType: 'void',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

      const existingTargetModel: ParsedSymbol = {
        name: 'RecurringQuoteModel',
        qualifiedName: 'App\\Model\\RecurringQuoteModel',
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
      const controllerMap = symbolRepo.replaceFileSymbols(controllerFile.id, [controller]);
      const builderMap = symbolRepo.replaceFileSymbols(builderFile.id, [builder]);
      const modelMap = symbolRepo.replaceFileSymbols(modelFile.id, [model]);
      symbolRepo.replaceFileSymbols(targetModelFile.id, [existingTargetModel]);

      refRepo.replaceFileReferences(routeFile.id, routeMap, [
        {
          sourceQualifiedName: 'App\\Route\\QuoteRoute::getControllerName',
          targetQualifiedName: 'app\\controller\\quotecontroller',
          kind: 'class_reference',
          line: 5,
        },
      ]);
      refRepo.replaceFileReferences(controllerFile.id, controllerMap, [
        {
          sourceQualifiedName: 'App\\Controller\\QuoteController::getBuilderName',
          targetQualifiedName: 'app\\builder\\quotebuilder',
          kind: 'class_reference',
          line: 5,
        },
      ]);
      refRepo.replaceFileReferences(builderFile.id, builderMap, [
        {
          sourceQualifiedName: 'App\\Builder\\QuoteBuilder::getModelName',
          targetQualifiedName: 'app\\model\\quotemodel',
          kind: 'class_reference',
          line: 5,
        },
      ]);
      refRepo.replaceFileReferences(modelFile.id, modelMap, []);
      refRepo.resolveTargets(repo.id);

      const result = handleScaffoldPlan({
        repoId: repo.id,
        fileRepo,
        symbolRepo,
        refRepo,
      }, {
        reference: 'App\\Route\\QuoteRoute',
        target: 'RecurringQuote',
        depth: 4,
      });

      expect(result).toContain('## Scaffold Plan: App\\Route\\QuoteRoute');
      expect(result).toContain('src/Route/RecurringQuoteRoute.php');
      expect(result).toContain('src/Controller/RecurringQuoteController.php');
      expect(result).toContain('src/Builder/RecurringQuoteBuilder.php');
      expect(result).toContain('src/Model/RecurringQuoteModel.php');
      expect(result).toContain('wire to: via getControllerName() -> App\\Controller\\RecurringQuoteController');
      expect(result).toContain('gap: missing 1, extra 0, shared diffs 0');
    } finally {
      db.close();
    }
  });

  it('supports namespace-aware sub-route scaffolding', () => {
    const db = openDatabase({ path: ':memory:' });

    try {
      runMigrations(db);
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const refRepo = new ReferenceRepository(db);

      const repo = repoRepo.findOrCreate('/test/repo-subroute-plan', 'subroute-plan');
      const builderFile = fileRepo.upsert(repo.id, 'src/Builder/JobCostCenters/AssetsInterface.php', 'php', 'sr1', 10);
      const controllerFile = fileRepo.upsert(repo.id, 'src/Controller/JobCostCenters/AssetsController.php', 'php', 'sr2', 10);
      const modelFile = fileRepo.upsert(repo.id, 'src/Model/JobCostCenters/AssetsModel.php', 'php', 'sr3', 10);

      const builder: ParsedSymbol = {
        name: 'AssetsInterface',
        qualifiedName: 'App\\Builder\\JobCostCenters\\AssetsInterface',
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
            qualifiedName: 'App\\Builder\\JobCostCenters\\AssetsInterface::getControllerName',
            kind: 'method',
            visibility: 'public',
            lineStart: 4,
            lineEnd: 6,
            signature: 'getControllerName(): string',
            returnType: 'string',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

      const controller: ParsedSymbol = {
        name: 'AssetsController',
        qualifiedName: 'App\\Controller\\JobCostCenters\\AssetsController',
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
            name: 'getModelName',
            qualifiedName: 'App\\Controller\\JobCostCenters\\AssetsController::getModelName',
            kind: 'method',
            visibility: 'public',
            lineStart: 4,
            lineEnd: 6,
            signature: 'getModelName(): string',
            returnType: 'string',
            docblock: null,
            metadata: {},
            children: [],
          },
        ],
      };

      const model: ParsedSymbol = {
        name: 'AssetsModel',
        qualifiedName: 'App\\Model\\JobCostCenters\\AssetsModel',
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

      const builderMap = symbolRepo.replaceFileSymbols(builderFile.id, [builder]);
      const controllerMap = symbolRepo.replaceFileSymbols(controllerFile.id, [controller]);
      symbolRepo.replaceFileSymbols(modelFile.id, [model]);

      refRepo.replaceFileReferences(builderFile.id, builderMap, [
        {
          sourceQualifiedName: 'App\\Builder\\JobCostCenters\\AssetsInterface::getControllerName',
          targetQualifiedName: 'app\\controller\\jobcostcenters\\assetscontroller',
          kind: 'class_reference',
          line: 5,
        },
      ]);
      refRepo.replaceFileReferences(controllerFile.id, controllerMap, [
        {
          sourceQualifiedName: 'App\\Controller\\JobCostCenters\\AssetsController::getModelName',
          targetQualifiedName: 'app\\model\\jobcostcenters\\assetsmodel',
          kind: 'class_reference',
          line: 5,
        },
      ]);
      refRepo.resolveTargets(repo.id);

      const result = handleScaffoldPlan({
        repoId: repo.id,
        fileRepo,
        symbolRepo,
        refRepo,
      }, {
        reference: 'App\\Builder\\JobCostCenters\\AssetsInterface',
        target: 'RecurringJobCostCenters\\Assets',
        depth: 4,
      });

      expect(result).not.toContain('resolves to the same stem');
      expect(result).toContain('Target stem: RecurringJobCostCenters\\Assets');
      expect(result).toContain('Source stem: JobCostCenters\\Assets');
      expect(result).toContain('src/Builder/RecurringJobCostCenters/AssetsInterface.php');
      expect(result).toContain('src/Controller/RecurringJobCostCenters/AssetsController.php');
      expect(result).toContain('src/Model/RecurringJobCostCenters/AssetsModel.php');
      expect(result).toContain('wire to: via getControllerName() -> App\\Controller\\RecurringJobCostCenters\\AssetsController');
    } finally {
      db.close();
    }
  });
});
