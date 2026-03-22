import { normalizeSchemaName } from '../../db/repositories/db-schema-repository.js';
import type { SymbolColumnLinkRecord, SymbolTableLinkRecord } from '../../db/repositories/symbol-schema-repository.js';
import type { ToolDeps } from '../types.js';
import { findContentMatches, isTestPath, type ContentMatch } from './content-search-shared.js';

interface TableUsageParams {
  name: string;
  depth?: number;
  limit?: number;
  includeTests?: boolean;
}

type TableUsageDeps = Pick<ToolDeps, 'repoId' | 'repoPath' | 'schemaRepo' | 'symbolSchemaRepo' | 'refRepo' | 'fileRepo' | 'symbolRepo'>;

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
  const includeTests = params.includeTests ?? false;
  const entityLinks = symbolSchemaRepo.findEntitySymbolsByTable(repoId, table.normalizedName);
  const columnLinks = symbolSchemaRepo.findColumnLinksByTable(repoId, table.normalizedName);
  const entityQualifiedNames = new Set(
    entityLinks
      .map((entity) => entity.qualifiedName ?? entity.symbolName)
      .filter((value): value is string => Boolean(value))
  );
  const entityFilePaths = new Set(entityLinks.map((entity) => entity.filePath));

  const lines: string[] = [];
  lines.push(`## Table Usage: ${table.name}`);
  lines.push(`- Depth: ${depth}`);
  lines.push(`- Mapped entities: ${entityLinks.length}`);
  lines.push(`- Tests included: ${includeTests ? 'yes' : 'no'}`);
  lines.push('');

  if (entityLinks.length === 0) {
    lines.push('No Doctrine-style entity mappings were found for this table.');
    lines.push('This usually means one of: no entity exists, the mapping is implicit, or the code uses a non-Doctrine pattern.');
  } else {
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
  }

  const usageRows = collectDependentUsage(entityLinks, refRepo, depth, limit, includeTests);
  lines.push('');
  lines.push('### Entity-Based Code Touchpoints');
  if (usageRows.length === 0) {
    lines.push(entityLinks.length === 0
      ? 'No entity-based touchpoints were found because there are no mapped entities to traverse.'
      : 'No indexed code references to the mapped entities were found.');
  } else {
    renderDependentRows(lines, usageRows, includeTests, limit);
  }

  const directReferenceMatches = findDirectTableMentions(
    deps,
    table.name,
    limit,
    includeTests,
    entityQualifiedNames,
    entityFilePaths
  );

  lines.push('');
  lines.push('### Direct Table Name References');
  if (directReferenceMatches.length === 0) {
    lines.push('No direct table-name references were found in indexed source files.');
  } else {
    renderContentMatches(lines, directReferenceMatches, includeTests, limit);
  }

  return lines.join('\n');
}

function collectDependentUsage(
  entityLinks: SymbolTableLinkRecord[],
  refRepo: NonNullable<TableUsageDeps['refRepo']>,
  depth: number,
  limit: number,
  includeTests: boolean
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
      const aIsTest = a.source_file_path ? isTestPath(a.source_file_path) : false;
      const bIsTest = b.source_file_path ? isTestPath(b.source_file_path) : false;
      if (aIsTest !== bIsTest) return aIsTest ? 1 : -1;

      const depthA = a.depth ?? 1;
      const depthB = b.depth ?? 1;
      if (depthA !== depthB) return depthA - depthB;
      return (a.source_qualified_name ?? '').localeCompare(b.source_qualified_name ?? '');
    })
    .slice(0, includeTests ? limit : Math.min(limit * 4, 250));
}

function ownerQualifiedName(link: SymbolColumnLinkRecord): string | null {
  return link.qualifiedName?.split('::$')[0] ?? null;
}

function findDirectTableMentions(
  deps: TableUsageDeps,
  tableName: string,
  limit: number,
  includeTests: boolean,
  entityQualifiedNames: Set<string>,
  entityFilePaths: Set<string>
): ContentMatch[] {
  if (!deps.repoPath || !deps.fileRepo || !deps.symbolRepo) {
    return [];
  }

  const rawMatches = findContentMatches(
    {
      repoId: deps.repoId,
      repoPath: deps.repoPath,
      fileRepo: deps.fileRepo,
      symbolRepo: deps.symbolRepo,
    },
    {
      query: tableName,
      limit: Math.min(limit * 20, 1000),
      includeTests: true,
      lineMatcher: (line) => isDirectTableReferenceCandidate(line, tableName),
    }
  );

  const deduped = new Map<string, ContentMatch>();

  for (const match of rawMatches) {
    if (!isLikelyDirectTableReference(match, tableName)) continue;
    if (entityFilePaths.has(match.filePath) && !match.symbolName) continue;
    if (match.symbolName && isMappedEntitySymbol(match.symbolName, entityQualifiedNames)) continue;

    const key = `${match.symbolName ?? match.filePath}|${match.filePath}`;
    if (!deduped.has(key)) {
      deduped.set(key, match);
    }

    if (deduped.size >= (includeTests ? limit : Math.min(limit * 4, 250))) {
      break;
    }
  }

  return [...deduped.values()].sort((a, b) => {
    if (a.isTest !== b.isTest) return a.isTest ? 1 : -1;
    return a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber;
  });
}

