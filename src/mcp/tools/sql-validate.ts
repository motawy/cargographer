import { readFileSync } from 'fs';
import { loadConfig } from '../../config.js';
import type { DbForeignKeyRecord, DbTableRecord } from '../../db/repositories/db-schema-repository.js';
import { normalizeSchemaName } from '../../db/repositories/db-schema-repository.js';
import type { SymbolRecord } from '../../db/repositories/symbol-repository.js';
import { resolveIndexedFilePath } from '../../utils/indexed-path.js';
import type { ToolDeps } from '../types.js';

const MAX_SECTION_ITEMS = 50;
const SQL_CANDIDATE_PATTERN = /\b(select|from|join|update|insert|delete|where|set|values|on|using)\b|->(?:from|join|leftJoin|rightJoin|innerJoin|crossJoin|table|set)\s*\(|\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_*]*\b/i;
const STATEMENT_BREAK_PATTERN = /;\s*(?:$|["'`)]|\+)/;
const SCOPE_BREAK_PATTERN = /^\s*(?:public|protected|private|final|abstract)?\s*(?:static\s+)?function\b|^\s*class\b|^\s*interface\b|^\s*trait\b/i;
const SQL_TABLE_PATTERN = /\b(from|join|update|into|using)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:["'`])?((?:[A-Za-z0-9_]+\.)?[A-Za-z0-9_]+)(?:["'`])?(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
const DELETE_TABLE_PATTERN = /\bdelete\s+from\s+(?:["'`])?((?:[A-Za-z0-9_]+\.)?[A-Za-z0-9_]+)(?:["'`])?(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
const QUERY_BUILDER_TABLE_PATTERN = /(?:->|::)(from|join|leftjoin|rightjoin|innerjoin|crossjoin|table)\s*\(\s*(["'`])([^"'`]+)\2(?:\s*,\s*(["'`])([^"'`]+)\4)?/gi;
const QUALIFIED_COLUMN_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_*]*)\b/g;
const JOIN_PAIR_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
const INSERT_COLUMN_LIST_PATTERN = /\binsert\s+into\b\s+(?:["'`])?(?:[A-Za-z0-9_]+\.)?[A-Za-z0-9_]+(?:["'`])?\s*\(([^)]+)\)/i;
const SET_ASSIGNMENT_PATTERN = /(?<!\.)\b([A-Za-z_][A-Za-z0-9_]*)\b\s*=/g;
const WHERE_COLUMN_PATTERN = /(?:\bwhere\b|\band\b|\bor\b)\s+(?<!\.)\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|<>|!=|<|>|<=|>=|\blike\b|\bin\b|\bis\b)/gi;
const QUERY_BUILDER_SET_PATTERN = /->set\s*\(\s*(["'`])([A-Za-z_][A-Za-z0-9_]*)\1/gi;
const RESERVED_ALIAS_WORDS = new Set([
  'on',
  'where',
  'set',
  'values',
  'group',
  'order',
  'left',
  'right',
  'inner',
  'cross',
  'limit',
  'offset',
  'as',
]);

interface SqlValidateParams {
  symbol?: string;
  file?: string;
  limit?: number;
}

type SqlValidateDeps = Pick<ToolDeps, 'repoId' | 'repoPath' | 'schemaRepo' | 'symbolRepo' | 'fileRepo'>;

interface ValidationScope {
  label: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

interface ScopedLine {
  lineNumber: number;
  text: string;
}

interface ValidationRecord {
  message: string;
  lineNumber: number;
  preview: string;
  symbolName: string | null;
}

interface ValidationAnalysis {
  tableNames: string[];
  verifiedColumns: ValidationRecord[];
  verifiedJoins: ValidationRecord[];
  issues: ValidationRecord[];
}

interface AnalysisState {
  aliases: Map<string, string>;
  activeTables: Set<string>;
  primaryTable: string | null;
}

interface TableSchemaInfo {
  record: DbTableRecord;
  columns: Map<string, string>;
  foreignKeys: DbForeignKeyRecord[];
}

export function handleSqlValidate(deps: SqlValidateDeps, params: SqlValidateParams): string {
  const { repoId, repoPath, schemaRepo, symbolRepo, fileRepo } = deps;
  if (!repoPath) {
    throw new Error('Repository path is required for SQL validation.');
  }
  if (!schemaRepo || !symbolRepo || !fileRepo) {
    throw new Error('Schema, symbol, and file repositories are required for SQL validation.');
  }

  const selectorCount = Number(Boolean(params.symbol)) + Number(Boolean(params.file));
  if (selectorCount !== 1) {
    return 'Provide exactly one of "symbol" or "file".';
  }

  const limit = Math.max(1, Math.min(params.limit ?? 20, MAX_SECTION_ITEMS));
  const scope = params.symbol
    ? resolveSymbolScope(repoId, params.symbol, symbolRepo)
    : resolveFileScope(repoId, params.file!, fileRepo, symbolRepo);
  if (typeof scope === 'string') {
    return scope;
  }

  const config = loadConfig(repoPath);
  const absolutePath = resolveIndexedFilePath(repoPath, scope.filePath, config);
  if (!absolutePath) {
    return `Indexed file is no longer available locally: ${scope.filePath}`;
  }

  let content: string;
  try {
    content = readFileSync(absolutePath, 'utf-8');
  } catch {
    return `Indexed file is no longer readable locally: ${scope.filePath}`;
  }

  const currentTables = schemaRepo.listCurrentTables(repoId);
  if (currentTables.length === 0) {
    return 'No current schema is indexed for this repo. Run `cartograph refresh` first.';
  }

  const tableRecords = new Map(
    currentTables.map((table) => [table.normalizedName, table] as const)
  );
  const schemaCache = new Map<string, TableSchemaInfo | null>();
  const lines = content
    .split('\n')
    .slice(scope.lineStart - 1, scope.lineEnd)
    .map((text, index) => ({
      lineNumber: scope.lineStart + index,
      text,
    }));
  const symbolNameCache = new Map<number, string | null>();

  const analysis = analyzeScopeLines(lines, {
    tableRecords,
    getTableInfo: (normalizedTableName) => getTableInfo(normalizedTableName, schemaCache, tableRecords, schemaRepo),
    getSymbolNameAt: (lineNumber) => {
      if (!symbolNameCache.has(lineNumber)) {
        const symbol = symbolRepo.findInnermostByFileAndLine(repoId, scope.filePath, lineNumber);
        symbolNameCache.set(lineNumber, symbol?.qualifiedName ?? null);
      }
      return symbolNameCache.get(lineNumber) ?? null;
    },
  });

  const linesOut: string[] = [];
  linesOut.push(`## SQL Validation: ${scope.label}`);
  linesOut.push(`- Scope: ${scope.filePath}:${scope.lineStart}-${scope.lineEnd}`);
  linesOut.push(`- Tables inferred: ${analysis.tableNames.length > 0 ? analysis.tableNames.join(', ') : '(none)'}`);
  linesOut.push(`- Verified column refs: ${analysis.verifiedColumns.length}`);
  linesOut.push(`- FK-backed joins: ${analysis.verifiedJoins.length}`);
  linesOut.push(`- Issues: ${analysis.issues.length}`);
  linesOut.push('- Validation mode: heuristic, literal SQL/table/column/join matching against current indexed schema');
  linesOut.push('');

  linesOut.push('### Issues');
  if (analysis.issues.length === 0) {
    linesOut.push('No schema mismatches were found in literal SQL-ish refs within this scope.');
  } else {
    renderValidationRecords(linesOut, analysis.issues, limit);
  }

  linesOut.push('');
  linesOut.push('### Verified column refs');
  if (analysis.verifiedColumns.length === 0) {
    linesOut.push('No explicit column refs were verified.');
  } else {
    renderValidationRecords(linesOut, analysis.verifiedColumns, limit);
  }

  linesOut.push('');
  linesOut.push('### FK-backed joins');
  if (analysis.verifiedJoins.length === 0) {
    linesOut.push('No join predicates matched a declared foreign key.');
  } else {
    renderValidationRecords(linesOut, analysis.verifiedJoins, limit);
  }

  return linesOut.join('\n');
}

function resolveSymbolScope(
  repoId: number,
  symbolName: string,
  symbolRepo: NonNullable<SqlValidateDeps['symbolRepo']>
): ValidationScope | string {
  const exact = symbolRepo.findByQualifiedName(repoId, symbolName);
  const symbol = exact ?? symbolRepo.search(repoId, `%${symbolName.replace(/\\/g, '\\\\')}`, undefined, 1)[0] ?? null;
  if (!symbol) {
    return `Symbol not found: "${symbolName}". Use cartograph_find to search.`;
  }

  const filePath = symbolRepo.getFilePath(symbol.fileId);
  if (!filePath) {
    return `Source file not found for symbol "${symbol.qualifiedName ?? symbol.name}".`;
  }

  return {
    label: symbol.qualifiedName ?? symbol.name,
    filePath,
    lineStart: symbol.lineStart,
    lineEnd: symbol.lineEnd,
  };
}

function resolveFileScope(
  repoId: number,
  filePath: string,
  fileRepo: NonNullable<SqlValidateDeps['fileRepo']>,
  symbolRepo: NonNullable<SqlValidateDeps['symbolRepo']>
): ValidationScope | string {
  const file = fileRepo.listByRepo(repoId).find((entry) => entry.path === filePath);
  if (!file) {
    const suggestions = fileRepo
      .listByRepo(repoId)
      .filter((entry) => entry.path.toLowerCase().includes(filePath.toLowerCase()))
      .slice(0, 5)
      .map((entry) => `- ${entry.path}`);
    if (suggestions.length > 0) {
      return [`File not found: "${filePath}".`, '', 'Did you mean:', ...suggestions].join('\n');
    }
    const dirSuggestions = symbolRepo.suggestPaths(repoId, filePath);
    if (dirSuggestions.length > 0) {
      return [`File not found: "${filePath}".`, '', 'Nearby directories:', ...dirSuggestions.map((dir) => `- ${dir}`)].join('\n');
    }
    return `File not found: "${filePath}".`;
  }

  return {
    label: file.path,
    filePath: file.path,
    lineStart: 1,
    lineEnd: file.linesOfCode ?? Number.MAX_SAFE_INTEGER,
  };
}

function analyzeScopeLines(
  lines: ScopedLine[],
  deps: {
    tableRecords: Map<string, DbTableRecord>;
    getTableInfo: (normalizedTableName: string) => TableSchemaInfo | null;
    getSymbolNameAt: (lineNumber: number) => string | null;
  }
): ValidationAnalysis {
  const issues = new Map<string, ValidationRecord>();
  const verifiedColumns = new Map<string, ValidationRecord>();
  const verifiedJoins = new Map<string, ValidationRecord>();
  const tableNames = new Set<string>();
  let block: ScopedLine[] = [];

  for (const line of lines) {
    if (shouldResetBeforeLine(line.text)) {
      flushBlock(block, deps, tableNames, verifiedColumns, verifiedJoins, issues);
      block = [];
    }

    if (!SQL_CANDIDATE_PATTERN.test(line.text)) {
      flushBlock(block, deps, tableNames, verifiedColumns, verifiedJoins, issues);
      block = [];
      continue;
    }

    block.push(line);

    if (isStatementBreak(line.text)) {
      flushBlock(block, deps, tableNames, verifiedColumns, verifiedJoins, issues);
      block = [];
    }
  }

  flushBlock(block, deps, tableNames, verifiedColumns, verifiedJoins, issues);

  return {
    tableNames: [...tableNames].sort(),
    verifiedColumns: [...verifiedColumns.values()].sort(compareValidationRecords),
    verifiedJoins: [...verifiedJoins.values()].sort(compareValidationRecords),
    issues: [...issues.values()].sort(compareValidationRecords),
  };
}

function flushBlock(
  block: ScopedLine[],
  deps: {
    tableRecords: Map<string, DbTableRecord>;
    getTableInfo: (normalizedTableName: string) => TableSchemaInfo | null;
    getSymbolNameAt: (lineNumber: number) => string | null;
  },
  tableNames: Set<string>,
  verifiedColumns: Map<string, ValidationRecord>,
  verifiedJoins: Map<string, ValidationRecord>,
  issues: Map<string, ValidationRecord>
): void {
  if (block.length === 0) return;

  const state = createEmptyState();
  for (const line of block) {
    const preview = line.text.trim();
    bindTablesFromLine(line.text, state, deps.tableRecords, tableNames, issues, {
      lineNumber: line.lineNumber,
      preview,
      symbolName: deps.getSymbolNameAt(line.lineNumber),
    });
  }

  for (const line of block) {
    const symbolName = deps.getSymbolNameAt(line.lineNumber);
    const preview = line.text.trim();

    validateQualifiedColumns(line.text, state, deps, verifiedColumns, issues, {
      lineNumber: line.lineNumber,
      preview,
      symbolName,
    });
    validateBareColumns(line.text, state, deps, verifiedColumns, issues, {
      lineNumber: line.lineNumber,
      preview,
      symbolName,
    });
    validateJoinPairs(line.text, state, deps, verifiedJoins, issues, {
      lineNumber: line.lineNumber,
      preview,
      symbolName,
    });
  }
}

function bindTablesFromLine(
  line: string,
  state: AnalysisState,
  tableRecords: Map<string, DbTableRecord>,
  tableNames: Set<string>,
  issues: Map<string, ValidationRecord>,
  context: { lineNumber: number; preview: string; symbolName: string | null }
): void {
  SQL_TABLE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SQL_TABLE_PATTERN.exec(line)) !== null) {
    registerTableBinding(match[1]!.toLowerCase(), match[2]!, match[3] ?? null, state, tableRecords, tableNames, issues, context);
  }

  DELETE_TABLE_PATTERN.lastIndex = 0;
  while ((match = DELETE_TABLE_PATTERN.exec(line)) !== null) {
    registerTableBinding('delete', match[1]!, match[2] ?? null, state, tableRecords, tableNames, issues, context);
  }

  QUERY_BUILDER_TABLE_PATTERN.lastIndex = 0;
  while ((match = QUERY_BUILDER_TABLE_PATTERN.exec(line)) !== null) {
    registerTableBinding(match[1]!.toLowerCase(), match[3]!, match[5] ?? null, state, tableRecords, tableNames, issues, context);
  }
}

function registerTableBinding(
  keyword: string,
  rawTableName: string,
  rawAlias: string | null,
  state: AnalysisState,
  tableRecords: Map<string, DbTableRecord>,
  tableNames: Set<string>,
  issues: Map<string, ValidationRecord>,
  context: { lineNumber: number; preview: string; symbolName: string | null }
): void {
  const normalizedTableName = normalizeSchemaName(rawTableName);
  const table = tableRecords.get(normalizedTableName);
  if (!table) {
    addRecord(issues, `missing-table|${context.lineNumber}|${normalizedTableName}`, {
      message: `Missing table in current schema: ${rawTableName}`,
      lineNumber: context.lineNumber,
      preview: context.preview,
      symbolName: context.symbolName,
    });
    return;
  }

  tableNames.add(table.name);
  state.activeTables.add(table.normalizedName);
  registerAlias(state.aliases, table.name, table.normalizedName);
  registerAlias(state.aliases, table.name.split('.').pop() ?? table.name, table.normalizedName);

  const alias = sanitizeAlias(rawAlias);
  if (alias) {
    registerAlias(state.aliases, alias, table.normalizedName);
  }

  if (keyword === 'update' || keyword === 'into' || keyword === 'from' || keyword === 'table') {
    state.primaryTable = table.normalizedName;
  }
}

function validateQualifiedColumns(
  line: string,
  state: AnalysisState,
  deps: {
    getTableInfo: (normalizedTableName: string) => TableSchemaInfo | null;
  },
  verifiedColumns: Map<string, ValidationRecord>,
  issues: Map<string, ValidationRecord>,
  context: { lineNumber: number; preview: string; symbolName: string | null }
): void {
  QUALIFIED_COLUMN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUALIFIED_COLUMN_PATTERN.exec(line)) !== null) {
    const aliasOrTable = match[1]!;
    const columnName = match[2]!;
    if (columnName === '*') continue;

    const normalizedTableName = resolveAliasOrTable(aliasOrTable, state);
    if (!normalizedTableName) {
      addRecord(issues, `unresolved-alias|${context.lineNumber}|${aliasOrTable}|${columnName}`, {
        message: `Unresolved SQL alias/table: ${aliasOrTable}.${columnName}`,
        lineNumber: context.lineNumber,
        preview: context.preview,
        symbolName: context.symbolName,
      });
      continue;
    }

    validateColumnOnTable(normalizedTableName, columnName, deps.getTableInfo, verifiedColumns, issues, context);
  }
}

function validateBareColumns(
  line: string,
  state: AnalysisState,
  deps: {
    getTableInfo: (normalizedTableName: string) => TableSchemaInfo | null;
  },
  verifiedColumns: Map<string, ValidationRecord>,
  issues: Map<string, ValidationRecord>,
  context: { lineNumber: number; preview: string; symbolName: string | null }
): void {
  const primaryTable = state.primaryTable ?? (state.activeTables.size === 1 ? [...state.activeTables][0]! : null);
  if (!primaryTable) return;

  for (const columnName of extractBareColumnNames(line)) {
    validateColumnOnTable(primaryTable, columnName, deps.getTableInfo, verifiedColumns, issues, context);
  }
}

function validateJoinPairs(
  line: string,
  state: AnalysisState,
  deps: {
    getTableInfo: (normalizedTableName: string) => TableSchemaInfo | null;
  },
  verifiedJoins: Map<string, ValidationRecord>,
  issues: Map<string, ValidationRecord>,
  context: { lineNumber: number; preview: string; symbolName: string | null }
): void {
  JOIN_PAIR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JOIN_PAIR_PATTERN.exec(line)) !== null) {
    const leftTable = resolveAliasOrTable(match[1]!, state);
    const rightTable = resolveAliasOrTable(match[3]!, state);
    if (!leftTable || !rightTable) continue;

    const leftInfo = deps.getTableInfo(leftTable);
    const rightInfo = deps.getTableInfo(rightTable);
    if (!leftInfo || !rightInfo) continue;

    const leftColumn = normalizeSchemaName(match[2]!);
    const rightColumn = normalizeSchemaName(match[4]!);
    if (!leftInfo.columns.has(leftColumn) || !rightInfo.columns.has(rightColumn)) {
      continue;
    }

    const joinMessage = `${leftInfo.record.name}.${leftInfo.columns.get(leftColumn)} = ${rightInfo.record.name}.${rightInfo.columns.get(rightColumn)}`;
    const hasForeignKey = leftInfo.foreignKeys.some((fk) =>
      fk.normalizedTargetTable === rightInfo.record.normalizedName
        && fk.sourceColumns.length === 1
        && fk.targetColumns.length === 1
        && normalizeSchemaName(fk.sourceColumns[0]!) === leftColumn
        && normalizeSchemaName(fk.targetColumns[0]!) === rightColumn
    ) || rightInfo.foreignKeys.some((fk) =>
      fk.normalizedTargetTable === leftInfo.record.normalizedName
        && fk.sourceColumns.length === 1
        && fk.targetColumns.length === 1
        && normalizeSchemaName(fk.sourceColumns[0]!) === rightColumn
        && normalizeSchemaName(fk.targetColumns[0]!) === leftColumn
    );

    if (hasForeignKey) {
      addRecord(verifiedJoins, `verified-join|${context.lineNumber}|${joinMessage}`, {
        message: `FK-backed join: ${joinMessage}`,
        lineNumber: context.lineNumber,
        preview: context.preview,
        symbolName: context.symbolName,
      });
      continue;
    }

    addRecord(issues, `missing-fk|${context.lineNumber}|${joinMessage}`, {
      message: `Join has no matching foreign key in current schema: ${joinMessage}`,
      lineNumber: context.lineNumber,
      preview: context.preview,
      symbolName: context.symbolName,
    });
  }
}

function validateColumnOnTable(
  normalizedTableName: string,
  columnName: string,
  getTableInfo: (normalizedTableName: string) => TableSchemaInfo | null,
  verifiedColumns: Map<string, ValidationRecord>,
  issues: Map<string, ValidationRecord>,
  context: { lineNumber: number; preview: string; symbolName: string | null }
): void {
  const info = getTableInfo(normalizedTableName);
  if (!info) return;

  const normalizedColumn = normalizeSchemaName(columnName);
  const actualColumnName = info.columns.get(normalizedColumn);
  if (actualColumnName) {
    addRecord(verifiedColumns, `verified-column|${context.lineNumber}|${normalizedTableName}|${normalizedColumn}`, {
      message: `Verified column: ${info.record.name}.${actualColumnName}`,
      lineNumber: context.lineNumber,
      preview: context.preview,
      symbolName: context.symbolName,
    });
    return;
  }

  addRecord(issues, `missing-column|${context.lineNumber}|${normalizedTableName}|${normalizedColumn}`, {
    message: `Missing column in current schema: ${info.record.name}.${columnName}`,
    lineNumber: context.lineNumber,
    preview: context.preview,
    symbolName: context.symbolName,
  });
}

function getTableInfo(
  normalizedTableName: string,
  cache: Map<string, TableSchemaInfo | null>,
  tableRecords: Map<string, DbTableRecord>,
  schemaRepo: NonNullable<SqlValidateDeps['schemaRepo']>
): TableSchemaInfo | null {
  if (cache.has(normalizedTableName)) {
    return cache.get(normalizedTableName) ?? null;
  }

  const record = tableRecords.get(normalizedTableName);
  if (!record) {
    cache.set(normalizedTableName, null);
    return null;
  }

  const columns = new Map(
    schemaRepo.findCurrentColumns(record.id).map((column) => [column.normalizedName, column.name] as const)
  );
  const foreignKeys = schemaRepo.findCurrentOutgoingForeignKeys(record.id);
  const info = { record, columns, foreignKeys };
  cache.set(normalizedTableName, info);
  return info;
}

function extractBareColumnNames(line: string): string[] {
  const names = new Set<string>();

  INSERT_COLUMN_LIST_PATTERN.lastIndex = 0;
  const insertColumns = INSERT_COLUMN_LIST_PATTERN.exec(line);
  if (insertColumns?.[1]) {
    for (const column of insertColumns[1].split(',')) {
      const clean = column.replace(/["'`\s]/g, '');
      if (clean) names.add(clean);
    }
  }

  SET_ASSIGNMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SET_ASSIGNMENT_PATTERN.exec(line)) !== null) {
    names.add(match[1]!);
  }

  WHERE_COLUMN_PATTERN.lastIndex = 0;
  while ((match = WHERE_COLUMN_PATTERN.exec(line)) !== null) {
    names.add(match[1]!);
  }

  QUERY_BUILDER_SET_PATTERN.lastIndex = 0;
  while ((match = QUERY_BUILDER_SET_PATTERN.exec(line)) !== null) {
    names.add(match[2]!);
  }

  return [...names].filter((name) => !RESERVED_ALIAS_WORDS.has(name.toLowerCase()));
}

function createEmptyState(): AnalysisState {
  return {
    aliases: new Map(),
    activeTables: new Set(),
    primaryTable: null,
  };
}

function resolveAliasOrTable(aliasOrTable: string, state: AnalysisState): string | null {
  return state.aliases.get(aliasOrTable.toLowerCase()) ?? null;
}

function registerAlias(aliases: Map<string, string>, alias: string, normalizedTableName: string): void {
  const sanitized = sanitizeAlias(alias);
  if (!sanitized) return;
  aliases.set(sanitized.toLowerCase(), normalizedTableName);
}

function sanitizeAlias(alias: string | null | undefined): string | null {
  if (!alias) return null;
  const trimmed = alias.trim().replace(/["'`]/g, '');
  if (!trimmed) return null;
  if (RESERVED_ALIAS_WORDS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function shouldResetBeforeLine(line: string): boolean {
  return SCOPE_BREAK_PATTERN.test(line);
}

function isStatementBreak(line: string): boolean {
  return STATEMENT_BREAK_PATTERN.test(line) || line.trim() === '';
}

function renderValidationRecords(lines: string[], records: ValidationRecord[], limit: number): void {
  for (const record of records.slice(0, limit)) {
    const symbolPrefix = record.symbolName ? `${record.symbolName} — ` : '';
    lines.push(`- ${symbolPrefix}${record.message} — line ${record.lineNumber}`);
    lines.push(`  ${record.preview}`);
  }

  if (records.length > limit) {
    lines.push(`- ... ${records.length - limit} more`);
  }
}

function addRecord(
  bucket: Map<string, ValidationRecord>,
  key: string,
  record: ValidationRecord
): void {
  if (!bucket.has(key)) {
    bucket.set(key, record);
  }
}

function compareValidationRecords(a: ValidationRecord, b: ValidationRecord): number {
  if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber;
  return a.message.localeCompare(b.message);
}
