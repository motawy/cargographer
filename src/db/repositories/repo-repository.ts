import type Database from 'better-sqlite3';
import { parseSqliteTimestamp } from '../../utils/sqlite-time.js';

export interface RepoRecord {
  id: number;
  path: string;
  name: string;
  createdAt: Date;
  lastIndexedAt: Date | null;
}

export class RepoRepository {
  constructor(private db: Database.Database) {}

  findOrCreate(path: string, name: string): RepoRecord {
    this.db.prepare(
      `INSERT OR IGNORE INTO repos (path, name) VALUES (?, ?)`
    ).run(path, name);

    this.db.prepare(
      `UPDATE repos SET name = ? WHERE path = ?`
    ).run(name, path);

    return this.findByPath(path)!;
  }

  findByPath(path: string): RepoRecord | null {
    const row = this.db.prepare(
      'SELECT id, path, name, created_at, last_indexed_at FROM repos WHERE path = ?'
    ).get(path) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toRecord(row);
  }

  updateLastIndexed(id: number): void {
    this.db.prepare(
      "UPDATE repos SET last_indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).run(id);
  }

  private toRecord(row: Record<string, unknown>): RepoRecord {
    return {
      id: row.id as number,
      path: row.path as string,
      name: row.name as string,
      createdAt: parseSqliteTimestamp(row.created_at as string),
      lastIndexedAt: row.last_indexed_at ? parseSqliteTimestamp(row.last_indexed_at as string) : null,
    };
  }
}
