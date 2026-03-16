import { describe, it, expect } from 'vitest';
import { generateModules } from '../../src/output/modules-generator.js';
import type { ModuleInfo } from '../../src/output/generate-pipeline.js';

function makeModules(count = 3, symbolsPerModule = 5): ModuleInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `app/Module${i}`,
    symbols: Array.from({ length: symbolsPerModule }, (_, j) => ({
      qualifiedName: `App\\Module${i}\\Class${j}`,
      kind: 'class',
      linesOfCode: 50,
      implements: j === 0 ? [`App\\Contracts\\Interface${i}`] : [],
      extends: j === 1 ? `App\\Base\\BaseClass` : null,
      traits: [],
      referenceCount: 10 - j,
    })),
  }));
}

describe('generateModules', () => {
  it('groups symbols by module', () => {
    const result = generateModules(makeModules());
    expect(result).toContain('## app/Module0');
    expect(result).toContain('## app/Module1');
    expect(result).toContain('## app/Module2');
  });

  it('shows symbol count per module', () => {
    const result = generateModules(makeModules(1, 8));
    expect(result).toContain('8 symbols');
  });

  it('formats relationships', () => {
    const result = generateModules(makeModules());
    expect(result).toContain('impl Interface0');
    expect(result).toContain('extends BaseClass');
  });

  it('shows reference counts', () => {
    const result = generateModules(makeModules(1, 3));
    expect(result).toContain('| Class0 | class | 10 |');
  });

  it('truncates large modules', () => {
    const result = generateModules(makeModules(1, 25));
    expect(result).toContain('... and 10 more');
  });

  it('truncates many modules', () => {
    const result = generateModules(makeModules(50, 2));
    expect(result).toContain('... and 10 more modules');
  });
});
