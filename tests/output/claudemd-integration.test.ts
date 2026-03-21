import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { GeneratePipeline } from '../../src/output/generate-pipeline.js';
import { injectSection } from '../../src/output/claudemd-injector.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('Generate CLAUDE.md integration', () => {
  let db: Database.Database;
  let pipeline: GeneratePipeline;

  beforeAll(() => {
    db = openDatabase({ path: ':memory:' });
    runMigrations(db);

    const repoRepo = new RepoRepository(db);
    const fileRepo = new FileRepository(db);
    const symbolRepo = new SymbolRepository(db);

    const repo = repoRepo.findOrCreate('/test/generate-repo', 'test-gen');
    const f1 = fileRepo.upsert(repo.id, 'app/Services/UserService.php', 'php', 'h1', 40);
    const f2 = fileRepo.upsert(repo.id, 'app/Models/User.php', 'php', 'h2', 30);

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

    symbolRepo.replaceFileSymbols(f1.id, [svc]);
    symbolRepo.replaceFileSymbols(f2.id, [model]);

    pipeline = new GeneratePipeline(db);
  });

  afterAll(() => {
    db.close();
  });

  it('generates a valid section from real DB data', () => {
    const section = pipeline.generateClaudeMdContent('/test/generate-repo');
    expect(section).toContain('CARTOGRAPH:START');
    expect(section).toContain('CARTOGRAPH:END');
    expect(section).toContain('2 files');
    expect(section).toContain('2 symbols');
    expect(section).toContain('cartograph_schema');
    expect(section).toContain('cartograph_table_graph');
    expect(section).toContain('cartograph_table_usage');
    expect(section).toContain('cartograph_find');
    expect(section).toContain('cartograph_search_content');
    expect(section).toContain('cartograph_compare');
    expect(section).toContain('cartograph_compare_many');
  });

  it('injects into existing CLAUDE.md preserving content', () => {
    const section = pipeline.generateClaudeMdContent('/test/generate-repo');
    const existing = '# My Project\n\nThis is my project.\n';
    const result = injectSection(existing, section);
    expect(result).toContain('# My Project');
    expect(result).toContain('This is my project.');
    expect(result).toContain('cartograph_schema');
    expect(result).toContain('cartograph_find');
  });

  it('updates existing section on re-run', () => {
    const section = pipeline.generateClaudeMdContent('/test/generate-repo');
    const firstRun = injectSection('# Project\n', section);
    // Simulate a second run with the same content
    const secondRun = injectSection(firstRun, section);
    // Should still have exactly one pair of markers
    const startCount = (secondRun.match(/CARTOGRAPH:START/g) || []).length;
    expect(startCount).toBe(1);
    expect(secondRun).toContain('# Project');
  });
});
