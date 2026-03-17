import type { ToolDeps, DependentRow } from '../types.js';

interface DependentsParams {
  symbol: string;
  depth?: number;
}

export async function handleDependents(deps: ToolDeps, params: DependentsParams): Promise<string> {
  const { repoId, symbolRepo, refRepo } = deps;
  const depth = Math.max(1, Math.min(params.depth ?? 1, 5));

  const symbol = await symbolRepo.findByQualifiedName(repoId, params.symbol);
  if (!symbol) {
    return `Symbol not found: "${params.symbol}". Use cartograph_find to search.`;
  }

  const results = (await refRepo.findDependents(symbol.id, depth)) as unknown as DependentRow[];

  if (results.length === 0) {
    return `No dependents found for ${symbol.qualifiedName}.`;
  }

  // Group by file path
  const byFile = new Map<string, { qualifiedName: string; kind: string; line: number | null }[]>();
  for (const row of results) {
    const entry = {
      qualifiedName: row.source_qualified_name,
      kind: row.reference_kind,
      line: row.line_number,
    };
    const list = byFile.get(row.source_file_path) || [];
    list.push(entry);
    byFile.set(row.source_file_path, list);
  }

  const lines: string[] = [];
  lines.push(`## Dependents: ${symbol.qualifiedName} (depth ${depth})\n`);
  lines.push(`Found ${results.length} reference${results.length === 1 ? '' : 's'} across ${byFile.size} file${byFile.size === 1 ? '' : 's'}:\n`);

  for (const [filePath, entries] of byFile) {
    lines.push(`### ${filePath}`);
    for (const entry of entries) {
      const lineRef = entry.line ? `, line ${entry.line}` : '';
      lines.push(`- ${entry.qualifiedName} (${entry.kind}${lineRef})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
