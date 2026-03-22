import type { ToolDeps } from '../types.js';
import { analyzeComparison, formatChild, formatSharedDifference, resolveSymbol } from './compare-shared.js';

interface CompareParams {
  symbolA: string;
  symbolB: string;
  omitIdentical?: boolean;
}

export function handleCompare(deps: ToolDeps, params: CompareParams): string {
  const { repoId, symbolRepo } = deps;

  const symA = resolveSymbol(repoId, params.symbolA, symbolRepo);
  if (!symA) {
    return `Symbol A not found: "${params.symbolA}". Use cartograph_find to search.`;
  }

  const symB = resolveSymbol(repoId, params.symbolB, symbolRepo);
  if (!symB) {
    return `Symbol B not found: "${params.symbolB}". Use cartograph_find to search.`;
  }

  const analysis = analyzeComparison(deps, symA, symB);
  const omitIdentical = params.omitIdentical ?? false;

  const lines: string[] = [];
  lines.push(`## Compare: ${symA.qualifiedName} vs ${symB.qualifiedName}\n`);

  lines.push(`### In ${symA.qualifiedName} but NOT in ${symB.qualifiedName}:`);
  if (analysis.onlyInA.length === 0) {
    lines.push('(none)');
  } else {
    for (const child of analysis.onlyInA) {
      lines.push(formatChild(child));
    }
  }
  lines.push('');

  lines.push(`### In ${symB.qualifiedName} but NOT in ${symA.qualifiedName}:`);
  if (analysis.onlyInB.length === 0) {
    lines.push('(none)');
  } else {
    for (const child of analysis.onlyInB) {
      lines.push(formatChild(child));
    }
  }
  lines.push('');

  const sharedIdentical = analysis.sharedIdentical.map((entry) =>
    entry.refHintA ? `- ${entry.name}() \u2192 ${entry.refHintA}` : `- ${entry.name}()`
  );
  const sharedDifferent = analysis.sharedDifferent.map((entry) => formatSharedDifference(entry));

  if (sharedDifferent.length > 0) {
    lines.push(`### Shared \u2014 different implementations (${sharedDifferent.length}):`);
    lines.push(...sharedDifferent);
    lines.push('');
  }

  if (!omitIdentical && sharedIdentical.length > 0) {
    lines.push(`### Shared \u2014 identical (${sharedIdentical.length}):`);
    lines.push(...sharedIdentical);
  } else if (!omitIdentical && sharedDifferent.length === 0 && analysis.sharedIdentical.length > 0) {
    lines.push(`### Shared (${analysis.sharedIdentical.length}):`);
    lines.push('(all identical or no body data available)');
  }

  return lines.join('\n');
}
