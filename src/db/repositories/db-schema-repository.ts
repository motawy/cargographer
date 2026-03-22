import type Database from 'better-sqlite3';
import type { MaterializedDbTable, ParsedDbTable } from '../../types.js';

export interface DbTableRecord {
  id: number;
  fileId: number | null;
  name: string;
  normalizedName: string;
  lineStart: number | null;
  lineEnd: number | null;
  filePath: string | null;
}

export interface DbColumnRecord {
  id: number;
  tableId: number;
  name: string;
  normalizedName: string;
  dataType: string | null;
  isNullable: boolean;
  defaultValue: string | null;
  ordinalPosition: number;
  lineNumber: number | null;
}

export interface DbForeignKeyRecord {
  id: number;
  tableId: number;
  constraintName: string | null;
  sourceColumns: string[];
  targetTable: string;
  normalizedTargetTable: string;
  targetColumns: string[];
  lineNumber: number | null;
  tableName?: string;
  filePath?: string | null;
}

export interface DbSchemaCounts {
  tables: number;
  columns: number;
  foreignKeys: number;
  files: number;
}

export interface DbCurrentTableSummaryRecord extends DbTableRecord {
  columnCount: number;
  outboundForeignKeyCount: number;
  incomingForeignKeyCount: number;
}

export class DbSchemaRepository {
  constructor(private db: Database.Database) {}

  replaceFileSchema(fileId: number, tables: ParsedDbTable[]): void {
    const doReplace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM db_tables WHERE file_id = ?').run(fileId);

      const insertTable = this.db.prepare(
        `INSERT INTO db_tables
           (file_id, name, normalized_name, line_start, line_end)
         VALUES (?, ?, ?, ?, ?)`
      );
      const insertColumn = this.db.prepare(
        `INSERT INTO db_columns
           (table_id, name, normalized_name, data_type, is_nullable, default_value, ordinal_position, line_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertForeignKey = this.db.prepare(
        `INSERT INTO db_foreign_keys
           (table_id, constraint_name, source_columns_json, target_table, normalized_target_table, target_columns_json, line_number)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      for (const table of tables) {
        const tableInfo = insertTable.run(
          fileId,
          table.name,
          table.normalizedName,
          table.lineStart,
          table.lineEnd
        );
        const tableId = Number(tableInfo.lastInsertRowid);

        for (const column of table.columns) {
          insertColumn.run(
            tableId,
            column.name,
            column.normalizedName,
            column.dataType,
            column.isNullable ? 1 : 0,
            column.defaultValue,
            column.ordinalPosition,
            column.lineNumber
          );
        }

        for (const foreignKey of table.foreignKeys) {
          insertForeignKey.run(
            tableId,
            foreignKey.constraintName,
            JSON.stringify(foreignKey.sourceColumns),
            foreignKey.targetTable,
            foreignKey.normalizedTargetTable,
            JSON.stringify(foreignKey.targetColumns),
            foreignKey.lineNumber
          );
        }
      }
    });

