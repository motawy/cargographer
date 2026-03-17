import type pg from 'pg';
import type { ParsedSymbol } from '../../types.js';

export interface SymbolRecord {
  id: number;
  fileId: number;
  kind: string;
  name: string;
  qualifiedName: string | null;
  visibility: string | null;
  parentSymbolId: number | null;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  returnType: string | null;
  docblock: string | null;
  metadata: Record<string, unknown>;
}

export class SymbolRepository {
  constructor(private pool: pg.Pool) {}

  async replaceFileSymbols(
    fileId: number,
    symbols: ParsedSymbol[]
  ): Promise<Map<string, number>> {
    const idMap = new Map<string, number>();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Delete existing symbols for this file (CASCADE handles references)
      await client.query('DELETE FROM symbols WHERE file_id = $1', [fileId]);

      // Insert new symbols
      for (const symbol of symbols) {
        await this.insertSymbol(client, fileId, symbol, null, idMap);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return idMap;
  }

  private async insertSymbol(
    client: pg.PoolClient,
    fileId: number,
    symbol: ParsedSymbol,
    parentId: number | null,
    idMap: Map<string, number>
  ): Promise<number> {
    const { rows } = await client.query(
      `INSERT INTO symbols
         (file_id, kind, name, qualified_name, visibility, parent_symbol_id,
          line_start, line_end, signature, return_type, docblock, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        fileId,
        symbol.kind,
        symbol.name,
        symbol.qualifiedName,
        symbol.visibility,
        parentId,
        symbol.lineStart,
        symbol.lineEnd,
        symbol.signature,
        symbol.returnType,
        symbol.docblock,
        JSON.stringify(symbol.metadata),
      ]
    );

    const symbolId = rows[0].id as number;
    if (symbol.qualifiedName) {
      idMap.set(symbol.qualifiedName, symbolId);
    }

    // Insert children (methods, properties, constants of a class)
    for (const child of symbol.children) {
      await this.insertSymbol(client, fileId, child, symbolId, idMap);
    }

    return symbolId;
  }

  async findByFile(fileId: number): Promise<SymbolRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM symbols WHERE file_id = $1 ORDER BY line_start',
      [fileId]
    );
    return rows.map((r: Record<string, unknown>) => this.toRecord(r));
  }

  async countByRepo(repoId: number): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = $1`,
      [repoId]
    );
    return rows[0].count as number;
  }

  async findByQualifiedName(repoId: number, qualifiedName: string): Promise<SymbolRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT s.* FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = $1 AND s.qualified_name = $2`,
      [repoId, qualifiedName]
    );
    if (rows.length === 0) return null;
    return this.toRecord(rows[0]);
  }

  async findById(id: number): Promise<SymbolRecord | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM symbols WHERE id = $1',
      [id]
    );
    if (rows.length === 0) return null;
    return this.toRecord(rows[0]);
  }

  async search(
    repoId: number,
    query: string,
    kind?: string,
    limit: number = 20,
    path?: string
  ): Promise<(SymbolRecord & { filePath: string })[]> {
    const params: (string | number)[] = [repoId, query];
    let sql = `SELECT s.*, f.path AS file_path FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = $1 AND s.qualified_name ILIKE $2`;
    if (kind) {
      params.push(kind);
      sql += ` AND s.kind = $${params.length}`;
    }
    if (path) {
      params.push(`${path}%`);
      sql += ` AND f.path LIKE $${params.length}`;
    }
    params.push(limit);
    sql += ` ORDER BY s.qualified_name LIMIT $${params.length}`;

    const { rows } = await this.pool.query(sql, params);
    return rows.map((r: Record<string, unknown>) => ({
      ...this.toRecord(r),
      filePath: r.file_path as string,
    }));
  }

  async findByFilePath(repoId: number, filePath: string): Promise<SymbolRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT s.* FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = $1 AND f.path = $2
       ORDER BY s.line_start`,
      [repoId, filePath]
    );
    return rows.map((r: Record<string, unknown>) => this.toRecord(r));
  }

  async findChildren(parentSymbolId: number): Promise<SymbolRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM symbols WHERE parent_symbol_id = $1 ORDER BY line_start',
      [parentSymbolId]
    );
    return rows.map((r: Record<string, unknown>) => this.toRecord(r));
  }

  private toRecord(row: Record<string, unknown>): SymbolRecord {
    return {
      id: row.id as number,
      fileId: row.file_id as number,
      kind: row.kind as string,
      name: row.name as string,
      qualifiedName: (row.qualified_name as string) || null,
      visibility: (row.visibility as string) || null,
      parentSymbolId: (row.parent_symbol_id as number) || null,
      lineStart: row.line_start as number,
      lineEnd: row.line_end as number,
      signature: (row.signature as string) || null,
      returnType: (row.return_type as string) || null,
      docblock: (row.docblock as string) || null,
      metadata: (row.metadata as Record<string, unknown>) || {},
    };
  }
}
