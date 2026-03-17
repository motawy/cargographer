import type { ToolDeps, DependentRow } from '../types.js';

interface BlastRadiusParams {
  file: string;
  depth?: number;
}

export async function handleBlastRadius(deps: ToolDeps, params: BlastRadiusParams): Promise<string> {
  const { repoId, symbolRepo, refRepo } = deps;
  const depth = Math.max(1, Math.min(params.depth ?? 2, 5));

  const fileSymbols = await symbolRepo.findByFilePath(repoId, params.file);
  if (fileSymbols.length === 0) {
    return `File not found in index: "${params.file}". Paths are relative to repo root.`;
  }

  // Collect all dependents across all symbols in the file
  const allDependents = new Map<string, { qualifiedName: string; filePath: string }>();

  for (const sym of fileSymbols) {
    const results = (await refRepo.findDependents(sym.id, depth)) as unknown as DependentRow[];
    for (const row of results) {
      if (row.source_qualified_name && !allDependents.has(row.source_qualified_name)) {
        allDependents.set(row.source_qualified_name, {
          qualifiedName: row.source_qualified_name,
          filePath: row.source_file_path,
        });
      }
    }
  }

  if (allDependents.size === 0) {
    return `No external dependents found for ${params.file}.`;
  }

  // Group by file, sort by count descending
  const byFile = new Map<string, string[]>();
  for (const dep of allDependents.values()) {
    const list = byFile.get(dep.filePath) || [];
    list.push(dep.qualifiedName);
    byFile.set(dep.filePath, list);
  }

  const sorted = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);

  const lines: string[] = [];
  lines.push(`## Blast radius: ${params.file}\n`);
  lines.push(`Symbols in file: ${fileSymbols.length}`);
  lines.push(`Affected symbols: ${allDependents.size} across ${byFile.size} file${byFile.size === 1 ? '' : 's'}\n`);

  const MAX_FILES = 10;
  const shown = sorted.slice(0, MAX_FILES);
  const remaining = sorted.slice(MAX_FILES);

  for (const [filePath, symbols] of shown) {
    lines.push(`### ${filePath} (${symbols.length} symbol${symbols.length === 1 ? '' : 's'} affected)`);
    for (const sym of symbols) {
      const shortName = sym.split('\\').pop() ?? sym;
      lines.push(`→ ${shortName}`);
    }
    lines.push('');
  }

  if (remaining.length > 0) {
    const remainingCount = remaining.reduce((sum, [, syms]) => sum + syms.length, 0);
    lines.push(`... and ${remaining.length} more file${remaining.length === 1 ? '' : 's'} (${remainingCount} symbols)`);
  }

  return lines.join('\n');
}
