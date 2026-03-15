import type pg from 'pg';

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
  constructor(private pool: pg.Pool) {}

  async upsert(
    repoId: number,
    path: string,
    language: string,
    hash: string,
    linesOfCode: number
  ): Promise<FileRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO files (repo_id, path, language, hash, last_indexed_at, lines_of_code)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (repo_id, path)
       DO UPDATE SET hash = $4, last_indexed_at = NOW(), lines_of_code = $5
       RETURNING *`,
      [repoId, path, language, hash, linesOfCode]
    );
    return this.toRecord(rows[0]);
  }

  async getFileHashes(repoId: number): Promise<Map<string, string>> {
    const { rows } = await this.pool.query(
      'SELECT path, hash FROM files WHERE repo_id = $1',
      [repoId]
    );
    return new Map(
      rows.map((r: { path: string; hash: string }) => [r.path, r.hash])
    );
  }

  async deleteByPaths(repoId: number, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.pool.query(
      'DELETE FROM files WHERE repo_id = $1 AND path = ANY($2)',
      [repoId, paths]
    );
  }

  private toRecord(row: Record<string, unknown>): FileRecord {
    return {
      id: row.id as number,
      repoId: row.repo_id as number,
      path: row.path as string,
      language: row.language as string,
      hash: row.hash as string,
      lastIndexedAt: row.last_indexed_at as Date,
      linesOfCode: (row.lines_of_code as number) || null,
    };
  }
}
