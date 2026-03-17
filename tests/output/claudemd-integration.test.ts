import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { GeneratePipeline } from '../../src/output/generate-pipeline.js';
import { injectSection } from '../../src/output/claudemd-injector.js';
import type { ParsedSymbol } from '../../src/types.js';

const TEST_DB = {
  host: 'localhost', port: 5435,
  database: 'cartograph_test', user: 'cartograph', password: 'localdev',
};

describe('Generate CLAUDE.md integration', () => {
  let pool: pg.Pool;
  let pipeline: GeneratePipeline;

  beforeAll(async () => {
    pool = new pg.Pool(TEST_DB);

    await pool.query('DELETE FROM symbol_references');
    await pool.query('DELETE FROM symbols');
    await pool.query('DELETE FROM files');
    await pool.query('DELETE FROM repos');

    const repoRepo = new RepoRepository(pool);
    const fileRepo = new FileRepository(pool);
    const symbolRepo = new SymbolRepository(pool);

    const repo = await repoRepo.findOrCreate('/test/generate-repo', 'test-gen');
    const f1 = await fileRepo.upsert(repo.id, 'app/Services/UserService.php', 'php', 'h1', 40);
    const f2 = await fileRepo.upsert(repo.id, 'app/Models/User.php', 'php', 'h2', 30);

    const svc: ParsedSymbol = {
      name: 'UserService', qualifiedName: 'App\\Services\\UserService',
      kind: 'class', visibility: null, lineStart: 1, lineEnd: 40,
      signature: null, returnType: null, docblock: null, metadata: {},
      children: [],
    };
    const model: ParsedSymbol = {
      name: 'User', qualifiedName: 'App\\Models\\User',
      kind: 'class', visibility: null, lineStart: 1, lineEnd: 30,
      signature: null, returnType: null, docblock: null, metadata: {},
      children: [],
    };

    await symbolRepo.replaceFileSymbols(f1.id, [svc]);
    await symbolRepo.replaceFileSymbols(f2.id, [model]);

    pipeline = new GeneratePipeline(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('generates a valid section from real DB data', async () => {
    const section = await pipeline.generateClaudeMdContent('/test/generate-repo');
    expect(section).toContain('CARTOGRAPH:START');
    expect(section).toContain('CARTOGRAPH:END');
    expect(section).toContain('2 files');
    expect(section).toContain('2 symbols');
    expect(section).toContain('cartograph_find');
    expect(section).toContain('cartograph_compare');
  });

  it('injects into existing CLAUDE.md preserving content', async () => {
    const section = await pipeline.generateClaudeMdContent('/test/generate-repo');
    const existing = '# My Project\n\nThis is my project.\n';
    const result = injectSection(existing, section);
    expect(result).toContain('# My Project');
    expect(result).toContain('This is my project.');
    expect(result).toContain('cartograph_find');
  });

  it('updates existing section on re-run', async () => {
    const section = await pipeline.generateClaudeMdContent('/test/generate-repo');
    const firstRun = injectSection('# Project\n', section);
    // Simulate a second run with the same content
    const secondRun = injectSection(firstRun, section);
    // Should still have exactly one pair of markers
    const startCount = (secondRun.match(/CARTOGRAPH:START/g) || []).length;
    expect(startCount).toBe(1);
    expect(secondRun).toContain('# Project');
  });
});
