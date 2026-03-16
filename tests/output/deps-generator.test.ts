import { describe, it, expect } from 'vitest';
import { generateDeps } from '../../src/output/deps-generator.js';
import type { DepsData } from '../../src/output/generate-pipeline.js';

function makeDeps(overrides: Partial<DepsData> = {}): DepsData {
  return {
    internal: [
      { sourceModule: 'app/Services', targetModule: 'app/Models', referenceCount: 142 },
      { sourceModule: 'app/Services', targetModule: 'app/Repositories', referenceCount: 87 },
      { sourceModule: 'app/Http', targetModule: 'app/Services', referenceCount: 91 },
      { sourceModule: 'app/Repositories', targetModule: 'app/Models', referenceCount: 156 },
    ],
    external: [
      { namespace: 'Illuminate', referenceCount: 340 },
      { namespace: 'Symfony', referenceCount: 45 },
    ],
    ...overrides,
  };
}

describe('generateDeps', () => {
  it('shows directed dependencies with counts', () => {
    const result = generateDeps(makeDeps());
    expect(result).toContain('app/Services → app/Models (142 refs)');
    expect(result).toContain('app/Http → app/Services (91 refs)');
  });

  it('detects layer violations', () => {
    const result = generateDeps(makeDeps({
      internal: [
        { sourceModule: 'app/Models', targetModule: 'app/Services', referenceCount: 5 },
        { sourceModule: 'app/Services', targetModule: 'app/Models', referenceCount: 100 },
      ],
    }));
    expect(result).toContain('Potential Layer Violations');
    expect(result).toContain('app/Models → app/Services');
  });

  it('does not flag unknown layers as violations', () => {
    const result = generateDeps(makeDeps({
      internal: [
        { sourceModule: 'lib/utils', targetModule: 'app/Services', referenceCount: 10 },
      ],
    }));
    expect(result).not.toContain('Potential Layer Violations');
  });

  it('shows external dependencies', () => {
    const result = generateDeps(makeDeps());
    expect(result).toContain('Illuminate');
    expect(result).toContain('340');
    expect(result).toContain('Symfony');
  });

  it('handles no violations gracefully', () => {
    const result = generateDeps(makeDeps());
    expect(result).not.toContain('Potential Layer Violations');
  });

  it('handles empty data', () => {
    const result = generateDeps({ internal: [], external: [] });
    expect(result).toContain('# Dependencies');
    expect(result).not.toContain('External Dependencies');
  });
});
