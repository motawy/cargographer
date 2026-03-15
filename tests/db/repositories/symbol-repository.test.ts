import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { RepoRepository } from '../../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../../src/db/repositories/symbol-repository.js';
import type { ParsedSymbol } from '../../../src/types.js';

const TEST_POOL_CONFIG = {
  host: 'localhost',
  port: 5433,
  database: 'cartograph_test',
  user: 'cartograph',
  password: 'localdev',
};

describe('SymbolRepository', () => {
  let pool: pg.Pool;
  let repoRepo: RepoRepository;
  let fileRepo: FileRepository;
  let symbolRepo: SymbolRepository;

  beforeAll(() => {
    pool = new pg.Pool(TEST_POOL_CONFIG);
    repoRepo = new RepoRepository(pool);
    fileRepo = new FileRepository(pool);
    symbolRepo = new SymbolRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM symbol_references');
    await pool.query('DELETE FROM symbols');
    await pool.query('DELETE FROM files');
    await pool.query('DELETE FROM repos');
  });

  it('stores and retrieves symbols with parent-child relationships', async () => {
    const repo = await repoRepo.findOrCreate('/test/repo', 'test-repo');
    const file = await fileRepo.upsert(
      repo.id,
      'app/Services/UserService.php',
      'php',
      'abc123',
      50
    );

    const classSymbol: ParsedSymbol = {
      name: 'UserService',
      qualifiedName: 'App\\Services\\UserService',
      kind: 'class',
      visibility: null,
      lineStart: 8,
      lineEnd: 30,
      signature: null,
      returnType: null,
      docblock: null,
      children: [
        {
          name: 'findById',
          qualifiedName: 'App\\Services\\UserService::findById',
          kind: 'method',
          visibility: 'public',
          lineStart: 15,
          lineEnd: 18,
          signature: 'findById(int $id): ?User',
          returnType: '?User',
          docblock: '/** Find a user by ID. */',
          children: [],
          metadata: {},
        },
      ],
      metadata: {},
    };

    await symbolRepo.replaceFileSymbols(file.id, [classSymbol]);

    const symbols = await symbolRepo.findByFile(file.id);
    expect(symbols).toHaveLength(2); // class + method

    const cls = symbols.find((s) => s.kind === 'class');
    expect(cls?.qualifiedName).toBe('App\\Services\\UserService');
    expect(cls?.parentSymbolId).toBeNull();

    const method = symbols.find((s) => s.kind === 'method');
    expect(method?.qualifiedName).toBe(
      'App\\Services\\UserService::findById'
    );
    expect(method?.parentSymbolId).toBe(cls?.id);
    expect(method?.visibility).toBe('public');
    expect(method?.returnType).toBe('?User');
    expect(method?.docblock).toBe('/** Find a user by ID. */');
    expect(method?.signature).toBe('findById(int $id): ?User');
  });

  it('replaceFileSymbols is idempotent', async () => {
    const repo = await repoRepo.findOrCreate('/test/repo', 'test-repo');
    const file = await fileRepo.upsert(repo.id, 'test.php', 'php', 'hash1', 10);

    const symbols: ParsedSymbol[] = [
      {
        name: 'Foo',
        qualifiedName: 'Foo',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 5,
        signature: null,
        returnType: null,
        docblock: null,
        children: [],
        metadata: {},
      },
    ];

    await symbolRepo.replaceFileSymbols(file.id, symbols);
    await symbolRepo.replaceFileSymbols(file.id, symbols);

    const result = await symbolRepo.findByFile(file.id);
    expect(result).toHaveLength(1);
  });

  it('countByRepo returns total symbols across all files', async () => {
    const repo = await repoRepo.findOrCreate('/test/repo', 'test-repo');
    const f1 = await fileRepo.upsert(repo.id, 'a.php', 'php', 'h1', 10);
    const f2 = await fileRepo.upsert(repo.id, 'b.php', 'php', 'h2', 10);

    await symbolRepo.replaceFileSymbols(f1.id, [
      {
        name: 'A',
        qualifiedName: 'A',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 5,
        signature: null,
        returnType: null,
        docblock: null,
        children: [],
        metadata: {},
      },
    ]);
    await symbolRepo.replaceFileSymbols(f2.id, [
      {
        name: 'B',
        qualifiedName: 'B',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 5,
        signature: null,
        returnType: null,
        docblock: null,
        children: [],
        metadata: {},
      },
    ]);

    const count = await symbolRepo.countByRepo(repo.id);
    expect(count).toBe(2);
  });

  it('stores and retrieves metadata as JSON', async () => {
    const repo = await repoRepo.findOrCreate('/test/repo', 'test-repo');
    const file = await fileRepo.upsert(repo.id, 'c.php', 'php', 'h3', 10);

    await symbolRepo.replaceFileSymbols(file.id, [
      {
        name: 'Bar',
        qualifiedName: 'Bar',
        kind: 'class',
        visibility: null,
        lineStart: 1,
        lineEnd: 10,
        signature: null,
        returnType: null,
        docblock: null,
        children: [],
        metadata: { extends: 'Foo', implements: ['Baz', 'Qux'] },
      },
    ]);

    const symbols = await symbolRepo.findByFile(file.id);
    expect(symbols[0].metadata.extends).toBe('Foo');
    expect(symbols[0].metadata.implements).toEqual(['Baz', 'Qux']);
  });
});
