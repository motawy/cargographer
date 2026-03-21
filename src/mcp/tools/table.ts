import { normalizeSchemaName } from '../../db/repositories/db-schema-repository.js';
import type { ToolDeps } from '../types.js';

interface TableParams {
  name: string;
}

type TableDeps = Pick<ToolDeps, 'repoId' | 'schemaRepo'>;

export function handleTable(deps: TableDeps, params: TableParams): string {
  const { repoId, schemaRepo } = deps;
  if (!schemaRepo) {
    throw new Error('Schema repository is not available.');
  }

  const matches = schemaRepo.findCurrentTablesByName(repoId, params.name, 10);
  if (matches.length === 0) {
    return `Table not found: "${params.name}".`;
  }

  const normalized = normalizeSchemaName(params.name);
  const exactMatch = matches.find((match) => match.normalizedName === normalized);
  const table = exactMatch ?? matches[0]!;

  if (!exactMatch && matches.length > 1) {
    const lines = [
      `Multiple tables match "${params.name}".`,
      '',
      ...matches.map((match) => `- ${match.name} (${match.filePath ?? 'unknown source'})`),
      '',
      'Retry with the full table name for an exact match.',
    ];
    return lines.join('\n');
  }

  const columns = schemaRepo.findCurrentColumns(table.id);
  const outgoing = schemaRepo.findCurrentOutgoingForeignKeys(table.id);
  const incoming = schemaRepo.findCurrentIncomingForeignKeys(repoId, table.normalizedName);

  const lines: string[] = [];
  lines.push(`## ${table.name}`);
  lines.push('Current schema state from Cartograph\'s canonical schema layer.');
  if (table.filePath && table.lineStart !== null && table.lineEnd !== null) {
    lines.push(`Last table-level change: ${table.filePath}:${table.lineStart}-${table.lineEnd}`);
  } else if (table.filePath) {
    lines.push(`Last table-level change: ${table.filePath}`);
  } else {
    lines.push('Source: imported from a live database.');
  }

  lines.push('');
  lines.push(`### Columns (${columns.length}, current state)`);
  for (const column of columns) {
    const parts = [column.name];
    if (column.dataType) parts.push(column.dataType);
    parts.push(column.isNullable ? 'NULL' : 'NOT NULL');
    if (column.defaultValue) parts.push(`DEFAULT ${column.defaultValue}`);
    lines.push(`- ${parts.join(' ')}`);
  }

  if (outgoing.length > 0) {
    lines.push('');
    lines.push(`### Outbound Foreign Keys (${outgoing.length})`);
    for (const fk of outgoing) {
      const source = fk.sourceColumns.join(', ');
      const target = fk.targetColumns.length > 0
        ? `${fk.targetTable}(${fk.targetColumns.join(', ')})`
        : fk.targetTable;
      lines.push(`- ${source} -> ${target}`);
    }
  }

  if (incoming.length > 0) {
    lines.push('');
    lines.push(`### Incoming Foreign Keys From Tables (${incoming.length})`);
    for (const fk of incoming) {
      const sourceTable = fk.tableName ?? 'unknown_table';
      const source = fk.sourceColumns.length > 0
        ? `${sourceTable}(${fk.sourceColumns.join(', ')})`
        : sourceTable;
      lines.push(`- ${source}`);
    }
  }

  return lines.join('\n');
}
