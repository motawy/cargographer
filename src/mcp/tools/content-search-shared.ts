import { readFileSync } from 'fs';
import { loadConfig } from '../../config.js';
import { resolveIndexedFilePath } from '../../utils/indexed-path.js';
import type { ToolDeps } from '../types.js';

export interface ContentMatch {
  filePath: string;
  lineNumber: number;
  symbolName: string | null;
  symbolKind: string | null;
  preview: string;
  isTest: boolean;
}

interface FindContentMatchesParams {
  query: string;
  path?: string;
  limit?: number;
  includeTests?: boolean;
  includeSql?: boolean;
}

type ContentSearchDeps = Pick<ToolDeps, 'repoId' | 'repoPath' | 'fileRepo' | 'symbolRepo'>;

export function findContentMatches(
  deps: ContentSearchDeps,
  params: FindContentMatchesParams
): ContentMatch[] {
  const { repoId, repoPath, fileRepo, symbolRepo } = deps;
  if (!repoPath) {
    throw new Error('Repository path is not available for content search.');
  }
  if (!fileRepo) {
    throw new Error('File repository is not available for content search.');
  }

  const limit = Math.max(1, Math.min(params.limit ?? 20, 1000));
  const includeTests = params.includeTests ?? true;
  const includeSql = params.includeSql ?? false;
  const config = loadConfig(repoPath);
  const files = fileRepo.listByRepo(repoId).filter((file) => {
    if (params.path && !file.path.includes(params.path)) return false;
    if (!includeSql && file.language === 'sql') return false;
    if (!includeTests && isTestPath(file.path)) return false;
    return true;
  });

  const queryLower = params.query.toLowerCase();
  const matches: ContentMatch[] = [];

  for (const file of files) {
    const absolutePath = resolveIndexedFilePath(repoPath, file.path, config);
    if (!absolutePath) continue;

    let content: string;
    try {
      content = readFileSync(absolutePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx]!;
      if (!line.toLowerCase().includes(queryLower)) continue;

      const lineNumber = idx + 1;
      const symbol = symbolRepo.findInnermostByFileAndLine(repoId, file.path, lineNumber);
      matches.push({
        filePath: file.path,
        lineNumber,
        symbolName: symbol?.qualifiedName ?? null,
        symbolKind: symbol?.kind ?? null,
        preview: line.trim(),
        isTest: isTestPath(file.path),
      });

      if (matches.length >= limit) {
        return matches;
      }
    }
  }

  return matches;
}

export function isTestPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return /(^|[\\/])(tests?|spec)([\\/]|$)/.test(normalized)
    || /(^|[\\/]).*test\.php$/.test(normalized)
    || /(^|[\\/]).*spec\.[a-z0-9]+$/.test(normalized);
}
