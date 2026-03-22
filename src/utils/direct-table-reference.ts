import { normalizeSchemaName } from '../db/repositories/db-schema-repository.js';

export type DirectTableReferenceKind =
  | 'sql_clause'
  | 'query_builder_call'
  | 'table_assignment'
  | 'quoted_return'
  | 'quoted_literal';

interface DirectTableReferenceContext {
  isTest: boolean;
  symbolName?: string | null;
}

const tokenPattern = /[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g;
const sqlClausePatternCache = new Map<string, RegExp>();
const queryBuilderPatternCache = new Map<string, RegExp>();
const tableAssignmentPatternCache = new Map<string, RegExp>();
const quotedReturnPatternCache = new Map<string, RegExp>();
const quotedLiteralPatternCache = new Map<string, RegExp>();

export function findReferencedTablesInLine(
  line: string,
  tableNamesByNormalized: Map<string, string>,
  context: DirectTableReferenceContext
): Array<{ tableName: string; normalizedTableName: string; referenceKind: DirectTableReferenceKind }> {
  const candidates = findCandidateTablesInLine(line, tableNamesByNormalized);
  if (candidates.length === 0) {
    return [];
  }

  const matches: Array<{ tableName: string; normalizedTableName: string; referenceKind: DirectTableReferenceKind }> = [];
  for (const candidate of candidates) {
    const referenceKind = classifyDirectTableReference(line, candidate.tableName, context);
    if (!referenceKind) {
      continue;
    }

    matches.push({
      tableName: candidate.tableName,
      normalizedTableName: candidate.normalizedTableName,
      referenceKind,
    });
  }

  return matches;
}

export function findCandidateTablesInLine(
  line: string,
  tableNamesByNormalized: Map<string, string>
): Array<{ tableName: string; normalizedTableName: string }> {
  if (isCommentOnlyLine(line)) {
    return [];
  }

  const candidates: Array<{ tableName: string; normalizedTableName: string }> = [];
  const seen = new Set<string>();

  for (const token of extractCandidateTableTokens(line)) {
    const normalizedToken = normalizeSchemaName(token);
    const tableName = tableNamesByNormalized.get(normalizedToken);
    if (!tableName || seen.has(normalizedToken)) {
      continue;
    }

    seen.add(normalizedToken);
    candidates.push({
      tableName,
      normalizedTableName: normalizedToken,
    });
  }

  return candidates;
}

export function classifyDirectTableReference(
  line: string,
  tableName: string,
  context: DirectTableReferenceContext
): DirectTableReferenceKind | null {
  if (buildSqlClausePattern(tableName).test(line)) return 'sql_clause';
  if (buildQueryBuilderCallPattern(tableName).test(line)) return 'query_builder_call';
  if (buildTableAssignmentPattern(tableName).test(line)) return 'table_assignment';
  if (context.isTest && buildQuotedLiteralPattern(tableName).test(line)) return 'quoted_literal';
  if (buildQuotedReturnPattern(tableName).test(line) && hasTableSymbolContext(context.symbolName)) {
    return 'quoted_return';
  }
  return null;
}

function extractCandidateTableTokens(line: string): string[] {
  const matches = line.match(tokenPattern);
  return matches ?? [];
}

function buildSqlClausePattern(tableName: string): RegExp {
  return cachedPattern(sqlClausePatternCache, tableName, () => {
    const escaped = escapeRegExp(tableName);
    return new RegExp(
      `\\b(?:from|join|update|into|table|using)\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?(?:["'\`])?(?:[A-Za-z0-9_]+\\.)?${escaped}(?:["'\`])?(?=$|[\\s,;\\)\\]])`,
      'i'
    );
  });
}

function buildQueryBuilderCallPattern(tableName: string): RegExp {
  return cachedPattern(queryBuilderPatternCache, tableName, () => {
    const escaped = escapeRegExp(tableName);
    return new RegExp(
      `(?:->|::|\\b)(?:from|join|leftjoin|rightjoin|innerjoin|crossjoin|table)\\s*\\(\\s*(["'\`])${escaped}\\1`,
      'i'
    );
  });
}

function buildQuotedLiteralPattern(tableName: string): RegExp {
  return cachedPattern(quotedLiteralPatternCache, tableName, () => {
    const escaped = escapeRegExp(tableName);
    return new RegExp(`(["'\`])${escaped}\\1`, 'i');
  });
}

function buildTableAssignmentPattern(tableName: string): RegExp {
  return cachedPattern(tableAssignmentPatternCache, tableName, () => {
    const escaped = escapeRegExp(tableName);
    return new RegExp(
      `(?:["'\`]?\\b(?:table|table_name|tablename|dbtable|source_table|sourcetable)\\b["'\`]?|\\$[A-Za-z_][A-Za-z0-9_]*table[A-Za-z0-9_]*)\\s*(?:=>|:|=)\\s*(["'\`])${escaped}\\1`,
      'i'
    );
  });
}

function buildQuotedReturnPattern(tableName: string): RegExp {
  return cachedPattern(quotedReturnPatternCache, tableName, () => {
    const escaped = escapeRegExp(tableName);
    return new RegExp(`\\breturn\\b\\s*(?:\\(?\\s*)?(["'\`])${escaped}\\1`, 'i');
  });
}

function cachedPattern(cache: Map<string, RegExp>, tableName: string, build: () => RegExp): RegExp {
  const cached = cache.get(tableName);
  if (cached) {
    return cached;
  }

  const pattern = build();
  cache.set(tableName, pattern);
  return pattern;
}

function hasTableSymbolContext(symbolName: string | null | undefined): boolean {
  if (!symbolName) return false;
  const leaf = symbolName.split('::').pop()?.toLowerCase() ?? '';
  return leaf.includes('table');
}

function isCommentOnlyLine(line: string): boolean {
  return /^(?:\/\/|#|\/\*|\*)/.test(line.trim());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
