import type pg from 'pg';

export interface RepoRecord {
  id: number;
  path: string;
  name: string;
  createdAt: Date;
  lastIndexedAt: Date | null;
}

export class RepoRepository {
  constructor(private pool: pg.Pool) {}

  async findOrCreate(path: string, name: string): Promise<RepoRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO repos (path, name)
       VALUES ($1, $2)
       ON CONFLICT (path) DO UPDATE SET name = $2
       RETURNING id, path, name, created_at, last_indexed_at`,
      [path, name]
    );
    return this.toRecord(rows[0]);
  }

  async findByPath(path: string): Promise<RepoRecord | null> {
    const { rows } = await this.pool.query(
      'SELECT id, path, name, created_at, last_indexed_at FROM repos WHERE path = $1',
      [path]
    );
    if (rows.length === 0) return null;
    return this.toRecord(rows[0]);
  }

  async updateLastIndexed(id: number): Promise<void> {
    await this.pool.query(
      'UPDATE repos SET last_indexed_at = NOW() WHERE id = $1',
      [id]
    );
  }

  private toRecord(row: Record<string, unknown>): RepoRecord {
    return {
      id: row.id as number,
      path: row.path as string,
      name: row.name as string,
      createdAt: row.created_at as Date,
      lastIndexedAt: (row.last_indexed_at as Date) || null,
    };
  }
}