function isMappedEntitySymbol(symbolName: string, entityQualifiedNames: Set<string>): boolean {
  for (const entityName of entityQualifiedNames) {
    if (symbolName === entityName || symbolName.startsWith(`${entityName}::`) || symbolName.startsWith(`${entityName}::$`)) {
      return true;
    }
  }
  return false;
}

function isDirectTableReferenceCandidate(line: string, tableName: string): boolean {
  const trimmed = line.trim();
  if (isCommentOnlyLine(trimmed)) return false;
  return buildExactTableTokenPattern(tableName).test(line);
}

function isLikelyDirectTableReference(match: ContentMatch, tableName: string): boolean {
  const line = match.preview;
  if (!buildExactTableTokenPattern(tableName).test(line)) return false;

  if (buildSqlClausePattern(tableName).test(line)) return true;
  if (buildQueryBuilderCallPattern(tableName).test(line)) return true;
  if (buildTableAssignmentPattern(tableName).test(line)) return true;
  if (match.isTest && buildQuotedLiteralPattern(tableName).test(line)) return true;

  return buildQuotedReturnPattern(tableName).test(line) && hasTableSymbolContext(match.symbolName);
}

function buildExactTableTokenPattern(tableName: string): RegExp {
  const escaped = escapeRegExp(tableName);
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i');
}

function buildSqlClausePattern(tableName: string): RegExp {
  const escaped = escapeRegExp(tableName);
  return new RegExp(
    `\\b(?:from|join|update|into|table|using)\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?(?:["'\`])?(?:[A-Za-z0-9_]+\\.)?${escaped}(?:["'\`])?(?=$|[\\s,;\\)\\]])`,
    'i'
  );
}

function buildQueryBuilderCallPattern(tableName: string): RegExp {
  const escaped = escapeRegExp(tableName);
  return new RegExp(
    `(?:->|::|\\b)(?:from|join|leftjoin|rightjoin|innerjoin|crossjoin|table)\\s*\\(\\s*(["'\`])${escaped}\\1`,
    'i'
  );
}

function buildQuotedLiteralPattern(tableName: string): RegExp {
  const escaped = escapeRegExp(tableName);
  return new RegExp(`(["'\`])${escaped}\\1`, 'i');
}

function buildTableAssignmentPattern(tableName: string): RegExp {
  const escaped = escapeRegExp(tableName);
  return new RegExp(
    `(?:["'\`]?\\b(?:table|table_name|tablename|dbtable|source_table|sourcetable)\\b["'\`]?|\\$[A-Za-z_][A-Za-z0-9_]*table[A-Za-z0-9_]*)\\s*(?:=>|:|=)\\s*(["'\`])${escaped}\\1`,
    'i'
  );
}

function buildQuotedReturnPattern(tableName: string): RegExp {
  const escaped = escapeRegExp(tableName);
  return new RegExp(`\\breturn\\b\\s*(?:\\(?\\s*)?(["'\`])${escaped}\\1`, 'i');
}

function hasTableSymbolContext(symbolName: string | null): boolean {
  if (!symbolName) return false;
  const leaf = symbolName.split('::').pop()?.toLowerCase() ?? '';
  return leaf.includes('table');
}

