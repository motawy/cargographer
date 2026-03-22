import { readFileSync } from 'fs';
import { loadConfig } from '../../config.js';
import { normalizeSchemaName } from '../../db/repositories/db-schema-repository.js';
import { resolveIndexedFilePath } from '../../utils/indexed-path.js';
import { isTestPath } from '../../utils/test-path.js';
import type { SymbolColumnLinkRecord } from '../../db/repositories/symbol-schema-repository.js';
import type { ToolDeps } from '../types.js';

interface ColumnUsageParams {
  table: string;
  column: string;
  limit?: number;
  includeTests?: boolean;
}

type ColumnUsageDeps = Pick<ToolDeps, 'repoId' | 'repoPath' | 'schemaRepo' | 'symbolSchemaRepo' | 'tableReferenceRepo' | 'symbolRepo'>;

interface ColumnMatch {
  filePath: string;
  lineNumber: number;
  symbolName: string | null;
  preview: string;
  isWriteLike: boolean;
}

export function handleColumnUsage(deps: ColumnUsageDeps, params: ColumnUsageParams): string {
  const { repoId, repoPath, schemaRepo, symbolSchemaRepo, tableReferenceRepo, symbolRepo } = deps;
  if (!repoPath) {
    throw new Error('Repository path is required for column usage.');
  }
  if (!schemaRepo || !symbolSchemaRepo || !symbolRepo) {
    throw new Error('Schema and symbol repositories are required for column usage.');
  }

  const limit = Math.max(1, Math.min(params.limit ?? 15, 100));
  const includeTests = params.includeTests ?? false;

  const matches = schemaRepo.findCurrentTablesByName(repoId, params.table, 10);
  if (matches.length === 0) {
    return `Table not found: "${params.table}".`;
  }

  const normalizedTableName = normalizeSchemaName(params.table);
  const exactTable = matches.find((match) => match.normalizedName === normalizedTableName);
  const table = exactTable ?? matches[0]!;

  if (!exactTable && matches.length > 1) {
    return [
      `Multiple tables match "${params.table}".`,
      '',
      ...matches.map((match) => `- ${match.name}`),
      '',
      'Retry with the full table name for an exact match.',
    ].join('\n');
  }

  const normalizedColumnName = normalizeSchemaName(params.column);
  const tableColumns = schemaRepo.findCurrentColumns(table.id);
  const tableColumn = tableColumns.find((column) => column.normalizedName === normalizedColumnName);
  if (!tableColumn) {
    return `Column not found: "${params.column}" on table "${table.name}".`;
  }

  const columnLinks = symbolSchemaRepo
    .findColumnLinksByTable(repoId, table.normalizedName)
    .filter((link) => link.normalizedColumnName === normalizedColumnName);
  const directRefs = tableReferenceRepo?.findByTable(repoId, table.name) ?? [];
  const scopedFilePaths = new Set<string>([
    ...columnLinks.map((link) => link.filePath),
    ...directRefs.map((ref) => ref.filePath),
  ]);
  const columnMatches = scopedFilePaths.size > 0
    ? findColumnMatches(
        repoId,
        repoPath,
        symbolRepo,
        [...scopedFilePaths],
        tableColumn.name,
        includeTests,
        limit
      )
    : [];

  const writeMatches = columnMatches.filter((match) => match.isWriteLike);
  const otherMatches = columnMatches.filter((match) => !match.isWriteLike);

  const lines: string[] = [];
  lines.push(`## Column Usage: ${table.name}.${tableColumn.name}`);
  lines.push(`- Scoped files touching table: ${scopedFilePaths.size}`);
  lines.push(`- Tests included: ${includeTests ? 'yes' : 'no'}`);
  lines.push('- Write detection: heuristic (insert/update/set/assignment contexts)');
  lines.push('');

  lines.push('### Mapped properties');
  if (columnLinks.length === 0) {
    lines.push('No Doctrine-style property mappings were found for this column.');
  } else {
    for (const link of columnLinks) {
      const propertyName = link.qualifiedName?.split('::$').pop() ?? link.symbolName;
      const ownerName = link.qualifiedName?.split('::$')[0] ?? link.symbolName;
      lines.push(`- ${ownerName}::$${propertyName} — ${link.filePath}`);
    }
  }

  lines.push('');
  lines.push('### Likely write refs');
  if (writeMatches.length === 0) {
    lines.push('No likely write-like column refs were found in files that already touch this table.');
  } else {
    renderColumnMatches(lines, writeMatches);
  }

  lines.push('');
  lines.push('### Other column refs');
  if (otherMatches.length === 0) {
    lines.push('No additional literal column refs were found in the scoped files.');
  } else {
    renderColumnMatches(lines, otherMatches);
  }

  return lines.join('\n');
}

function findColumnMatches(
  repoId: number,
  repoPath: string,
  symbolRepo: NonNullable<ColumnUsageDeps['symbolRepo']>,
  filePaths: string[],
  columnName: string,
  includeTests: boolean,
  limit: number
): ColumnMatch[] {
  const config = loadConfig(repoPath);
  const queryLower = columnName.toLowerCase();
  const matches: ColumnMatch[] = [];

  for (const filePath of [...new Set(filePaths)].sort()) {
    if (!includeTests && isTestPath(filePath)) continue;

    const absolutePath = resolveIndexedFilePath(repoPath, filePath, config);
    if (!absolutePath) continue;

    let content: string;
    try {
      content = readFileSync(absolutePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line.toLowerCase().includes(queryLower)) continue;

      const lineNumber = index + 1;
      const symbol = symbolRepo.findInnermostByFileAndLine(repoId, filePath, lineNumber);
      matches.push({
        filePath,
        lineNumber,
        symbolName: symbol?.qualifiedName ?? null,
        preview: line.trim(),
        isWriteLike: isLikelyWriteContext(lines, index, queryLower),
      });

      if (matches.length >= limit * 4) {
        return matches;
      }
    }
  }

  return matches;
}

function isLikelyWriteContext(lines: string[], lineIndex: number, columnLower: string): boolean {
  const start = Math.max(0, lineIndex - 2);
  const end = Math.min(lines.length, lineIndex + 2);
  const window = lines.slice(start, end).join('\n').toLowerCase();
  const current = lines[lineIndex]!.toLowerCase();

  if (/\border\s+by\b|\bgroup\s+by\b/.test(window) && !/\bupdate\b|\binsert\b|\bset\b/.test(window)) {
    return false;
  }

  if (current.includes('=>') || current.includes('->set(')) {
    return true;
  }

  const escapedColumn = escapeRegExp(columnLower);
  if (new RegExp(`['"\`]${escapedColumn}['"\`]\\s*=>`).test(current)) {
    return true;
  }

  if (new RegExp(`\\b${escapedColumn}\\b\\s*=`).test(current)) {
    return true;
  }

  return /\bupdate\b|\binsert\b|\bset\b|\bvalues\b/.test(window) && window.includes(columnLower);
}

function renderColumnMatches(lines: string[], matches: ColumnMatch[]): void {
  for (const match of matches) {
    const symbolLabel = match.symbolName ?? 'file scope';
    lines.push(`- ${symbolLabel} — ${match.filePath}:${match.lineNumber}`);
    lines.push(`  ${match.preview}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
