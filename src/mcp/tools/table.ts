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

  const matches = schemaRepo.findTablesByName(repoId, params.name, 10);
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
      ...matches.map((match) => `- ${match.name} (${match.filePath ?? 'unknown file'})`),
      '',
      'Retry with the full table name for an exact match.',
    ];
    return lines.join('\n');
  }

  const columns = schemaRepo.findColumns(table.id);
  const outgoing = schemaRepo.findOutgoingForeignKeys(table.id);
  const incoming = schemaRepo.findIncomingForeignKeys(repoId, table.normalizedName);

  const lines: string[] = [];
  lines.push(`## ${table.name}`);
  if (table.filePath) {
    lines.push(`File: ${table.filePath}:${table.lineStart}-${table.lineEnd}`);
  }

  lines.push('');
  lines.push(`### Columns (${columns.length})`);
  for (const column of columns) {
    const parts = [column.name];
    if (column.dataType) parts.push(column.dataType);
    parts.push(column.isNullable ? 'NULL' : 'NOT NULL');
    if (column.defaultValue) parts.push(`DEFAULT ${column.defaultValue}`);
    lines.push(`- ${parts.join(' ')}`);
  }

  if (outgoing.length > 0) {
    lines.push('');
    lines.push(`### Foreign Keys Out (${outgoing.length})`);
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
    lines.push(`### Referenced By (${incoming.length})`);
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
