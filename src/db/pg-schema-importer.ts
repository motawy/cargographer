import { Client } from 'pg';
import { normalizeSchemaName } from './repositories/db-schema-repository.js';
import type { MaterializedDbTable } from '../types.js';

export interface PgConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

interface PgTableRow {
  table_name: string;
}

interface PgColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  ordinal_position: number;
}

interface PgForeignKeyRow {
  constraint_name: string;
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
}

export async function importPgSchema(config: PgConnectionConfig): Promise<MaterializedDbTable[]> {
  const client = new Client(config);

  await client.connect();
  try {
    const tablesResult = await client.query<PgTableRow>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );

    const columnsResult = await client.query<PgColumnRow>(
      `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable,
              c.column_default, c.ordinal_position
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON c.table_schema = t.table_schema
        AND c.table_name = t.table_name
       WHERE t.table_schema = 'public'
         AND t.table_type = 'BASE TABLE'
       ORDER BY c.table_name, c.ordinal_position`
    );

    const foreignKeysResult = await client.query<PgForeignKeyRow>(
      `SELECT
         tc.constraint_name,
         tc.table_name AS source_table,
         kcu.column_name AS source_column,
         ccu.table_name AS target_table,
         ccu.column_name AS target_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = 'public'
       ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position`
    );

    return buildImportedTables(
      tablesResult.rows,
      columnsResult.rows,
      foreignKeysResult.rows
    );
  } finally {
    await client.end();
  }
}

export function buildImportedTables(
  tableRows: PgTableRow[],
  columnRows: PgColumnRow[],
  foreignKeyRows: PgForeignKeyRow[]
): MaterializedDbTable[] {
  const tables = new Map<string, MaterializedDbTable>();

  for (const row of tableRows) {
    const normalizedName = normalizeSchemaName(row.table_name);
    tables.set(normalizedName, {
      name: row.table_name,
      normalizedName,
      sourcePath: null,
      lineStart: null,
      lineEnd: null,
      columns: [],
      foreignKeys: [],
    });
  }

  for (const row of columnRows) {
    const table = tables.get(normalizeSchemaName(row.table_name));
    if (!table) continue;

    table.columns.push({
      name: row.column_name,
      normalizedName: normalizeSchemaName(row.column_name),
      dataType: row.data_type,
      isNullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      ordinalPosition: row.ordinal_position,
      sourcePath: null,
      lineNumber: null,
    });
  }

  const fkMap = new Map<string, MaterializedDbTable['foreignKeys'][number]>();
  const fkPairs = new Map<string, Set<string>>();
  for (const row of foreignKeyRows) {
    const table = tables.get(normalizeSchemaName(row.source_table));
    if (!table) continue;

    const key = `${normalizeSchemaName(row.source_table)}::${normalizeSchemaName(row.constraint_name)}`;
    const existing = fkMap.get(key);
    const pairKey = `${normalizeSchemaName(row.source_column)}->${normalizeSchemaName(row.target_column)}`;
    if (existing) {
      const seenPairs = fkPairs.get(key)!;
      if (seenPairs.has(pairKey)) {
        continue;
      }
      seenPairs.add(pairKey);
      existing.sourceColumns.push(row.source_column);
      existing.targetColumns.push(row.target_column);
      continue;
    }

    const foreignKey = {
      constraintName: row.constraint_name,
      sourceColumns: [row.source_column],
      targetTable: row.target_table,
      normalizedTargetTable: normalizeSchemaName(row.target_table),
      targetColumns: [row.target_column],
      sourcePath: null,
      lineNumber: null,
    };
    fkMap.set(key, foreignKey);
    fkPairs.set(key, new Set([pairKey]));
    table.foreignKeys.push(foreignKey);
  }

  return [...tables.values()].sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));
}
