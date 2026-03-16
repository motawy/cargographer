import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { join } from 'path';
import type { CartographConfig } from '../../src/types.js';

const TEST_DB = {
  host: 'localhost',
  port: 5435,
  database: 'cartograph_test',
  user: 'cartograph',
  password: 'localdev',
};

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'laravel-sample');

function testConfig(): CartographConfig {
  return {
    languages: ['php'],
    exclude: ['vendor/'],
    database: {
      host: TEST_DB.host,
      port: TEST_DB.port,
      name: TEST_DB.database,
      user: TEST_DB.user,
      password: TEST_DB.password,
    },
  };
}

describe('Reference Resolution (Integration)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool(TEST_DB);
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

  it('creates references during indexing', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM symbol_references'
    );
    expect(rows[0].count).toBeGreaterThan(0);
  });

  it('resolves cross-file implementation references', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows } = await pool.query(
      `SELECT sr.* FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       WHERE s.qualified_name = $1
         AND sr.reference_kind = 'implementation'`,
      ['App\\Services\\UserService']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].target_qualified_name).toBe('app\\contracts\\userserviceinterface');
    expect(rows[0].target_symbol_id).not.toBeNull();
  });

  it('leaves external inheritance references unresolved', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows } = await pool.query(
      `SELECT sr.* FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       WHERE s.qualified_name = $1
         AND sr.reference_kind = 'inheritance'`,
      ['App\\Models\\User']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].target_symbol_id).toBeNull();
  });

  it('resolves trait use references', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows } = await pool.query(
      `SELECT sr.* FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       WHERE s.qualified_name = $1
         AND sr.reference_kind = 'trait_use'`,
      ['App\\Models\\User']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].target_qualified_name).toBe('app\\traits\\hastimestamps');
    expect(rows[0].target_symbol_id).not.toBeNull();
  });

  it('stores type hint references', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows } = await pool.query(
      `SELECT sr.* FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       WHERE s.qualified_name = $1
         AND sr.reference_kind = 'type_hint'`,
      ['App\\Services\\UserService::findById']
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r: Record<string, unknown>) =>
      r.target_qualified_name === 'app\\models\\user'
    )).toBe(true);
  });

  it('stores static call references', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows } = await pool.query(
      `SELECT sr.* FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       WHERE s.qualified_name = $1
         AND sr.reference_kind = 'static_call'`,
      ['App\\Repositories\\UserRepository::find']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].target_qualified_name).toBe('app\\models\\user::find');
  });

  it('reference count is reasonable for fixture project', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM symbol_references'
    );
    expect(rows[0].count).toBeGreaterThanOrEqual(15);
    expect(rows[0].count).toBeLessThan(60);
  });

  it('is idempotent — re-indexing produces same reference count', async () => {
    const pipeline = new IndexPipeline(pool);
    const config = testConfig();

    await pipeline.run(FIXTURES, config);
    const { rows: first } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM symbol_references'
    );

    // Force re-parse by clearing hashes
    await pool.query("UPDATE files SET hash = 'stale'");
    await pipeline.run(FIXTURES, config);
    const { rows: second } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM symbol_references'
    );

    expect(first[0].count).toBe(second[0].count);
  });
});
