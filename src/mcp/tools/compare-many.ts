import type { ToolDeps } from '../types.js';
import { analyzeComparison, formatChild, formatSharedDifference, resolveSymbol } from './compare-shared.js';

interface CompareManyParams {
  baseline: string;
  others: string[];
}

export function handleCompareMany(deps: ToolDeps, params: CompareManyParams): string {
  const { repoId, symbolRepo } = deps;
  const baseline = resolveSymbol(repoId, params.baseline, symbolRepo);
  if (!baseline) {
    return `Baseline symbol not found: "${params.baseline}". Use cartograph_find to search.`;
  }

  const targetNames = [...new Set(params.others.map((name) => name.trim()).filter(Boolean))];
  if (targetNames.length === 0) {
    return 'No comparison targets were provided.';
  }

  const lines: string[] = [];
  lines.push(`## Compare Many: ${baseline.qualifiedName}`);
  lines.push(`Compared against ${targetNames.length} symbol${targetNames.length === 1 ? '' : 's'}.\n`);

  const missingEverywhere = new Map<string, number>();

  for (const targetName of targetNames) {
    const target = resolveSymbol(repoId, targetName, symbolRepo);
    lines.push(`### vs ${targetName}`);

    if (!target) {
      lines.push(`- Symbol not found.`);
      lines.push('');
      continue;
    }

    const analysis = analyzeComparison(deps, baseline, target);
    const missing = analysis.onlyInA.map((entry) => entry.symbol.name);
    const extra = analysis.onlyInB.map((entry) => entry.symbol.name);
    const differing = analysis.sharedDifferent.map((entry) => {
      const reasons: string[] = [];
      if (entry.wiringDiffers) reasons.push('wiring');
      if (entry.bodyDiffers) reasons.push('body');
      return reasons.length > 0
        ? `${entry.name} (${reasons.join(', ')})`
        : entry.name;
    });

    for (const name of missing) {
      missingEverywhere.set(name, (missingEverywhere.get(name) ?? 0) + 1);
    }

    lines.push(`- Resolved target: ${target.qualifiedName}`);
    lines.push(`- Missing from target compared to baseline (${missing.length}): ${formatNameList(missing)}`);
    if (analysis.onlyInA.length > 0) {
      lines.push('- Baseline implementations for missing methods:');
      for (const entry of analysis.onlyInA) {
        lines.push(indentBlock(formatChild(entry), 2));
      }
    }
    lines.push(`- Extra in target (${extra.length}): ${formatNameList(extra)}`);
    lines.push(`- Shared methods with different implementations (${differing.length}): ${formatNameList(differing)}`);
    if (analysis.sharedDifferent.length > 0) {
      lines.push('- Shared method diffs:');
      for (const entry of analysis.sharedDifferent) {
        lines.push(indentBlock(formatSharedDifference(entry, 'Baseline', 'Target'), 2));
      }
    }
    lines.push('');
  }

  const missingInAll = [...missingEverywhere.entries()]
    .filter(([, count]) => count === targetNames.length)
    .map(([name]) => name)
    .sort();

  if (missingInAll.length > 0) {
    lines.push(`### Missing From Every Compared Target (${missingInAll.length})`);
    for (const name of missingInAll) {
      lines.push(`- ${name}`);
    }
  }

  return lines.join('\n');
}

function formatNameList(names: string[]): string {
  return names.length > 0 ? names.join(', ') : '(none)';
}

function indentBlock(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
