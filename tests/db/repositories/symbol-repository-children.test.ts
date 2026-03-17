import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { RepoRepository } from '../../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../../src/db/repositories/symbol-repository.js';
import type { ParsedSymbol } from '../../../src/types.js';

const TEST_POOL_CONFIG = {
  host: 'localhost',
  port: 5435,
  database: 'cartograph_test',
  user: 'cartograph',
  password: 'localdev',
};

describe('SymbolRepository.findChildren', () => {
  let pool: pg.Pool;
  let symbolRepo: SymbolRepository;
  let repoId: number;
  let parentId: number;

  beforeAll(async () => {
    pool = new pg.Pool(TEST_POOL_CONFIG);
    const repoRepo = new RepoRepository(pool);
    const fileRepo = new FileRepository(pool);
    symbolRepo = new SymbolRepository(pool);

    await pool.query('DELETE FROM symbol_references');
    await pool.query('DELETE FROM symbols');
    await pool.query('DELETE FROM files');
    await pool.query('DELETE FROM repos');

    const repo = await repoRepo.findOrCreate('/test/repo', 'test');
    repoId = repo.id;

    const f1 = await fileRepo.upsert(repoId, 'app/Services/UserService.php', 'php', 'h1', 50);

    const svc: ParsedSymbol = {
      name: 'UserService', qualifiedName: 'App\\Services\\UserService',
      kind: 'class', visibility: null, lineStart: 5, lineEnd: 50,
      signature: null, returnType: null, docblock: null, metadata: {},
      children: [
        {
          name: 'findById', qualifiedName: 'App\\Services\\UserService::findById',
          kind: 'method', visibility: 'public', lineStart: 10, lineEnd: 15,
          signature: 'findById(int $id): ?User', returnType: '?User',
          docblock: null, children: [], metadata: {},
        },
        {
          name: 'create', qualifiedName: 'App\\Services\\UserService::create',
          kind: 'method', visibility: 'public', lineStart: 20, lineEnd: 30,
          signature: 'create(array $data): User', returnType: 'User',
          docblock: null, children: [], metadata: {},
        },
        {
          name: 'internalHelper', qualifiedName: 'App\\Services\\UserService::internalHelper',
          kind: 'method', visibility: 'private', lineStart: 35, lineEnd: 40,
          signature: null, returnType: null,
          docblock: null, children: [], metadata: {},
        },
      ],
    };

    await symbolRepo.replaceFileSymbols(f1.id, [svc]);
    // The first ID is the class itself
    const classSymbol = await symbolRepo.findByQualifiedName(repoId, 'App\\Services\\UserService');
    parentId = classSymbol!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns all child symbols ordered by line_start', async () => {
    const children = await symbolRepo.findChildren(parentId);
    expect(children).toHaveLength(3);
    expect(children[0].name).toBe('findById');
    expect(children[1].name).toBe('create');
    expect(children[2].name).toBe('internalHelper');
  });

  it('includes visibility, signature, returnType', async () => {
    const children = await symbolRepo.findChildren(parentId);
    const findById = children.find(c => c.name === 'findById')!;
    expect(findById.visibility).toBe('public');
    expect(findById.signature).toBe('findById(int $id): ?User');
    expect(findById.returnType).toBe('?User');
  });

  it('returns empty array for symbol with no children', async () => {
    const method = await symbolRepo.findByQualifiedName(repoId, 'App\\Services\\UserService::findById');
    const children = await symbolRepo.findChildren(method!.id);
    expect(children).toHaveLength(0);
  });

  it('returns empty array for nonexistent parent', async () => {
    const children = await symbolRepo.findChildren(999999);
    expect(children).toHaveLength(0);
  });
});
