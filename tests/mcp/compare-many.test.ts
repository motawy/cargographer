import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../../src/db/repositories/reference-repository.js';
import { handleCompareMany } from '../../src/mcp/tools/compare-many.js';
import type { ToolDeps } from '../../src/mcp/types.js';
import type { ParsedSymbol } from '../../src/types.js';

function makeClassWithMethods(
  name: string,
  qn: string,
  methods: { name: string; line: number; span?: number }[]
): ParsedSymbol {
  return {
    name,
    qualifiedName: qn,
    kind: 'class',
    visibility: null,
    lineStart: 1,
    lineEnd: 40,
    signature: null,
    returnType: null,
    docblock: null,
    metadata: {},
    children: methods.map((method) => ({
      name: method.name,
      qualifiedName: `${qn}::${method.name}`,
      kind: 'method' as const,
      visibility: 'public',
      lineStart: method.line,
      lineEnd: method.line + (method.span ?? 2),
      signature: null,
      returnType: null,
      docblock: null,
      metadata: {},
      children: [],
    })),
  };
}

describe('cartograph_compare_many', () => {
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
    const baselineFile = fileRepo.upsert(repo.id, 'app/JobCostCenters.php', 'php', 'a', 20);
    const recurringFile = fileRepo.upsert(repo.id, 'app/RecurringJobCostCenters.php', 'php', 'b', 20);
    const quoteFile = fileRepo.upsert(repo.id, 'app/QuoteCostCenters.php', 'php', 'c', 20);

    symbolRepo.replaceFileSymbols(baselineFile.id, [
      makeClassWithMethods('JobCostCenters', 'App\\JobCostCenters', [
        { name: 'getControllerName', line: 3 },
        { name: 'getBuilderName', line: 6 },
        { name: 'getSubRouteFolder', line: 9 },
      ]),
    ]);
    symbolRepo.replaceFileSymbols(recurringFile.id, [
      makeClassWithMethods('RecurringJobCostCenters', 'App\\RecurringJobCostCenters', [
        { name: 'getControllerName', line: 3 },
        { name: 'getBuilderName', line: 6 },
      ]),
    ]);
    symbolRepo.replaceFileSymbols(quoteFile.id, [
      makeClassWithMethods('QuoteCostCenters', 'App\\QuoteCostCenters', [
        { name: 'getControllerName', line: 3 },
        { name: 'getBuilderName', line: 6 },
        { name: 'getSubRouteFolder', line: 9 },
        { name: 'getExtraThing', line: 12 },
      ]),
    ]);

    deps = { repoId: repo.id, symbolRepo, refRepo };
  });

  afterAll(() => {
    db.close();
  });

  it('summarizes missing and extra methods across several targets', () => {
    const result = handleCompareMany(deps, {
      baseline: 'App\\JobCostCenters',
      others: ['App\\RecurringJobCostCenters', 'App\\QuoteCostCenters'],
    });

    expect(result).toContain('## Compare Many: App\\JobCostCenters');
    expect(result).toContain('Missing from target compared to baseline (1): getSubRouteFolder');
    expect(result).toContain('Extra in target (1): getExtraThing');
  });

  it('reports missing targets without failing the whole comparison', () => {
    const result = handleCompareMany(deps, {
      baseline: 'App\\JobCostCenters',
      others: ['App\\MissingSibling'],
    });

    expect(result).toContain('### vs App\\MissingSibling');
    expect(result).toContain('Symbol not found');
  });

  it('shows baseline method bodies for missing methods when repo files are available', () => {
    const repoRepo = new RepoRepository(db);
    const fileRepo = new FileRepository(db);
    const symbolRepo = new SymbolRepository(db);
    const refRepo = new ReferenceRepository(db);

    const tmpDir = '/tmp/cartograph-compare-many-body-test';
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(`${tmpDir}/baseline.php`, [
      '<?php',
      'class Baseline {',
      '    protected function getSubRouteFolder(): string',
      '    {',
      "        return 'JobCostCenters';",
      '    }',
      '}',
    ].join('\n'));
    writeFileSync(`${tmpDir}/target.php`, [
      '<?php',
      'class Target {',
      '}',
    ].join('\n'));

    try {
      const repo = repoRepo.findOrCreate(tmpDir, 'compare-many-body');
      const baselineFile = fileRepo.upsert(repo.id, 'baseline.php', 'php', 'cb1', 7);
      const targetFile = fileRepo.upsert(repo.id, 'target.php', 'php', 'cb2', 3);

      symbolRepo.replaceFileSymbols(baselineFile.id, [
        makeClassWithMethods('Baseline', 'Test\\Baseline', [
          { name: 'getSubRouteFolder', line: 3 },
        ]),
      ]);
      symbolRepo.replaceFileSymbols(targetFile.id, [
        makeClassWithMethods('Target', 'Test\\Target', []),
      ]);

      const result = handleCompareMany(
        { repoId: repo.id, repoPath: tmpDir, symbolRepo, refRepo },
        { baseline: 'Test\\Baseline', others: ['Test\\Target'] }
      );

      expect(result).toContain('Baseline implementations for missing methods');
      expect(result).toContain("return 'JobCostCenters'");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('shows truncated baseline snippets for longer missing methods', () => {
    const repoRepo = new RepoRepository(db);
    const fileRepo = new FileRepository(db);
    const symbolRepo = new SymbolRepository(db);
    const refRepo = new ReferenceRepository(db);

    const tmpDir = '/tmp/cartograph-compare-many-long-body-test';
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(`${tmpDir}/baseline.php`, [
      '<?php',
      'class BaselineLong {',
      '    protected function createPayload(): array',
      '    {',
      "        $payload = ['table' => 'recurring_quote_sections'];",
      "        $payload['enabled'] = true;",
      "        $payload['depth'] = 3;",
      "        $payload['mode'] = 'sync';",
      "        $payload['owner'] = 'api';",
      "        $payload['retry'] = false;",
      "        $payload['scope'] = 'rest';",
      "        $payload['source'] = 'builder';",
      '        return $payload;',
      '    }',
      '}',
    ].join('\n'));
    writeFileSync(`${tmpDir}/target.php`, [
      '<?php',
      'class TargetLong {',
      '}',
    ].join('\n'));

    try {
      const repo = repoRepo.findOrCreate(tmpDir, 'compare-many-long-body');
      const baselineFile = fileRepo.upsert(repo.id, 'baseline.php', 'php', 'lb1', 15);
      const targetFile = fileRepo.upsert(repo.id, 'target.php', 'php', 'lb2', 3);

      symbolRepo.replaceFileSymbols(baselineFile.id, [
        makeClassWithMethods('BaselineLong', 'Test\\BaselineLong', [
          { name: 'createPayload', line: 3, span: 11 },
        ]),
      ]);
      symbolRepo.replaceFileSymbols(targetFile.id, [
        makeClassWithMethods('TargetLong', 'Test\\TargetLong', []),
      ]);

      const result = handleCompareMany(
        { repoId: repo.id, repoPath: tmpDir, symbolRepo, refRepo },
        { baseline: 'Test\\BaselineLong', others: ['Test\\TargetLong'] }
      );

      expect(result).toContain("['table' => 'recurring_quote_sections']");
      expect(result).toContain("$payload['owner'] = 'api';");
      expect(result).toContain('...');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('shows shared method diff bodies for differing implementations', () => {
    const repoRepo = new RepoRepository(db);
    const fileRepo = new FileRepository(db);
    const symbolRepo = new SymbolRepository(db);
    const refRepo = new ReferenceRepository(db);

    const tmpDir = '/tmp/cartograph-compare-many-shared-diff-test';
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(`${tmpDir}/baseline.php`, [
      '<?php',
      'class BaselineDiff {',
      '    protected function getReferenceID()',
      '    {',
      "        return (int) $this->args['jobID'];",
      '    }',
      '}',
    ].join('\n'));
    writeFileSync(`${tmpDir}/target.php`, [
      '<?php',
      'class TargetDiff {',
      '    protected function getReferenceID()',
      '    {',
      "        return (int) $this->args['recurringJobID'];",
      '    }',
      '}',
    ].join('\n'));

    try {
      const repo = repoRepo.findOrCreate(tmpDir, 'compare-many-shared-diff');
      const baselineFile = fileRepo.upsert(repo.id, 'baseline.php', 'php', 'sdm1', 7);
      const targetFile = fileRepo.upsert(repo.id, 'target.php', 'php', 'sdm2', 7);

      symbolRepo.replaceFileSymbols(baselineFile.id, [
        makeClassWithMethods('BaselineDiff', 'Test\\BaselineDiff', [
          { name: 'getReferenceID', line: 3 },
        ]),
      ]);
      symbolRepo.replaceFileSymbols(targetFile.id, [
        makeClassWithMethods('TargetDiff', 'Test\\TargetDiff', [
          { name: 'getReferenceID', line: 3 },
        ]),
      ]);

      const result = handleCompareMany(
        { repoId: repo.id, repoPath: tmpDir, symbolRepo, refRepo },
        { baseline: 'Test\\BaselineDiff', others: ['Test\\TargetDiff'] }
      );

      expect(result).toContain('Shared method diffs');
      expect(result).toContain("Baseline (line 3):");
      expect(result).toContain("$this->args['jobID']");
      expect(result).toContain("Target (line 3):");
      expect(result).toContain("$this->args['recurringJobID']");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