function isCommentOnlyLine(line: string): boolean {
  return /^(?:\/\/|#|\/\*|\*)/.test(line);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderDependentRows(lines: string[], rows: DependentUsageRow[], includeTests: boolean, limit: number): void {
  const productionRows = rows.filter((row) => !row.source_file_path || !isTestPath(row.source_file_path)).slice(0, includeTests ? rows.length : limit);
  const testRows = rows.filter((row) => row.source_file_path && isTestPath(row.source_file_path));

  renderDependentGroup(lines, productionRows, includeTests ? 'Production' : undefined);

  if (includeTests) {
    renderDependentGroup(lines, testRows, 'Tests');
  } else if (testRows.length > 0) {
    lines.push(`- Tests hidden by default: ${testRows.length} more touchpoint${testRows.length === 1 ? '' : 's'}. Re-run with includeTests=true to include them.`);
  }
}

function renderDependentGroup(lines: string[], rows: DependentUsageRow[], heading?: string): void {
  if (rows.length === 0) return;
  if (heading) {
    lines.push(`#### ${heading} (${rows.length})`);
  }

  for (const row of rows) {
    const depthLabel = row.depth ? `depth ${row.depth}: ` : '';
    const lineSuffix = row.line_number ? `, line ${row.line_number}` : '';
    lines.push(`- ${depthLabel}${row.source_qualified_name} (${row.reference_kind}${lineSuffix}) — ${row.source_file_path}`);
  }
}

function renderContentMatches(lines: string[], matches: ContentMatch[], includeTests: boolean, limit: number): void {
  const productionMatches = matches.filter((match) => !match.isTest).slice(0, includeTests ? matches.length : limit);
  const testMatches = matches.filter((match) => match.isTest);

  renderContentLayerGroups(lines, productionMatches, includeTests);

  if (includeTests) {
    renderContentGroup(lines, testMatches, 'Tests');
  } else if (testMatches.length > 0) {
    lines.push(`- Tests hidden by default: ${testMatches.length} more direct reference${testMatches.length === 1 ? '' : 's'}. Re-run with includeTests=true to include them.`);
  }
}

function renderContentGroup(lines: string[], matches: ContentMatch[], heading?: string): void {
  if (matches.length === 0) return;
  if (heading) {
    lines.push(`#### ${heading} (${matches.length})`);
  }

  for (const match of matches) {
    const owner = match.symbolName
      ? `${match.symbolName}${match.symbolKind ? ` (${match.symbolKind})` : ''}`
      : 'No enclosing symbol';
    lines.push(`- ${owner} — ${match.filePath}:${match.lineNumber}`);
    lines.push(`  ${match.preview}`);
  }
}

function renderContentLayerGroups(lines: string[], matches: ContentMatch[], includeTests: boolean): void {
  if (matches.length === 0) return;

  const grouped = new Map<string, ContentMatch[]>();
  for (const match of matches) {
    const layer = classifyArchitectureLayer(match.filePath, match.symbolName);
    const entries = grouped.get(layer) ?? [];
    entries.push(match);
    grouped.set(layer, entries);
  }

  const orderedLayers = CONTENT_LAYER_ORDER.filter((layer) => grouped.has(layer));
  for (const layer of orderedLayers) {
    renderContentGroup(lines, grouped.get(layer)!, includeTests ? layer : layer);
  }
}

const CONTENT_LAYER_ORDER = [
  'Route',
  'Controller',
  'Builder',
  'Model',
  'Repository',
  'DataObject',
  'Handler',
  'Report',
  'Staff Page',
  'Legacy Page',
  'Other',
] as const;

function classifyArchitectureLayer(filePath: string, symbolName: string | null): string {
  const path = filePath.toLowerCase();
  const symbol = (symbolName ?? '').toLowerCase();

  if (matchesLayer(path, symbol, ['routes?', 'route'])) return 'Route';
  if (matchesLayer(path, symbol, ['controllers?', 'controller'])) return 'Controller';
  if (matchesLayer(path, symbol, ['builders?', 'builder'])) return 'Builder';
  if (matchesLayer(path, symbol, ['models?', 'model'])) return 'Model';
  if (matchesLayer(path, symbol, ['repositories?', 'repository'])) return 'Repository';
  if (matchesLayer(path, symbol, ['dataobjects?', 'dataobject'])) return 'DataObject';
  if (matchesLayer(path, symbol, ['handlers?', 'handler'])) return 'Handler';
  if (matchesLayer(path, symbol, ['reports?', 'report'])) return 'Report';
  if (/(^|[\\/])staff([\\/]|$)/.test(path)) return 'Staff Page';
  if (/(^|[\\/])(pages?|legacy)([\\/]|$)/.test(path)) return 'Legacy Page';
  return 'Other';
}

function matchesLayer(path: string, symbol: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const pathPattern = new RegExp(`(^|[\\\\/])${pattern}([\\\\/]|$)`, 'i');
    const symbolPattern = new RegExp(`(^|\\\\|::|\\$)${pattern}s?($|\\\\|::)`, 'i');
    return pathPattern.test(path) || symbolPattern.test(symbol);
  });
}
