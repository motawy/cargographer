import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function setup(): Promise<void> {
  // Create test database if it doesn't exist
  const adminPool = new pg.Pool({
    host: 'localhost',
    port: 5433,
    database: 'postgres',
    user: 'cartograph',
    password: 'localdev',
  });

  try {
    await adminPool.query('CREATE DATABASE cartograph_test');
    console.log('Created cartograph_test database');
  } catch (err: unknown) {
    const pgErr = err as { message?: string };
    if (!pgErr.message?.includes('already exists')) throw err;
  }
  await adminPool.end();

  // Run migrations on test DB
  const testPool = new pg.Pool({
    host: 'localhost',
    port: 5433,
    database: 'cartograph_test',
    user: 'cartograph',
    password: 'localdev',
  });

  await runMigrations(testPool, join(__dirname, '..', 'src', 'db', 'migrations'));
  await testPool.end();
}
