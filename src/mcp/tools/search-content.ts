import type { ToolDeps } from '../types.js';
import { findContentMatches } from './content-search-shared.js';

interface SearchContentParams {
  query: string;
  path?: string;
  limit?: number;
}

type SearchContentDeps = Pick<ToolDeps, 'repoId' | 'repoPath' | 'fileRepo' | 'symbolRepo'>;

export function handleSearchContent(deps: SearchContentDeps, params: SearchContentParams): string {
  const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
  const matches = findContentMatches(deps, { query: params.query, path: params.path, limit });

  if (matches.length === 0) {
    if (params.path) {
      return `No indexed content matches "${params.query}" in path "${params.path}".`;
    }
    return `No indexed content matches "${params.query}".`;
  }

  const lines: string[] = [];
  lines.push(`## Content Search: "${params.query}"`);
  lines.push(`- Matches: ${matches.length}`);
  if (params.path) {
    lines.push(`- Path filter: ${params.path}`);
  }
  lines.push('');

  for (const match of matches) {
    const owner = match.symbolName
      ? `${match.symbolName}${match.symbolKind ? ` (${match.symbolKind})` : ''}`
      : 'No enclosing symbol';
    lines.push(`- ${owner}`);
    lines.push(`  ${match.filePath}:${match.lineNumber}`);
    lines.push(`  ${match.preview}`);
  }

  if (matches.length === limit) {
    lines.push('');
    lines.push('Limit reached. Refine with `path` or increase `limit` if needed.');
  }

  return lines.join('\n');
}
