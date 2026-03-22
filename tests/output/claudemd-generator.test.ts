import { describe, it, expect } from 'vitest';
import { generateClaudeMdSection } from '../../src/output/claudemd-generator.js';
import type { RepoStats, ConventionsData } from '../../src/output/generate-pipeline.js';

function makeStats(overrides: Partial<RepoStats> = {}): RepoStats {
  return {
    totalFiles: 16000,
    totalSymbols: 122000,
    totalReferences: 85000,
    language: 'php',
    directories: [
      { path: 'app/Services', fileCount: 200, symbolCount: 5000, classCount: 200, dominantKinds: ['class'] },
      { path: 'app/Models', fileCount: 150, symbolCount: 3000, classCount: 150, dominantKinds: ['class'] },
      { path: 'app/Routes', fileCount: 100, symbolCount: 2000, classCount: 100, dominantKinds: ['class'] },
    ],
    ...overrides,
  };
}

function makeConventions(overrides: Partial<ConventionsData> = {}): ConventionsData {
  return {
    totalClasses: 5000,
    totalInterfaces: 200,
    totalTraits: 50,
    totalEnums: 10,
    classesWithInterface: 100,
    classesWithInheritance: 3000,
    classesWithTraits: 500,
    interfaceAdoptionByModule: new Map(),
    classNames: [],
    methodNames: [],
    ...overrides,
  };
}

describe('generateClaudeMdSection', () => {
  it('includes start and end markers', () => {
    const result = generateClaudeMdSection(makeStats(), makeConventions());
    expect(result).toMatch(/^<!-- CARTOGRAPH:START/);
    expect(result).toMatch(/<!-- CARTOGRAPH:END -->$/);
  });

  it('includes codebase size stats', () => {
    const result = generateClaudeMdSection(makeStats(), makeConventions());
    expect(result).toContain('16,000 files');
    expect(result).toContain('122,000 symbols');
  });

  it('lists all 19 MCP tools with descriptions', () => {
    const result = generateClaudeMdSection(makeStats(), makeConventions());
    expect(result).toContain('cartograph_schema');
    expect(result).toContain('cartograph_table');
    expect(result).toContain('cartograph_table_graph');
    expect(result).toContain('cartograph_table_usage');
    expect(result).toContain('cartograph_column_usage');
    expect(result).toContain('cartograph_sql_validate');
    expect(result).toContain('cartograph_test_targets');
    expect(result).toContain('cartograph_scaffold_plan');
    expect(result).toContain('cartograph_route_pairs');
    expect(result).toContain('cartograph_find');
    expect(result).toContain('cartograph_search_content');
    expect(result).toContain('cartograph_symbol');
    expect(result).toContain('cartograph_deps');
    expect(result).toContain('cartograph_dependents');
    expect(result).toContain('cartograph_blast_radius');
    expect(result).toContain('cartograph_flow');
    expect(result).toContain('cartograph_compare');
    expect(result).toContain('cartograph_compare_many');
    expect(result).toContain('cartograph_status');
  });

  it('includes find tool usage guidance (fuzzy, path, kind)', () => {
    const result = generateClaudeMdSection(makeStats(), makeConventions());
    expect(result).toContain('fuzzy');
    expect(result).toContain('path');
    expect(result).toContain('kind');
  });

  it('includes workflow directive to use tools before grepping', () => {
    const result = generateClaudeMdSection(makeStats(), makeConventions());
    expect(result).toContain('before');
    expect(result).toMatch(/grep|read|find/i);
    expect(result).toContain('cartograph_schema');
    expect(result).toContain('cartograph_table_graph');
    expect(result).toContain('cartograph_table_usage');
    expect(result).toContain('cartograph_column_usage');
    expect(result).toContain('cartograph_sql_validate');
    expect(result).toContain('cartograph_search_content');
  });

  it('includes clear tool limits for planning and heuristic tools', () => {
    const result = generateClaudeMdSection(makeStats(), makeConventions());
    expect(result).toContain('### Tool Limits');
    expect(result).toContain('full SQL parser');
    expect(result).toContain('ranked suggestions only');
    expect(result).toContain('does not write files');
    expect(result).toContain('does not infer file lists');
    expect(result).toContain('full inlined shared-method wiring/body diffs');
  });

  it('includes cartograph_status guidance', () => {
    const result = generateClaudeMdSection(makeStats(), makeConventions());
    expect(result).toContain('cartograph_status');
    expect(result).toMatch(/fresh|stale|index/i);
  });

  it('adapts messaging for small codebases', () => {
    const result = generateClaudeMdSection(
      makeStats({ totalFiles: 50, totalSymbols: 200 }),
      makeConventions()
    );
    expect(result).toContain('50 files');
    expect(result).toContain('200 symbols');
  });

  it('includes top directories for orientation', () => {
    const result = generateClaudeMdSection(makeStats(), makeConventions());
    expect(result).toContain('app/Services');
    expect(result).toContain('app/Models');
  });
});
