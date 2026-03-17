import type { ToolDeps } from '../types.js';
import type { SymbolRecord } from '../../db/repositories/symbol-repository.js';

interface CompareParams {
  symbolA: string;
  symbolB: string;
}

export async function handleCompare(deps: ToolDeps, params: CompareParams): Promise<string> {
  const { repoId, symbolRepo } = deps;

  const symA = await resolveSymbol(repoId, params.symbolA, symbolRepo);
  if (!symA) {
    return `Symbol A not found: "${params.symbolA}". Use cartograph_find to search.`;
  }

  const symB = await resolveSymbol(repoId, params.symbolB, symbolRepo);
  if (!symB) {
    return `Symbol B not found: "${params.symbolB}". Use cartograph_find to search.`;
  }

  const childrenA = await symbolRepo.findChildren(symA.id);
  const childrenB = await symbolRepo.findChildren(symB.id);

  const namesA = new Set(childrenA.map(c => c.name));
  const namesB = new Set(childrenB.map(c => c.name));

  const onlyInA = childrenA.filter(c => !namesB.has(c.name));
  const onlyInB = childrenB.filter(c => !namesA.has(c.name));
  const shared = childrenA.filter(c => namesB.has(c.name));

  const lines: string[] = [];
  lines.push(`## Compare: ${symA.qualifiedName} vs ${symB.qualifiedName}\n`);

  lines.push(`### In ${symA.qualifiedName} but NOT in ${symB.qualifiedName}:`);
  if (onlyInA.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of onlyInA) {
      lines.push(formatChild(c));
    }
  }
  lines.push('');

  lines.push(`### In ${symB.qualifiedName} but NOT in ${symA.qualifiedName}:`);
  if (onlyInB.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of onlyInB) {
      lines.push(formatChild(c));
    }
  }
  lines.push('');

  lines.push(`### Shared (${shared.length}):`);
  for (const c of shared) {
    lines.push(`- ${c.name}()`);
  }

  return lines.join('\n');
}

function formatChild(c: SymbolRecord): string {
  const sig = c.signature ? ` → ${c.signature}` : '';
  const vis = c.visibility ? `${c.visibility} ` : '';
  return `- ${vis}${c.name}${sig} (line ${c.lineStart})`;
}

async function resolveSymbol(
  repoId: number,
  name: string,
  symbolRepo: ToolDeps['symbolRepo']
): Promise<SymbolRecord | null> {
  // Try exact match first
  const exact = await symbolRepo.findByQualifiedName(repoId, name);
  if (exact) return exact;

  // Suffix fallback
  const escapedName = name.replace(/\\/g, '\\\\');
  const results = await symbolRepo.search(repoId, `%${escapedName}`, undefined, 1);
  return results.length > 0 ? results[0] : null;
}
