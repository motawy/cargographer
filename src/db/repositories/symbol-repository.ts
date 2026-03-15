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
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Delete existing symbols for this file (CASCADE handles references)
      await client.query('DELETE FROM symbols WHERE file_id = $1', [fileId]);

      // Insert new symbols
      for (const symbol of symbols) {
        await this.insertSymbol(client, fileId, symbol, null);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async insertSymbol(
    client: pg.PoolClient,
    fileId: number,
    symbol: ParsedSymbol,
    parentId: number | null
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

    // Insert children (methods, properties, constants of a class)
    for (const child of symbol.children) {
      await this.insertSymbol(client, fileId, child, symbolId);
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
