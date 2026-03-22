import { describe, it, expect } from 'vitest';
import { generateRoot } from '../../src/output/root-generator.js';
import type { RepoStats, ConventionsData } from '../../src/output/generate-pipeline.js';

function makeConventions(overrides: Partial<ConventionsData> = {}): ConventionsData {
  return {
    totalClasses: 100,
    totalInterfaces: 20,
    totalTraits: 10,
    totalEnums: 0,
    classesWithInterface: 45,
    classesWithInheritance: 60,
    classesWithTraits: 15,
    interfaceAdoptionByModule: new Map(),
    classNames: [],
    methodNames: [],
    ...overrides,
  };
}

function makeStats(overrides: Partial<RepoStats> = {}): RepoStats {
  return {
    totalFiles: 100,
    totalSymbols: 500,
    totalReferences: 200,
    language: 'php',
    directories: [
      { path: 'app/Models', fileCount: 10, symbolCount: 50, classCount: 10, dominantKinds: ['class'] },
      { path: 'app/Services', fileCount: 8, symbolCount: 40, classCount: 8, dominantKinds: ['class'] },
      { path: 'app/Repositories', fileCount: 6, symbolCount: 30, classCount: 6, dominantKinds: ['class'] },
      { path: 'app/Http', fileCount: 12, symbolCount: 60, classCount: 12, dominantKinds: ['class'] },
    ],
    ...overrides,
  };
}

describe('generateRoot', () => {
  it('includes project overview with stats', () => {
    const result = generateRoot(makeStats());
    expect(result).toContain('**Language:** Php');
    expect(result).toContain('**Files:** 100');
    expect(result).toContain('**Symbols:** 500');
  });

  it('detects architecture from directory names', () => {
    const result = generateRoot(makeStats());
    expect(result).toContain('service layer');
    expect(result).toContain('repository pattern');
  });

  it('includes directory map', () => {
    const result = generateRoot(makeStats());
    expect(result).toContain('app/Models');
    expect(result).toContain('app/Services');
    expect(result).toContain('symbols');
  });

  it('includes context file links', () => {
    const result = generateRoot(makeStats());
    expect(result).toContain('[Modules](modules.md)');
    expect(result).toContain('[Dependencies](dependencies.md)');
    expect(result).toContain('[Conventions](conventions.md)');
  });

  it('truncates directory map for large codebases', () => {
    const dirs = Array.from({ length: 50 }, (_, i) => ({
      path: `dir/module${i}`,
      fileCount: 5,
      symbolCount: 20,
      classCount: 5,
      dominantKinds: ['class'] as string[],
    }));
    const result = generateRoot(makeStats({ directories: dirs }));
    expect(result).toContain('... and 20 more directories');
  });

  it('handles unknown architecture gracefully', () => {
    const result = generateRoot(makeStats({
      directories: [
        { path: 'lib/foo', fileCount: 5, symbolCount: 20, classCount: 5, dominantKinds: ['class'] },
      ],
    }));
    expect(result).toContain('Architecture pattern could not be determined');
  });

  it('states interface adoption percentage with low adoption', () => {
    const stats = makeStats({
      directories: [
        { path: 'objects/Interfaces', fileCount: 50, symbolCount: 168, classCount: 0, dominantKinds: ['interface'] },
        { path: 'objects/Entity', fileCount: 100, symbolCount: 500, classCount: 500, dominantKinds: ['class'] },
      ],
    });
    const conventions = makeConventions({
      totalClasses: 15000,
      classesWithInterface: 39,
    });
    const result = generateRoot(stats, conventions);
    expect(result).toContain('interfaces (0% of classes implement one)');
  });

  it('states interface adoption percentage with high adoption', () => {
    const stats = makeStats({
      directories: [
        { path: 'app/Contracts', fileCount: 20, symbolCount: 50, classCount: 0, dominantKinds: ['interface'] },
        { path: 'app/Services', fileCount: 30, symbolCount: 100, classCount: 100, dominantKinds: ['class'] },
      ],
    });
    const conventions = makeConventions({
      totalClasses: 100,
      classesWithInterface: 45,
    });
    const result = generateRoot(stats, conventions);
    expect(result).toContain('interfaces (45% of classes implement one)');
  });

  it('includes Cartograph MCP tools section', () => {
    const result = generateRoot(makeStats());
    expect(result).toContain('## Cartograph Tools');
    expect(result).toContain('cartograph_schema');
    expect(result).toContain('cartograph_table');
    expect(result).toContain('cartograph_table_graph');
    expect(result).toContain('cartograph_table_usage');
    expect(result).toContain('cartograph_test_targets');
    expect(result).toContain('cartograph_scaffold_plan');
    expect(result).toContain('does not write files');
    expect(result).toContain('cartograph_search_content');
    expect(result).toContain('cartograph_symbol');
    expect(result).toContain('cartograph_deps');
    expect(result).toContain('cartograph_blast_radius');
    expect(result).toContain('cartograph_find');
    expect(result).toContain('cartograph_compare_many');
    expect(result).toContain('full inlined shared-method body and wiring diffs');
    expect(result).toContain('Use these before grepping');
  });

  it('includes top adopting modules in interface description', () => {
    const stats = makeStats({
      directories: [
        { path: 'app/Contracts', fileCount: 20, symbolCount: 50, classCount: 0, dominantKinds: ['interface'] },
        { path: 'app/Services', fileCount: 30, symbolCount: 100, classCount: 100, dominantKinds: ['class'] },
      ],
    });
    const conventions = makeConventions({
      totalClasses: 100,
      classesWithInterface: 45,
      interfaceAdoptionByModule: new Map([
        ['objects/Entity', { total: 50, withInterface: 20 }],
        ['objects/Status', { total: 30, withInterface: 10 }],
        ['app/Tiny', { total: 5, withInterface: 3 }],
      ]),
    });
    const result = generateRoot(stats, conventions);
    expect(result).toContain('concentrated in objects/Entity 40%, objects/Status 33%');
    // app/Tiny excluded — fewer than 10 classes
    expect(result).not.toContain('app/Tiny');
  });
});
