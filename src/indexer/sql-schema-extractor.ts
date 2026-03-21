import { readFileSync } from 'fs';
import type { ParsedDbColumn, ParsedDbForeignKey, ParsedDbTable } from '../types.js';
import { normalizeSchemaName } from '../db/repositories/db-schema-repository.js';

interface StatementMatch {
  tableName: string;
  body: string;
  statementStart: number;
  statementEnd: number;
  bodyStart: number;
}

interface PartSegment {
  text: string;
  offset: number;
}

const TABLE_CONSTRAINT_PREFIXES = [
  'constraint',
  'foreign key',
  'primary key',
  'unique',
  'check',
  'index',
  'key',
];

const COLUMN_STOP_WORDS = new Set([
  'constraint',
  'not',
  'null',
  'default',
  'primary',
  'unique',
  'references',
  'check',
  'collate',
  'generated',
  'comment',
]);

export function extractSqlSchema(filePath: string): ParsedDbTable[] {
  const source = readFileSync(filePath, 'utf-8');
  return extractSqlSchemaFromSource(source);
}

export function extractSqlSchemaFromSource(source: string): ParsedDbTable[] {
  const stripped = stripSqlComments(source);
  const statements = findCreateTableStatements(stripped);

  return statements.map((statement) => parseCreateTableStatement(stripped, statement));
}

function parseCreateTableStatement(source: string, statement: StatementMatch): ParsedDbTable {
  const parts = splitTopLevel(statement.body, ',');
  const columns: ParsedDbColumn[] = [];
  const foreignKeys: ParsedDbForeignKey[] = [];

  for (const part of parts) {
    const trimmed = part.text.trim();
    if (!trimmed) continue;

    if (isTableConstraint(trimmed)) {
      const tableForeignKey = parseTableLevelForeignKey(trimmed, source, statement.bodyStart + part.offset);
      if (tableForeignKey) {
        foreignKeys.push(tableForeignKey);
      }
      continue;
    }

    const parsedColumn = parseColumnDefinition(trimmed, columns.length + 1, source, statement.bodyStart + part.offset);
    if (!parsedColumn) continue;

    columns.push(parsedColumn.column);
    if (parsedColumn.inlineForeignKey) {
      foreignKeys.push(parsedColumn.inlineForeignKey);
    }
  }

  return {
    name: statement.tableName,
    normalizedName: normalizeSchemaName(statement.tableName),
    lineStart: lineNumberAt(source, statement.statementStart),
    lineEnd: lineNumberAt(source, statement.statementEnd),
    columns,
    foreignKeys,
  };
}

