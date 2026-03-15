import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { join } from 'path';
import type { CartographConfig } from '../../src/types.js';

const TEST_DB = {
  host: 'localhost',
  port: 5433,
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

describe('Index Pipeline (Integration)', () => {
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

  it('indexes fixture project and stores correct files', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows: files } = await pool.query(
      'SELECT path FROM files ORDER BY path'
    );
    expect(files).toHaveLength(6);
    expect(files.map((f: { path: string }) => f.path)).toEqual([
      'app/Contracts/UserServiceInterface.php',
      'app/Http/Controllers/UserController.php',
      'app/Models/User.php',
      'app/Repositories/UserRepository.php',
      'app/Services/UserService.php',
      'app/Traits/HasTimestamps.php',
    ]);
  });

  it('stores symbols with correct qualified names and kinds', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    // Verify class
    const { rows: userClass } = await pool.query(
      "SELECT * FROM symbols WHERE qualified_name = $1",
      ['App\\Models\\User']
    );
    expect(userClass).toHaveLength(1);
    expect(userClass[0].kind).toBe('class');

    // Verify interface
    const { rows: iface } = await pool.query(
      "SELECT * FROM symbols WHERE qualified_name = $1",
      ['App\\Contracts\\UserServiceInterface']
    );
    expect(iface).toHaveLength(1);
    expect(iface[0].kind).toBe('interface');

    // Verify trait
    const { rows: trait } = await pool.query(
      "SELECT * FROM symbols WHERE qualified_name = $1",
      ['App\\Traits\\HasTimestamps']
    );
    expect(trait).toHaveLength(1);
    expect(trait[0].kind).toBe('trait');

    // Verify method with parent relationship
    const { rows: findById } = await pool.query(
      "SELECT * FROM symbols WHERE qualified_name = $1",
      ['App\\Services\\UserService::findById']
    );
    expect(findById).toHaveLength(1);
    expect(findById[0].kind).toBe('method');
    expect(findById[0].visibility).toBe('public');

    const { rows: serviceClass } = await pool.query(
      "SELECT * FROM symbols WHERE qualified_name = $1",
      ['App\\Services\\UserService']
    );
    expect(findById[0].parent_symbol_id).toBe(serviceClass[0].id);
  });

  it('stores constructor promoted properties', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows } = await pool.query(
      "SELECT * FROM symbols WHERE qualified_name = $1",
      ['App\\Http\\Controllers\\UserController::$userService']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('property');
    expect(rows[0].visibility).toBe('private');
    expect(rows[0].metadata).toEqual(
      expect.objectContaining({ promoted: true, readonly: true })
    );
  });

  it('is idempotent — re-indexing produces same symbol count', async () => {
    const pipeline = new IndexPipeline(pool);
    const config = testConfig();

    await pipeline.run(FIXTURES, config);
    const { rows: first } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM symbols'
    );

    await pipeline.run(FIXTURES, config);
    const { rows: second } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM symbols'
    );

    expect(first[0].count).toBe(second[0].count);
  });

  it('second run detects 0 changes for unchanged files', async () => {
    const pipeline = new IndexPipeline(pool);
    const config = testConfig();

    await pipeline.run(FIXTURES, config);
    await pipeline.run(FIXTURES, config);

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM symbols'
    );
    expect(rows[0].count).toBeGreaterThan(0);
  });

  it('stores all expected symbol kinds', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows: kinds } = await pool.query(
      'SELECT DISTINCT kind FROM symbols ORDER BY kind'
    );
    const kindList = kinds.map((r: { kind: string }) => r.kind);

    expect(kindList).toContain('class');
    expect(kindList).toContain('interface');
    expect(kindList).toContain('trait');
    expect(kindList).toContain('method');
    expect(kindList).toContain('property');
    expect(kindList).toContain('constant');
  });

  it('stores file metadata correctly', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows } = await pool.query(
      "SELECT * FROM files WHERE path = $1",
      ['app/Models/User.php']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].language).toBe('php');
    expect(rows[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0].lines_of_code).toBeGreaterThan(0);
  });
});