    doReplace();
  }

  countByRepo(repoId: number): DbSchemaCounts {
    const row = this.db.prepare(
      `SELECT
         COUNT(DISTINCT t.id) AS tables,
         COUNT(DISTINCT c.id) AS columns,
         COUNT(DISTINCT fk.id) AS foreign_keys,
         COUNT(DISTINCT t.file_id) AS files
       FROM db_tables t
       JOIN files f ON t.file_id = f.id
       LEFT JOIN db_columns c ON c.table_id = t.id
       LEFT JOIN db_foreign_keys fk ON fk.table_id = t.id
       WHERE f.repo_id = ?`
    ).get(repoId) as {
      tables: number | null;
      columns: number | null;
      foreign_keys: number | null;
      files: number | null;
    };

    return {
      tables: row.tables ?? 0,
      columns: row.columns ?? 0,
      foreignKeys: row.foreign_keys ?? 0,
      files: row.files ?? 0,
    };
  }

  replaceCurrentSchema(
    repoId: number,
    tables: MaterializedDbTable[],
    fileIdsByPath: Map<string, number>
  ): void {
    const doReplace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM db_current_tables WHERE repo_id = ?').run(repoId);

      const insertTable = this.db.prepare(
        `INSERT INTO db_current_tables
           (repo_id, source_file_id, name, normalized_name, line_start, line_end)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const insertColumn = this.db.prepare(
        `INSERT INTO db_current_columns
           (table_id, source_file_id, name, normalized_name, data_type, is_nullable, default_value, ordinal_position, line_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertForeignKey = this.db.prepare(
        `INSERT INTO db_current_foreign_keys
           (table_id, source_file_id, constraint_name, source_columns_json, target_table, normalized_target_table, target_columns_json, line_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const table of tables) {
        const tableInfo = insertTable.run(
          repoId,
          fileIdForPath(fileIdsByPath, table.sourcePath),
          table.name,
          table.normalizedName,
          table.lineStart,
          table.lineEnd
        );
        const tableId = Number(tableInfo.lastInsertRowid);

        for (const column of table.columns) {
          insertColumn.run(
            tableId,
            fileIdForPath(fileIdsByPath, column.sourcePath),
            column.name,
            column.normalizedName,
            column.dataType,
            column.isNullable ? 1 : 0,
            column.defaultValue,
            column.ordinalPosition,
            column.lineNumber
          );
        }

        for (const foreignKey of table.foreignKeys) {
          insertForeignKey.run(
            tableId,
            fileIdForPath(fileIdsByPath, foreignKey.sourcePath),
            foreignKey.constraintName,
            JSON.stringify(foreignKey.sourceColumns),
            foreignKey.targetTable,
            foreignKey.normalizedTargetTable,
            JSON.stringify(foreignKey.targetColumns),
            foreignKey.lineNumber
          );
        }
      }
    });

    doReplace();
  }

  replaceCurrentSchemaFromImport(repoId: number, tables: MaterializedDbTable[]): void {
    this.replaceCurrentSchema(repoId, tables, new Map());
  }

  countCurrentByRepo(repoId: number): DbSchemaCounts {
    const row = this.db.prepare(
      `SELECT
         COUNT(DISTINCT t.id) AS tables,
         COUNT(DISTINCT c.id) AS columns,
         COUNT(DISTINCT fk.id) AS foreign_keys,
         COUNT(DISTINCT t.source_file_id) AS files
       FROM db_current_tables t
       LEFT JOIN db_current_columns c ON c.table_id = t.id
       LEFT JOIN db_current_foreign_keys fk ON fk.table_id = t.id
       WHERE t.repo_id = ?`
    ).get(repoId) as {
      tables: number | null;
      columns: number | null;
      foreign_keys: number | null;
      files: number | null;
    };

    return {
      tables: row.tables ?? 0,
      columns: row.columns ?? 0,
      foreignKeys: row.foreign_keys ?? 0,
      files: row.files ?? 0,
    };
  }

  findTablesByName(repoId: number, name: string, limit: number = 10): DbTableRecord[] {
    const normalized = normalizeSchemaName(name);
    const rows = this.db.prepare(
      `SELECT t.*, f.path AS file_path
       FROM db_tables t
       JOIN files f ON t.file_id = f.id
       WHERE f.repo_id = ?
         AND (
           t.normalized_name = ?
           OR t.normalized_name LIKE ?
         )
       ORDER BY
         CASE WHEN t.normalized_name = ? THEN 0 ELSE 1 END,
         t.normalized_name
       LIMIT ?`
    ).all(repoId, normalized, `%.${normalized}`, normalized, limit) as Record<string, unknown>[];

    return rows.map((row) => this.toTableRecord(row));
  }

  findCurrentTablesByName(repoId: number, name: string, limit: number = 10): DbTableRecord[] {
    const normalized = normalizeSchemaName(name);
    const rows = this.db.prepare(
      `SELECT
         t.id,
         t.source_file_id AS file_id,
         t.name,
         t.normalized_name,
         t.line_start,
         t.line_end,
         f.path AS file_path
       FROM db_current_tables t
       LEFT JOIN files f ON t.source_file_id = f.id
       WHERE t.repo_id = ?
         AND (
           t.normalized_name = ?
           OR t.normalized_name LIKE ?
         )
       ORDER BY
         CASE WHEN t.normalized_name = ? THEN 0 ELSE 1 END,
         t.normalized_name
       LIMIT ?`
    ).all(repoId, normalized, `%.${normalized}`, normalized, limit) as Record<string, unknown>[];

    return rows.map((row) => this.toTableRecord(row));
  }

  listCurrentTables(repoId: number): DbTableRecord[] {
    const rows = this.db.prepare(
      `SELECT
         t.id,
         t.source_file_id AS file_id,
         t.name,
         t.normalized_name,
         t.line_start,
         t.line_end,
         f.path AS file_path
       FROM db_current_tables t
       LEFT JOIN files f ON t.source_file_id = f.id
       WHERE t.repo_id = ?
       ORDER BY t.normalized_name`
    ).all(repoId) as Record<string, unknown>[];

    return rows.map((row) => this.toTableRecord(row));
  }

  listCurrentTableSummaries(
    repoId: number,
    options: { query?: string; limit?: number } = {}
  ): DbCurrentTableSummaryRecord[] {
    const limit = options.limit ?? 50;
    const normalized = options.query ? normalizeSchemaName(options.query) : null;
    const queryFilter = normalized ? `AND (
      t.normalized_name = @normalized
      OR t.normalized_name LIKE @contains
      OR t.normalized_name LIKE @suffix
    )` : '';

    const rows = this.db.prepare(
      `SELECT
         t.id,
         t.source_file_id AS file_id,
         t.name,
         t.normalized_name,
         t.line_start,
         t.line_end,
         f.path AS file_path,
         (
           SELECT COUNT(*)
           FROM db_current_columns c
           WHERE c.table_id = t.id
         ) AS column_count,
         (
           SELECT COUNT(*)
           FROM db_current_foreign_keys fk
           WHERE fk.table_id = t.id
         ) AS outbound_fk_count,
         (
           SELECT COUNT(*)
           FROM db_current_foreign_keys fk
           JOIN db_current_tables src ON src.id = fk.table_id
           WHERE src.repo_id = t.repo_id
             AND fk.normalized_target_table = t.normalized_name
         ) AS incoming_fk_count
       FROM db_current_tables t
       LEFT JOIN files f ON t.source_file_id = f.id
       WHERE t.repo_id = @repoId
       ${queryFilter}
       ORDER BY
         CASE WHEN @normalized IS NOT NULL AND t.normalized_name = @normalized THEN 0 ELSE 1 END,
         t.normalized_name
       LIMIT @limit`
    ).all({
      repoId,
      normalized,
      contains: normalized ? `%${normalized}%` : null,
      suffix: normalized ? `%.${normalized}` : null,
      limit,
    }) as Record<string, unknown>[];

    return rows.map((row) => this.toCurrentTableSummaryRecord(row));
  }

  findCurrentTableSummary(repoId: number, normalizedName: string): DbCurrentTableSummaryRecord | null {
    const rows = this.listCurrentTableSummaries(repoId, {
      query: normalizedName,
      limit: 10,
    });

    return rows.find((row) => row.normalizedName === normalizedName) ?? null;
  }

  findColumns(tableId: number): DbColumnRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM db_columns
       WHERE table_id = ?
       ORDER BY ordinal_position`
    ).all(tableId) as Record<string, unknown>[];

    return rows.map((row) => this.toColumnRecord(row));
  }

  findOutgoingForeignKeys(tableId: number): DbForeignKeyRecord[] {
    const rows = this.db.prepare(
      `SELECT fk.*, t.name AS table_name, f.path AS file_path
       FROM db_foreign_keys fk
       JOIN db_tables t ON fk.table_id = t.id
       JOIN files f ON t.file_id = f.id
       WHERE fk.table_id = ?
       ORDER BY fk.line_number, fk.id`
    ).all(tableId) as Record<string, unknown>[];

    return rows.map((row) => this.toForeignKeyRecord(row));
  }

  findIncomingForeignKeys(repoId: number, normalizedTargetTable: string): DbForeignKeyRecord[] {
    const rows = this.db.prepare(
      `SELECT fk.*, t.name AS table_name, f.path AS file_path
       FROM db_foreign_keys fk
       JOIN db_tables t ON fk.table_id = t.id
       JOIN files f ON t.file_id = f.id
       WHERE f.repo_id = ?
         AND fk.normalized_target_table = ?
       ORDER BY t.name, fk.line_number, fk.id`
    ).all(repoId, normalizedTargetTable) as Record<string, unknown>[];

    return rows.map((row) => this.toForeignKeyRecord(row));
  }

  findCurrentColumns(tableId: number): DbColumnRecord[] {
    const rows = this.db.prepare(
      `SELECT
         id,
         table_id,
         name,
         normalized_name,
         data_type,
         is_nullable,
         default_value,
         ordinal_position,
         line_number
       FROM db_current_columns
       WHERE table_id = ?
       ORDER BY ordinal_position`
    ).all(tableId) as Record<string, unknown>[];

    return rows.map((row) => this.toColumnRecord(row));
  }

  findCurrentOutgoingForeignKeys(tableId: number): DbForeignKeyRecord[] {
    const rows = this.db.prepare(
      `SELECT
         fk.id,
         fk.table_id,
         fk.constraint_name,
         fk.source_columns_json,
         fk.target_table,
         fk.normalized_target_table,
         fk.target_columns_json,
         fk.line_number,
         t.name AS table_name,
         f.path AS file_path
       FROM db_current_foreign_keys fk
       JOIN db_current_tables t ON fk.table_id = t.id
       LEFT JOIN files f ON fk.source_file_id = f.id
       WHERE fk.table_id = ?
       ORDER BY fk.line_number, fk.id`
    ).all(tableId) as Record<string, unknown>[];

    return rows.map((row) => this.toForeignKeyRecord(row));
  }

  findCurrentIncomingForeignKeys(repoId: number, normalizedTargetTable: string): DbForeignKeyRecord[] {
    const rows = this.db.prepare(
      `SELECT
         fk.id,
         fk.table_id,
         fk.constraint_name,
         fk.source_columns_json,
         fk.target_table,
         fk.normalized_target_table,
         fk.target_columns_json,
         fk.line_number,
         t.name AS table_name,
         f.path AS file_path
       FROM db_current_foreign_keys fk
       JOIN db_current_tables t ON fk.table_id = t.id
       LEFT JOIN files f ON fk.source_file_id = f.id
       WHERE t.repo_id = ?
         AND fk.normalized_target_table = ?
       ORDER BY t.name, fk.line_number, fk.id`
    ).all(repoId, normalizedTargetTable) as Record<string, unknown>[];

    return rows.map((row) => this.toForeignKeyRecord(row));
  }

  private toTableRecord(row: Record<string, unknown>): DbTableRecord {
    return {
      id: row.id as number,
      fileId: (row.file_id as number | null) ?? null,
      name: row.name as string,
      normalizedName: row.normalized_name as string,
      lineStart: (row.line_start as number | null) ?? null,
      lineEnd: (row.line_end as number | null) ?? null,
      filePath: (row.file_path as string) || null,
    };
  }

  private toColumnRecord(row: Record<string, unknown>): DbColumnRecord {
    return {
      id: row.id as number,
      tableId: row.table_id as number,
      name: row.name as string,
      normalizedName: row.normalized_name as string,
      dataType: (row.data_type as string) || null,
      isNullable: Number(row.is_nullable) !== 0,
      defaultValue: (row.default_value as string) || null,
      ordinalPosition: row.ordinal_position as number,
      lineNumber: (row.line_number as number) || null,
    };
  }

  private toForeignKeyRecord(row: Record<string, unknown>): DbForeignKeyRecord {
    return {
      id: row.id as number,
      tableId: row.table_id as number,
      constraintName: (row.constraint_name as string) || null,
      sourceColumns: JSON.parse(row.source_columns_json as string) as string[],
      targetTable: row.target_table as string,
      normalizedTargetTable: row.normalized_target_table as string,
      targetColumns: JSON.parse(row.target_columns_json as string) as string[],
      lineNumber: (row.line_number as number) || null,
      tableName: (row.table_name as string) || undefined,
      filePath: (row.file_path as string) || null,
    };
  }

  private toCurrentTableSummaryRecord(row: Record<string, unknown>): DbCurrentTableSummaryRecord {
    const base = this.toTableRecord(row);
    return {
      ...base,
      columnCount: Number(row.column_count) || 0,
      outboundForeignKeyCount: Number(row.outbound_fk_count) || 0,
      incomingForeignKeyCount: Number(row.incoming_fk_count) || 0,
    };
  }
}

export function normalizeSchemaName(name: string): string {
  return name
    .trim()
    .replace(/^[`"\[]+|[`"\]]+$/g, '')
    .split('.')
    .map((part) => part.replace(/^[`"\[]+|[`"\]]+$/g, '').trim().toLowerCase())
    .filter(Boolean)
    .join('.');
}

function fileIdForPath(fileIdsByPath: Map<string, number>, path: string | null): number | null {
  if (!path) return null;
  return fileIdsByPath.get(path) ?? null;
}
