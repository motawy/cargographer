import type Database from 'better-sqlite3';
import { normalizeSchemaName } from './db-schema-repository.js';
import type { DirectTableReferenceKind } from '../../utils/direct-table-reference.js';

export interface ParsedDirectTableReference {
  sourceFileId: number;
  sourceSymbolId: number | null;
  tableName: string;
  normalizedTableName: string;
  referenceKind: DirectTableReferenceKind;
  lineNumber: number;
  preview: string;
}

export interface DirectTableReferenceRecord extends ParsedDirectTableReference {
  id: number;
  filePath: string;
  symbolName: string | null;
  qualifiedName: string | null;
  symbolKind: string | null;
}

export class TableReferenceRepository {
  constructor(private db: Database.Database) {}

  replaceRepoReferences(repoId: number, references: ParsedDirectTableReference[]): void {
    const doReplace = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM direct_table_references
         WHERE source_file_id IN (SELECT id FROM files WHERE repo_id = ?)`
      ).run(repoId);

      const insert = this.db.prepare(
        `INSERT INTO direct_table_references
           (source_file_id, source_symbol_id, table_name, normalized_table_name, reference_kind, line_number, preview)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      for (const reference of references) {
        insert.run(
          reference.sourceFileId,
          reference.sourceSymbolId,
          reference.tableName,
          reference.normalizedTableName,
          reference.referenceKind,
          reference.lineNumber,
          reference.preview
        );
      }
    });

    doReplace();
  }

  findByTable(repoId: number, tableName: string): DirectTableReferenceRecord[] {
    const normalized = normalizeSchemaName(tableName);
    const rows = this.db.prepare(
      `SELECT
         dtr.id,
         dtr.source_file_id,
         dtr.source_symbol_id,
         dtr.table_name,
         dtr.normalized_table_name,
         dtr.reference_kind,
         dtr.line_number,
         dtr.preview,
         f.path AS file_path,
         s.name AS symbol_name,
         s.qualified_name,
         s.kind AS symbol_kind
       FROM direct_table_references dtr
       JOIN files f ON f.id = dtr.source_file_id
       LEFT JOIN symbols s ON s.id = dtr.source_symbol_id
       WHERE f.repo_id = ?
         AND dtr.normalized_table_name = ?
       ORDER BY f.path, dtr.line_number, dtr.id`
    ).all(repoId, normalized) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as number,
      sourceFileId: row.source_file_id as number,
      sourceSymbolId: (row.source_symbol_id as number | null) ?? null,
      tableName: row.table_name as string,
      normalizedTableName: row.normalized_table_name as string,
      referenceKind: row.reference_kind as DirectTableReferenceKind,
      lineNumber: row.line_number as number,
      preview: row.preview as string,
      filePath: row.file_path as string,
      symbolName: (row.symbol_name as string) || null,
      qualifiedName: (row.qualified_name as string) || null,
      symbolKind: (row.symbol_kind as string) || null,
    }));
  }
}
