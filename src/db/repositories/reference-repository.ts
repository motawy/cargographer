import type Database from 'better-sqlite3';

export interface ReferenceRecord {
  id: number;
  sourceSymbolId: number;
  sourceSymbolName: string | null;
  targetQualifiedName: string;
  targetSymbolId: number | null;
  referenceKind: string;
  lineNumber: number | null;
}

export class ReferenceRepository {
  constructor(private db: Database.Database) {}

  replaceFileReferences(
    fileId: number,
    symbolIdMap: Map<string, number>,
    references: { sourceQualifiedName: string; targetQualifiedName: string; kind: string; line: number }[]
  ): void {
    const doReplace = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM symbol_references
         WHERE source_symbol_id IN (
           SELECT id FROM symbols WHERE file_id = ?
         )`
      ).run(fileId);

      const insertStmt = this.db.prepare(
        `INSERT INTO symbol_references
           (source_symbol_id, target_qualified_name, reference_kind, line_number)
         VALUES (?, ?, ?, ?)`
      );

      for (const ref of references) {
        const sourceId = symbolIdMap.get(ref.sourceQualifiedName);
        if (!sourceId) continue;
        insertStmt.run(sourceId, ref.targetQualifiedName, ref.kind, ref.line);
      }
    });

    doReplace();
  }

  resolveTargets(repoId: number): { resolved: number; unresolved: number } {
    // Build lookup maps for fast resolution in app code.
    // This avoids correlated subqueries that would be O(refs × symbols) in SQLite.
    const symbols = this.db.prepare(
      `SELECT s.id, LOWER(s.qualified_name) AS lqn, s.parent_symbol_id
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ? AND s.qualified_name IS NOT NULL`
    ).all(repoId) as { id: number; lqn: string; parent_symbol_id: number | null }[];

    const exactMap = new Map<string, number>();
    const classMap = new Map<string, number>();
    for (const s of symbols) {
      exactMap.set(s.lqn, s.id);
      if (s.parent_symbol_id === null) {
        classMap.set(s.lqn, s.id);
      }
    }

    const unresolvedRefs = this.db.prepare(
      `SELECT sr.id, sr.target_qualified_name
       FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ? AND sr.target_symbol_id IS NULL`
    ).all(repoId) as { id: number; target_qualified_name: string }[];

    const updateStmt = this.db.prepare(
      'UPDATE symbol_references SET target_symbol_id = ? WHERE id = ?'
    );

    let resolved = 0;
    const batchResolve = this.db.transaction(() => {
      for (const ref of unresolvedRefs) {
        const tqn = ref.target_qualified_name.toLowerCase();

        // Pass 1: exact match
        const exactId = exactMap.get(tqn);
        if (exactId) {
          updateStmt.run(exactId, ref.id);
          resolved++;
          continue;
        }

        // Pass 2: class-level fallback for Class::method patterns
        const colonIdx = tqn.indexOf('::');
        if (colonIdx > 0) {
          const classQn = tqn.substring(0, colonIdx);
          const classId = classMap.get(classQn);
          if (classId) {
            updateStmt.run(classId, ref.id);
            resolved++;
          }
        }
      }
    });
    batchResolve();

    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ? AND sr.target_symbol_id IS NULL`
    ).get(repoId) as { count: number };

    return { resolved, unresolved: row.count };
  }

  findDependents(
    symbolId: number,
    depth: number = 1
  ): Record<string, unknown>[] {
    if (depth <= 1) {
      return this.db.prepare(
        `SELECT sr.*, s.qualified_name AS source_qualified_name,
                f.path AS source_file_path
         FROM symbol_references sr
         JOIN symbols s ON sr.source_symbol_id = s.id
         JOIN files f ON s.file_id = f.id
         WHERE sr.target_symbol_id = ?
         ORDER BY f.path, sr.line_number`
      ).all(symbolId) as Record<string, unknown>[];
    }

    // DISTINCT ON replacement: filter by MIN(depth) per source_symbol_id
    return this.db.prepare(
      `WITH RECURSIVE deps AS (
         SELECT sr.*, 1 AS depth
         FROM symbol_references sr
         WHERE sr.target_symbol_id = ?
         UNION ALL
         SELECT sr.*, d.depth + 1
         FROM symbol_references sr
         JOIN deps d ON sr.target_symbol_id = d.source_symbol_id
         WHERE d.depth < ?
       )
       SELECT deps.*,
              s.qualified_name AS source_qualified_name,
              f.path AS source_file_path
       FROM deps
       JOIN symbols s ON deps.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE deps.depth = (
         SELECT MIN(d2.depth) FROM deps d2
         WHERE d2.source_symbol_id = deps.source_symbol_id
       )
       ORDER BY deps.source_symbol_id, deps.depth`
    ).all(symbolId, depth) as Record<string, unknown>[];
  }

  findDependencies(symbolId: number): ReferenceRecord[] {
    const rows = this.db.prepare(
      `SELECT sr.*, s.name AS source_symbol_name FROM symbol_references sr
       JOIN symbols s ON s.id = sr.source_symbol_id
       WHERE sr.source_symbol_id = ?
          OR sr.source_symbol_id IN (SELECT id FROM symbols WHERE parent_symbol_id = ?)
       ORDER BY sr.line_number`
    ).all(symbolId, symbolId) as Record<string, unknown>[];
    return rows.map(r => this.toRecord(r));
  }

  countByRepo(repoId: number): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ?`
    ).get(repoId) as { count: number };
    return row.count;
  }

  private toRecord(row: Record<string, unknown>): ReferenceRecord {
    return {
      id: row.id as number,
      sourceSymbolId: row.source_symbol_id as number,
      sourceSymbolName: (row.source_symbol_name as string) || null,
      targetQualifiedName: row.target_qualified_name as string,
      targetSymbolId: (row.target_symbol_id as number) || null,
      referenceKind: row.reference_kind as string,
      lineNumber: (row.line_number as number) || null,
    };
  }
}
