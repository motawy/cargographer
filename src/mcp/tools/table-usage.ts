import { normalizeSchemaName } from '../../db/repositories/db-schema-repository.js';
import type { SymbolColumnLinkRecord, SymbolTableLinkRecord } from '../../db/repositories/symbol-schema-repository.js';
import type { ToolDeps } from '../types.js';

interface TableUsageParams {
  name: string;
  depth?: number;
  limit?: number;
}

type TableUsageDeps = Pick<ToolDeps, 'repoId' | 'schemaRepo' | 'symbolSchemaRepo' | 'refRepo'>;

interface DependentUsageRow {
  source_symbol_id?: number;
  source_qualified_name?: string;
  source_file_path?: string;
  reference_kind?: string;
  line_number?: number;
  depth?: number;
}

export function handleTableUsage(deps: TableUsageDeps, params: TableUsageParams): string {
  const { repoId, schemaRepo, symbolSchemaRepo, refRepo } = deps;
  if (!schemaRepo || !symbolSchemaRepo) {
    throw new Error('Schema repositories are not available.');
  }

  const matches = schemaRepo.findCurrentTablesByName(repoId, params.name, 10);
  if (matches.length === 0) {
    return `Table not found: "${params.name}".`;
  }

  const normalized = normalizeSchemaName(params.name);
  const exactMatch = matches.find((match) => match.normalizedName === normalized);
  const table = exactMatch ?? matches[0]!;

  if (!exactMatch && matches.length > 1) {
    return [
      `Multiple tables match "${params.name}".`,
      '',
      ...matches.map((match) => `- ${match.name}`),
      '',
      'Retry with the full table name for an exact match.',
    ].join('\n');
  }

  const depth = Math.max(1, Math.min(params.depth ?? 3, 5));
  const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
  const entityLinks = symbolSchemaRepo.findEntitySymbolsByTable(repoId, table.normalizedName);
  const columnLinks = symbolSchemaRepo.findColumnLinksByTable(repoId, table.normalizedName);

  const lines: string[] = [];
  lines.push(`## Table Usage: ${table.name}`);
  lines.push(`- Depth: ${depth}`);
  lines.push(`- Mapped entities: ${entityLinks.length}`);
  lines.push('');

  if (entityLinks.length === 0) {
    lines.push('No Doctrine-style entity mappings were found for this table.');
    lines.push('This usually means one of: no entity exists, the mapping is implicit, or the code uses a non-Doctrine pattern.');
    return lines.join('\n');
  }

  lines.push(`### Entities`);
  for (const entity of entityLinks) {
    lines.push(`- ${entity.qualifiedName ?? entity.symbolName} (${entity.symbolKind}) — ${entity.filePath}`);

    const propertyMappings = columnLinks.filter((link) => ownerQualifiedName(link) === (entity.qualifiedName ?? entity.symbolName));
    if (propertyMappings.length > 0) {
      for (const mapping of propertyMappings) {
        const propertyName = mapping.qualifiedName?.split('::$').pop() ?? mapping.symbolName;
        const joinSuffix = mapping.linkKind === 'entity_join_column' && mapping.referencedColumnName
          ? ` -> ${mapping.referencedColumnName}`
          : '';
        lines.push(`  - $${propertyName} -> ${mapping.columnName}${joinSuffix}`);
      }
    }
  }

  const usageRows = collectDependentUsage(entityLinks, refRepo, depth, limit);
  lines.push('');
  lines.push(`### Code Touchpoints (${usageRows.length})`);
  if (usageRows.length === 0) {
    lines.push('No indexed code references to the mapped entities were found.');
  } else {
    for (const row of usageRows) {
      const depthLabel = row.depth ? `depth ${row.depth}: ` : '';
      const lineSuffix = row.line_number ? `, line ${row.line_number}` : '';
      lines.push(`- ${depthLabel}${row.source_qualified_name} (${row.reference_kind}${lineSuffix}) — ${row.source_file_path}`);
    }
  }

  return lines.join('\n');
}

function collectDependentUsage(
  entityLinks: SymbolTableLinkRecord[],
  refRepo: NonNullable<TableUsageDeps['refRepo']>,
  depth: number,
  limit: number
): DependentUsageRow[] {
  const deduped = new Map<string, DependentUsageRow>();

  for (const entity of entityLinks) {
    const rows = refRepo.findDependents(entity.sourceSymbolId, depth) as DependentUsageRow[];
    for (const row of rows) {
      const sourceQualifiedName = row.source_qualified_name;
      if (!sourceQualifiedName) continue;

      const key = [
        sourceQualifiedName,
        row.reference_kind ?? '',
        row.line_number ?? '',
        row.depth ?? '',
      ].join('|');

      if (!deduped.has(key)) {
        deduped.set(key, row);
      }
    }
  }

  return [...deduped.values()]
    .sort((a, b) => {
      const depthA = a.depth ?? 1;
      const depthB = b.depth ?? 1;
      if (depthA !== depthB) return depthA - depthB;
      return (a.source_qualified_name ?? '').localeCompare(b.source_qualified_name ?? '');
    })
    .slice(0, limit);
}

function ownerQualifiedName(link: SymbolColumnLinkRecord): string | null {
  return link.qualifiedName?.split('::$')[0] ?? null;
}
