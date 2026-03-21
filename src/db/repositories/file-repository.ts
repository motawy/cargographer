import type Database from 'better-sqlite3';
import { parseSqliteTimestamp } from '../../utils/sqlite-time.js';

export interface FileRecord {
  id: number;
  repoId: number;
  path: string;
  language: string;
  hash: string;
  lastIndexedAt: Date;
  linesOfCode: number | null;
}

export class FileRepository {
  constructor(private db: Database.Database) {}

  upsert(
    repoId: number,
    path: string,
    language: string,
    hash: string,
    linesOfCode: number
  ): FileRecord {
    this.db.prepare(
      `INSERT INTO files (repo_id, path, language, hash, last_indexed_at, lines_of_code)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
       ON CONFLICT (repo_id, path)
       DO UPDATE SET hash = excluded.hash, last_indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), lines_of_code = excluded.lines_of_code`
    ).run(repoId, path, language, hash, linesOfCode);

    const row = this.db.prepare(
      'SELECT * FROM files WHERE repo_id = ? AND path = ?'
    ).get(repoId, path) as Record<string, unknown>;

    return this.toRecord(row);
  }

  getFileHashes(repoId: number): Map<string, string> {
    const rows = this.db.prepare(
      'SELECT path, hash FROM files WHERE repo_id = ?'
    ).all(repoId) as { path: string; hash: string }[];
    return new Map(rows.map(r => [r.path, r.hash]));
  }

  listByRepo(repoId: number): FileRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM files WHERE repo_id = ? ORDER BY path'
    ).all(repoId) as Record<string, unknown>[];

    return rows.map((row) => this.toRecord(row));
  }

  deleteByPaths(repoId: number, paths: string[]): void {
    if (paths.length === 0) return;
    const placeholders = paths.map(() => '?').join(', ');
    this.db.prepare(
      `DELETE FROM files WHERE repo_id = ? AND path IN (${placeholders})`
    ).run(repoId, ...paths);
  }

  private toRecord(row: Record<string, unknown>): FileRecord {
    return {
      id: row.id as number,
      repoId: row.repo_id as number,
      path: row.path as string,
      language: row.language as string,
      hash: row.hash as string,
      lastIndexedAt: parseSqliteTimestamp(row.last_indexed_at as string),
      linesOfCode: (row.lines_of_code as number) || null,
    };
  }
}
