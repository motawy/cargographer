import { readFileSync } from 'fs';
import { loadConfig } from '../config.js';
import type { FileRepository } from '../db/repositories/file-repository.js';
import { normalizeSchemaName } from '../db/repositories/db-schema-repository.js';
import type { SymbolRepository } from '../db/repositories/symbol-repository.js';
import type { CartographConfig } from '../types.js';
import { resolveIndexedFilePath } from '../utils/indexed-path.js';
import { findCandidateTablesInLine, findReferencedTablesInLine, type DirectTableReferenceKind } from '../utils/direct-table-reference.js';
import { isTestPath } from '../utils/test-path.js';

export interface ScannedDirectTableReference {
  sourceFileId: number;
  sourceSymbolId: number | null;
  filePath: string;
  symbolName: string | null;
  symbolKind: string | null;
  tableName: string;
  normalizedTableName: string;
  referenceKind: DirectTableReferenceKind;
  lineNumber: number;
  preview: string;
  isTest: boolean;
}

interface ScanDirectTableReferencesParams {
  repoId: number;
  repoPath: string;
  fileRepo: FileRepository;
  symbolRepo: SymbolRepository;
  tableNames: string[];
  config?: Pick<CartographConfig, 'additionalSources'>;
}

export function scanDirectTableReferences(
  params: ScanDirectTableReferencesParams
): ScannedDirectTableReference[] {
  const { repoId, repoPath, fileRepo, symbolRepo, tableNames } = params;
  if (tableNames.length === 0) {
    return [];
  }

  const config = params.config ?? loadConfig(repoPath);
  const files = fileRepo.listByRepo(repoId).filter((file) => file.language !== 'sql');
  const tableNamesByNormalized = new Map(
    tableNames.map((tableName) => [normalizeSchemaName(tableName), tableName] as const)
  );
  const matches: ScannedDirectTableReference[] = [];

  for (const file of files) {
    const absolutePath = resolveIndexedFilePath(repoPath, file.path, config);
    if (!absolutePath) {
      continue;
    }

    let content: string;
    try {
      content = readFileSync(absolutePath, 'utf-8');
    } catch {
      continue;
    }

    const isTest = isTestPath(file.path);
    const lines = content.split('\n');
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx]!;
      if (findCandidateTablesInLine(line, tableNamesByNormalized).length === 0) {
        continue;
      }

      const lineNumber = idx + 1;
      const symbol = symbolRepo.findInnermostByFileAndLine(repoId, file.path, lineNumber);
      const lineMatches = findReferencedTablesInLine(line, tableNamesByNormalized, {
        isTest,
        symbolName: symbol?.qualifiedName ?? null,
      });

      for (const match of lineMatches) {
        matches.push({
          sourceFileId: file.id,
          sourceSymbolId: symbol?.id ?? null,
          filePath: file.path,
          symbolName: symbol?.qualifiedName ?? null,
          symbolKind: symbol?.kind ?? null,
          tableName: match.tableName,
          normalizedTableName: match.normalizedTableName,
          referenceKind: match.referenceKind,
          lineNumber,
          preview: line.trim(),
          isTest,
        });
      }
    }
  }

  return matches;
}