function isTableConstraint(part: string): boolean {
  const lowered = part.trim().toLowerCase();
  return TABLE_CONSTRAINT_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

function parseColumnDefinition(
  definition: string,
  ordinalPosition: number,
  source: string,
  offset: number
): { column: ParsedDbColumn; inlineForeignKey: ParsedDbForeignKey | null } | null {
  const trimmed = definition.trim();
  if (!trimmed) return null;

  const columnNameMatch = trimmed.match(/^([`"\[]?[A-Za-z0-9_.]+[`"\]]?)/);
  if (!columnNameMatch) return null;

  const columnName = unquoteIdentifier(columnNameMatch[1]);
  const remainder = trimmed.substring(columnNameMatch[0].length).trim();
  const lowerRemainder = remainder.toLowerCase();

  const typeMatch = remainder.match(/^(.+?)(?=\s+(?:constraint|not|null|default|primary|unique|references|check|collate|generated|comment)\b|$)/i);
  const dataType = typeMatch ? typeMatch[1].trim() : null;

  const isNullable = !/\bnot\s+null\b/i.test(lowerRemainder);
  const defaultMatch = remainder.match(/\bdefault\s+(.+?)(?=\s+(?:constraint|not|null|primary|unique|references|check|collate|generated|comment)\b|$)/i);
  const defaultValue = defaultMatch ? defaultMatch[1].trim() : null;

  const inlineForeignKey = parseInlineForeignKey(trimmed, columnName, source, offset);

  return {
    column: {
      name: columnName,
      normalizedName: normalizeSchemaName(columnName),
      dataType,
      isNullable,
      defaultValue,
      ordinalPosition,
      lineNumber: lineNumberAt(source, firstMeaningfulOffset(source, offset)),
    },
    inlineForeignKey,
  };
}

function parseInlineForeignKey(
  definition: string,
  columnName: string,
  source: string,
  offset: number
): ParsedDbForeignKey | null {
  const match = definition.match(/\breferences\s+([`"\[]?[A-Za-z0-9_.]+[`"\]]?)\s*\(([^)]+)\)/i);
  if (!match) return null;

  return {
    constraintName: null,
    sourceColumns: [columnName],
    targetTable: unquoteIdentifier(match[1]),
    normalizedTargetTable: normalizeSchemaName(match[1]),
    targetColumns: splitIdentifierList(match[2]),
    lineNumber: lineNumberAt(source, firstMeaningfulOffset(source, offset)),
  };
}

function parseTableLevelForeignKey(
  definition: string,
  source: string,
  offset: number
): ParsedDbForeignKey | null {
  const match = definition.match(
    /^(?:constraint\s+([`"\[]?[A-Za-z0-9_.]+[`"\]]?)\s+)?foreign\s+key\s*\(([^)]+)\)\s+references\s+([`"\[]?[A-Za-z0-9_.]+[`"\]]?)\s*\(([^)]+)\)/i
  );
  if (!match) return null;

  return {
    constraintName: match[1] ? unquoteIdentifier(match[1]) : null,
    sourceColumns: splitIdentifierList(match[2]),
    targetTable: unquoteIdentifier(match[3]),
    normalizedTargetTable: normalizeSchemaName(match[3]),
    targetColumns: splitIdentifierList(match[4]),
    lineNumber: lineNumberAt(source, firstMeaningfulOffset(source, offset)),
  };
}

function findCreateTableStatements(source: string): StatementMatch[] {
  const matches: StatementMatch[] = [];
  const createRegex = /create\s+table\s+(?:if\s+not\s+exists\s+)?/ig;

  for (;;) {
    const match = createRegex.exec(source);
    if (!match) break;

    let cursor = match.index + match[0].length;
    cursor = skipWhitespace(source, cursor);

    const tableNameStart = cursor;
    while (cursor < source.length && source[cursor] !== '(') {
      cursor++;
    }

    if (cursor >= source.length) {
      continue;
    }

    const rawTableName = source.substring(tableNameStart, cursor).trim();
    const bodyStart = cursor + 1;
    const bodyEnd = findMatchingParen(source, cursor);
    if (bodyEnd === -1) {
      continue;
    }

    matches.push({
      tableName: unquoteIdentifier(rawTableName),
      body: source.substring(bodyStart, bodyEnd),
      statementStart: match.index,
      statementEnd: bodyEnd,
      bodyStart,
    });
  }

  return matches;
}

function splitTopLevel(input: string, separator: string): PartSegment[] {
  const segments: PartSegment[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;

  for (let idx = 0; idx < input.length; idx++) {
    const char = input[idx];

    if (quote) {
      if (char === quote && input[idx - 1] !== '\\') {
        quote = null;
      }
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(') depth++;
    if (char === ')') depth--;

    if (char === separator && depth === 0) {
      segments.push({
        text: input.substring(start, idx),
        offset: start,
      });
      start = idx + 1;
    }
  }

  if (start <= input.length) {
    segments.push({
      text: input.substring(start),
      offset: start,
    });
  }

  return segments;
}

function findMatchingParen(input: string, openIdx: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let idx = openIdx; idx < input.length; idx++) {
    const char = input[idx];

    if (quote) {
      if (char === quote && input[idx - 1] !== '\\') {
        quote = null;
      }
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(') depth++;
    if (char === ')') {
      depth--;
      if (depth === 0) return idx;
    }
  }

  return -1;
}

function stripSqlComments(source: string): string {
  let result = source;
  result = result.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
  result = result.replace(/--.*$/gm, (match) => ' '.repeat(match.length));
  return result;
}

function splitIdentifierList(input: string): string[] {
  return input
    .split(',')
    .map((part) => unquoteIdentifier(part))
    .filter(Boolean);
}

function unquoteIdentifier(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  return trimmed
    .split('.')
    .map((part) => part.trim().replace(/^[`"\[]+|[`"\]]+$/g, ''))
    .join('.');
}

function skipWhitespace(input: string, idx: number): number {
  let cursor = idx;
  while (cursor < input.length && /\s/.test(input[cursor]!)) {
    cursor++;
  }
  return cursor;
}

function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  for (let idx = 0; idx < offset; idx++) {
    if (source[idx] === '\n') {
      line++;
    }
  }
  return line;
}

function firstMeaningfulOffset(source: string, offset: number): number {
  let cursor = offset;
  while (cursor < source.length && /\s/.test(source[cursor]!)) {
    cursor++;
  }
  return cursor;
}
