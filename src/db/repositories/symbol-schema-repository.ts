import type Database from 'better-sqlite3';
import { normalizeSchemaName } from './db-schema-repository.js';

export interface SymbolTableLinkRecord {
  id: number;
  sourceSymbolId: number;
  symbolName: string;
  qualifiedName: string | null;
  symbolKind: string;
  filePath: string;
  tableName: string;
  normalizedTableName: string;
  linkKind: string;
}

export interface SymbolColumnLinkRecord {
  id: number;
  sourceSymbolId: number;
  symbolName: string;
  qualifiedName: string | null;
  symbolKind: string;
  filePath: string;
  tableName: string;
  normalizedTableName: string;
  columnName: string;
  normalizedColumnName: string;
  referencedColumnName: string | null;
  normalizedReferencedColumnName: string | null;
  linkKind: string;
}

export interface ParsedSymbolTableLink {
  sourceQualifiedName: string;
  tableName: string;
  normalizedTableName: string;
  linkKind: 'entity_table';
}

export interface ParsedSymbolColumnLink {
  sourceQualifiedName: string;
  tableName: string;
  normalizedTableName: string;
  columnName: string;
  normalizedColumnName: string;
  referencedColumnName?: string | null;
  normalizedReferencedColumnName?: string | null;
  linkKind: 'entity_column' | 'entity_join_column';
}

export class SymbolSchemaRepository {
  constructor(private db: Database.Database) {}

  replaceFileLinks(
    fileId: number,
    symbolIdMap: Map<string, number>,
    tableLinks: ParsedSymbolTableLink[],
    columnLinks: ParsedSymbolColumnLink[]
  ): void {
    const doReplace = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM symbol_table_links
         WHERE source_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)`
      ).run(fileId);

      this.db.prepare(
        `DELETE FROM symbol_column_links
         WHERE source_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)`
      ).run(fileId);

      const insertTableLink = this.db.prepare(
        `INSERT OR IGNORE INTO symbol_table_links
           (source_symbol_id, table_name, normalized_table_name, link_kind)
         VALUES (?, ?, ?, ?)`
      );
      const insertColumnLink = this.db.prepare(
        `INSERT OR IGNORE INTO symbol_column_links
           (source_symbol_id, table_name, normalized_table_name, column_name, normalized_column_name,
            referenced_column_name, normalized_referenced_column_name, link_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const link of tableLinks) {
        const sourceSymbolId = symbolIdMap.get(link.sourceQualifiedName);
        if (!sourceSymbolId) continue;
        insertTableLink.run(
          sourceSymbolId,
          link.tableName,
          link.normalizedTableName,
          link.linkKind
        );
      }

      for (const link of columnLinks) {
        const sourceSymbolId = symbolIdMap.get(link.sourceQualifiedName);
        if (!sourceSymbolId) continue;
        insertColumnLink.run(
          sourceSymbolId,
          link.tableName,
          link.normalizedTableName,
          link.columnName,
          link.normalizedColumnName,
          link.referencedColumnName ?? null,
          link.normalizedReferencedColumnName ?? null,
          link.linkKind
        );
      }
    });

    doReplace();
  }

  findEntitySymbolsByTable(repoId: number, tableName: string): SymbolTableLinkRecord[] {
    const normalized = normalizeSchemaName(tableName);
    const rows = this.db.prepare(
      `SELECT
         stl.id,
         stl.source_symbol_id,
         s.name AS symbol_name,
         s.qualified_name,
         s.kind AS symbol_kind,
         f.path AS file_path,
         stl.table_name,
         stl.normalized_table_name,
         stl.link_kind
       FROM symbol_table_links stl
       JOIN symbols s ON s.id = stl.source_symbol_id
       JOIN files f ON f.id = s.file_id
       WHERE f.repo_id = ?
         AND stl.normalized_table_name = ?
       ORDER BY s.qualified_name`
    ).all(repoId, normalized) as Record<string, unknown>[];

    return rows.map((row) => this.toTableLinkRecord(row));
  }

  findColumnLinksByTable(repoId: number, tableName: string): SymbolColumnLinkRecord[] {
    const normalized = normalizeSchemaName(tableName);
    const rows = this.db.prepare(
      `SELECT
         scl.id,
         scl.source_symbol_id,
         s.name AS symbol_name,
         s.qualified_name,
         s.kind AS symbol_kind,
         f.path AS file_path,
         scl.table_name,
         scl.normalized_table_name,
         scl.column_name,
         scl.normalized_column_name,
         scl.referenced_column_name,
         scl.normalized_referenced_column_name,
         scl.link_kind
       FROM symbol_column_links scl
       JOIN symbols s ON s.id = scl.source_symbol_id
       JOIN files f ON f.id = s.file_id
       WHERE f.repo_id = ?
         AND scl.normalized_table_name = ?
       ORDER BY s.qualified_name`
    ).all(repoId, normalized) as Record<string, unknown>[];

    return rows.map((row) => this.toColumnLinkRecord(row));
  }

  findTablesBySymbol(repoId: number, symbolId: number): SymbolTableLinkRecord[] {
    const rows = this.db.prepare(
      `SELECT
         stl.id,
         stl.source_symbol_id,
         s.name AS symbol_name,
         s.qualified_name,
         s.kind AS symbol_kind,
         f.path AS file_path,
         stl.table_name,
         stl.normalized_table_name,
         stl.link_kind
       FROM symbol_table_links stl
       JOIN symbols s ON s.id = stl.source_symbol_id
       JOIN files f ON f.id = s.file_id
       WHERE f.repo_id = ?
         AND stl.source_symbol_id = ?
       ORDER BY stl.normalized_table_name`
    ).all(repoId, symbolId) as Record<string, unknown>[];

    return rows.map((row) => this.toTableLinkRecord(row));
  }

  private toTableLinkRecord(row: Record<string, unknown>): SymbolTableLinkRecord {
    return {
      id: row.id as number,
      sourceSymbolId: row.source_symbol_id as number,
      symbolName: row.symbol_name as string,
      qualifiedName: (row.qualified_name as string) || null,
      symbolKind: row.symbol_kind as string,
      filePath: row.file_path as string,
      tableName: row.table_name as string,
      normalizedTableName: row.normalized_table_name as string,
      linkKind: row.link_kind as string,
    };
  }

  private toColumnLinkRecord(row: Record<string, unknown>): SymbolColumnLinkRecord {
    return {
      id: row.id as number,
      sourceSymbolId: row.source_symbol_id as number,
      symbolName: row.symbol_name as string,
      qualifiedName: (row.qualified_name as string) || null,
      symbolKind: row.symbol_kind as string,
      filePath: row.file_path as string,
      tableName: row.table_name as string,
      normalizedTableName: row.normalized_table_name as string,
      columnName: row.column_name as string,
      normalizedColumnName: row.normalized_column_name as string,
      referencedColumnName: (row.referenced_column_name as string) || null,
      normalizedReferencedColumnName: (row.normalized_referenced_column_name as string) || null,
      linkKind: row.link_kind as string,
    };
  }
}
