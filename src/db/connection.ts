import pg from 'pg';
import type { DatabaseConfig } from '../types.js';

export function createPool(config: DatabaseConfig): pg.Pool {
  return new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
    max: 10,
  });
}
