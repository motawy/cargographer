import type pg from 'pg';

export interface ReferenceRecord {
  id: number;
  sourceSymbolId: number;
  targetQualifiedName: string;
  targetSymbolId: number | null;
  referenceKind: string;
  lineNumber: number | null;
}

export class ReferenceRepository {
  constructor(private pool: pg.Pool) {}

  async replaceFileReferences(
    fileId: number,
    symbolIdMap: Map<string, number>,
    references: { sourceQualifiedName: string; targetQualifiedName: string; kind: string; line: number }[]
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Delete existing references for symbols in this file
      await client.query(
        `DELETE FROM symbol_references
         WHERE source_symbol_id IN (
           SELECT id FROM symbols WHERE file_id = $1
         )`,
        [fileId]
      );

      // Insert new references
      for (const ref of references) {
        const sourceId = symbolIdMap.get(ref.sourceQualifiedName);
        if (!sourceId) continue;

        await client.query(
          `INSERT INTO symbol_references
             (source_symbol_id, target_qualified_name, reference_kind, line_number)
           VALUES ($1, $2, $3, $4)`,
          [sourceId, ref.targetQualifiedName, ref.kind, ref.line]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async resolveTargets(repoId: number): Promise<{ resolved: number; unresolved: number }> {
    const { rowCount: resolved } = await this.pool.query(
      `UPDATE symbol_references sr
       SET target_symbol_id = s.id
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = $1
         AND sr.target_qualified_name = LOWER(s.qualified_name)
         AND sr.target_symbol_id IS NULL
         AND sr.source_symbol_id IN (
           SELECT id FROM symbols WHERE file_id IN (
             SELECT id FROM files WHERE repo_id = $1
           )
         )`,
      [repoId]
    );

    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = $1 AND sr.target_symbol_id IS NULL`,
      [repoId]
    );

    return {
      resolved: resolved || 0,
      unresolved: rows[0].count as number,
    };
  }

  async findDependents(
    symbolId: number,
    depth: number = 1
  ): Promise<Record<string, unknown>[]> {
    if (depth <= 1) {
      const { rows } = await this.pool.query(
        `SELECT sr.*, s.qualified_name AS source_qualified_name,
                f.path AS source_file_path
         FROM symbol_references sr
         JOIN symbols s ON sr.source_symbol_id = s.id
         JOIN files f ON s.file_id = f.id
         WHERE sr.target_symbol_id = $1
         ORDER BY f.path, sr.line_number`,
        [symbolId]
      );
      return rows;
    }

    const { rows } = await this.pool.query(
      `WITH RECURSIVE deps AS (
         SELECT sr.*, 1 AS depth
         FROM symbol_references sr
         WHERE sr.target_symbol_id = $1
         UNION ALL
         SELECT sr.*, d.depth + 1
         FROM symbol_references sr
         JOIN deps d ON sr.target_symbol_id = d.source_symbol_id
         WHERE d.depth < $2
       )
       SELECT DISTINCT ON (deps.source_symbol_id) deps.*,
              s.qualified_name AS source_qualified_name,
              f.path AS source_file_path
       FROM deps
       JOIN symbols s ON deps.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       ORDER BY deps.source_symbol_id, deps.depth`,
      [symbolId, depth]
    );
    return rows;
  }

  async findDependencies(symbolId: number): Promise<ReferenceRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT sr.* FROM symbol_references sr
       WHERE sr.source_symbol_id = $1
       ORDER BY sr.line_number`,
      [symbolId]
    );
    return rows.map((r: Record<string, unknown>) => this.toRecord(r));
  }

  async countByRepo(repoId: number): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = $1`,
      [repoId]
    );
    return rows[0].count as number;
  }

  private toRecord(row: Record<string, unknown>): ReferenceRecord {
    return {
      id: row.id as number,
      sourceSymbolId: row.source_symbol_id as number,
      targetQualifiedName: row.target_qualified_name as string,
      targetSymbolId: (row.target_symbol_id as number) || null,
      referenceKind: row.reference_kind as string,
      lineNumber: (row.line_number as number) || null,
    };
  }
}
