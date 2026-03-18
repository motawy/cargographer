import Database from 'better-sqlite3';
import type { DatabaseConfig } from '../types.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export function openDatabase(config: DatabaseConfig): Database.Database {
  // Ensure parent directory exists
  if (config.path !== ':memory:') {
    mkdirSync(dirname(config.path), { recursive: true });
  }

  const db = new Database(config.path);

  // Performance and safety pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return db;
}
