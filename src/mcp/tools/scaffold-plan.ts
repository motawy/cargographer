import { basename, extname } from 'path';
import type { SymbolRecord } from '../../db/repositories/symbol-repository.js';
import { isTestPath } from '../../utils/test-path.js';
import type { ToolDeps } from '../types.js';
import { analyzeComparison, resolveSymbol } from './compare-shared.js';

interface ScaffoldPlanParams {
  reference: string;
  target: string;
  depth?: number;
}

type ScaffoldPlanDeps = Pick<ToolDeps, 'repoId' | 'repoPath' | 'fileRepo' | 'symbolRepo' | 'refRepo'>;

interface PlannedSymbol {
  sourceSymbol: SymbolRecord;
  sourceFilePath: string;
  targetQualifiedName: string;
  targetFilePath: string;
  depth: number;
  layer: string;
  reasons: string[];
  wiresTo: string[];
  existingSymbol: SymbolRecord | null;
  existingFilePath: string | null;
  compareSummary?: {
    missing: number;
    extra: number;
    differing: number;
  };
}

const STEM_SUFFIXES = [
  'IntegrationTest',
  'APIEntity',
  'DataObject',
  'Repository',
  'Controller',
  'Interface',
  'Builder',
  'Handler',
  'Service',
  'Report',
  'Route',
  'Model',
  'Entity',
  'Page',
  'Test',
] as const;

const PLAN_REFERENCE_KINDS = new Set([
  'class_reference',
  'instantiation',
  'implementation',
  'type_hint',
]);

const LAYER_ORDER = [
  'Route',
  'Controller',
  'Builder',
  'Model',
  'Repository',
  'Service',
  'Handler',
  'DataObject',
  'Entity',
  'Report',
  'Page',
  'Test',
  'Other',
] as const;

export function handleScaffoldPlan(deps: ScaffoldPlanDeps, params: ScaffoldPlanParams): string {
  const { repoId, symbolRepo, refRepo, fileRepo } = deps;
  if (!fileRepo) {
    throw new Error('File repository is not available.');
  }

  const resolved = resolveSymbol(repoId, params.reference, symbolRepo);
  if (!resolved) {
    return `Reference symbol not found: "${params.reference}". Use cartograph_find to search.`;
  }

  const anchor = toTopLevelSymbol(resolved, symbolRepo);
  if (!anchor) {
    return `Could not resolve a top-level symbol for "${params.reference}".`;
  }
  const anchorFilePath = symbolRepo.getFilePath(anchor.fileId);
  if (!anchorFilePath) {
    return `No indexed file path found for "${anchor.qualifiedName ?? anchor.name}".`;
  }

  const sourceStem = inferSourceStem(anchor.name);
  if (!sourceStem) {
    return `Could not infer a renameable stem from "${anchor.name}". Try a Route/Controller/Builder/Model-style class.`;
  }

  const targetStem = inferTargetStem(params.target, sourceStem.suffix);
  if (!targetStem) {
    return `Could not infer a target stem from "${params.target}".`;
  }

  if (normalizeToken(targetStem) === normalizeToken(sourceStem.stem)) {
    return `Target "${params.target}" resolves to the same stem as the reference (${sourceStem.stem}).`;
  }

  const maxDepth = Math.max(1, Math.min(params.depth ?? 4, 6));
  const filePaths = new Set(fileRepo.listByRepo(repoId).map((file) => file.path));
  const sources = collectPlanSources(deps, anchor, anchorFilePath, sourceStem.stem, maxDepth);

  if (sources.length === 0) {
    return `No renameable slice was inferred from "${anchor.qualifiedName ?? anchor.name}".`;
  }

  const planned = sources
    .map((source) => buildPlannedSymbol(deps, source, filePaths, sourceStem.stem, targetStem))
    .sort(comparePlannedSymbols);

  const create = planned.filter((entry) => !entry.existingFilePath);
  const existing = planned.filter((entry) => Boolean(entry.existingFilePath));

  const lines: string[] = [];
  lines.push(`## Scaffold Plan: ${anchor.qualifiedName ?? anchor.name}`);
  lines.push(`- Target stem: ${targetStem}`);
  lines.push(`- Source stem: ${sourceStem.stem}`);
  lines.push(`- Traversal depth: ${maxDepth}`);
  lines.push(`- Reference slice files: ${sources.length}`);
  lines.push(`- Files to create: ${create.length}`);
  lines.push(`- Targets already present: ${existing.length}`);
  lines.push('');

  lines.push('### Files To Create');
  if (create.length === 0) {
    lines.push('No missing files were inferred for this target stem.');
  } else {
    for (const entry of create) {
      renderPlannedSymbol(lines, entry);
    }
  }

  lines.push('');
  lines.push('### Already Exists');
  if (existing.length === 0) {
    lines.push('No existing target files were detected.');
  } else {
    for (const entry of existing) {
      renderPlannedSymbol(lines, entry);
    }
  }

  return lines.join('\n');
}

function collectPlanSources(
  deps: ScaffoldPlanDeps,
  anchor: SymbolRecord,
  anchorFilePath: string,
  sourceStem: string,
  maxDepth: number
): Array<{
  symbol: SymbolRecord;
  filePath: string;
  depth: number;
  reasons: string[];
  targets: Map<number, string[]>;
}> {
  const { symbolRepo, refRepo } = deps;
  const entries = new Map<number, {
    symbol: SymbolRecord;
    filePath: string;
    depth: number;
    reasons: string[];
    targets: Map<number, string[]>;
  }>();

  const queue: Array<{ symbol: SymbolRecord; filePath: string; depth: number }> = [
    { symbol: anchor, filePath: anchorFilePath, depth: 0 },
  ];
  const queuedDepth = new Map<number, number>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const previous = queuedDepth.get(current.symbol.id);
    if (previous !== undefined && previous <= current.depth) {
      continue;
    }
    queuedDepth.set(current.symbol.id, current.depth);

    const existing = entries.get(current.symbol.id);
    if (!existing) {
      entries.set(current.symbol.id, {
        symbol: current.symbol,
        filePath: current.filePath,
        depth: current.depth,
        reasons: current.depth === 0 ? ['anchor symbol'] : [],
        targets: new Map(),
      });
    } else if (existing.depth > current.depth) {
      existing.depth = current.depth;
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    const refs = refRepo.findDependencies(current.symbol.id);
    for (const ref of refs) {
      if (!PLAN_REFERENCE_KINDS.has(ref.referenceKind) || !ref.targetSymbolId) {
        continue;
      }

      const target = toTopLevelSymbol(symbolRepo.findById(ref.targetSymbolId), symbolRepo);
      if (!target || target.id === current.symbol.id) {
        continue;
      }

      const targetFilePath = symbolRepo.getFilePath(target.fileId);
      if (!targetFilePath) {
        continue;
      }

      if (!isRenameableFamilySymbol(target, targetFilePath, sourceStem)) {
        continue;
      }

      const targetEntry = entries.get(target.id) ?? {
        symbol: target,
        filePath: targetFilePath,
        depth: current.depth + 1,
        reasons: [],
        targets: new Map<number, string[]>(),
      };
      targetEntry.depth = Math.min(targetEntry.depth, current.depth + 1);
      targetEntry.reasons = uniqueStrings([
        ...targetEntry.reasons,
        `via ${ref.sourceSymbolName ?? current.symbol.name}() -> ${target.qualifiedName ?? target.name}`,
      ]);
      entries.set(target.id, targetEntry);

      const sourceEntry = entries.get(current.symbol.id)!;
      const wireLabels = sourceEntry.targets.get(target.id) ?? [];
      wireLabels.push(formatWireLabel(ref.sourceSymbolName, ref.referenceKind, target.qualifiedName ?? target.name));
      sourceEntry.targets.set(target.id, uniqueStrings(wireLabels));

      queue.push({
        symbol: target,
        filePath: targetFilePath,
        depth: current.depth + 1,
      });
    }
  }

  const filtered = [...entries.values()].filter((entry) =>
    entry.symbol.id === anchor.id || isRenameableFamilySymbol(entry.symbol, entry.filePath, sourceStem)
  );

  return filtered;
}

function buildPlannedSymbol(
  deps: ScaffoldPlanDeps,
  source: {
    symbol: SymbolRecord;
    filePath: string;
    depth: number;
    reasons: string[];
    targets: Map<number, string[]>;
  },
  filePaths: Set<string>,
  sourceStem: string,
  targetStem: string
): PlannedSymbol {
  const targetQualifiedName = replaceStem(source.symbol.qualifiedName ?? source.symbol.name, sourceStem, targetStem);
  const targetFilePath = replaceStem(source.filePath, sourceStem, targetStem);
  const existingFilePath = filePaths.has(targetFilePath) ? targetFilePath : null;
  const existingSymbol = deps.symbolRepo.findByQualifiedName(deps.repoId, targetQualifiedName);

  const wiresTo = [...source.targets.values()]
    .flat()
    .map((value) => replaceStem(value, sourceStem, targetStem))
    .sort();

  const planned: PlannedSymbol = {
    sourceSymbol: source.symbol,
    sourceFilePath: source.filePath,
    targetQualifiedName,
    targetFilePath,
    depth: source.depth,
    layer: classifyLayer(source.symbol.name, source.filePath),
    reasons: source.reasons,
    wiresTo,
    existingSymbol,
    existingFilePath,
  };

  if (existingSymbol) {
    const analysis = analyzeComparison(deps, source.symbol, existingSymbol);
    planned.compareSummary = {
      missing: analysis.onlyInA.length,
      extra: analysis.onlyInB.length,
      differing: analysis.sharedDifferent.length,
    };
  }

  return planned;
}

function renderPlannedSymbol(lines: string[], entry: PlannedSymbol): void {
  const status = entry.existingFilePath ? 'exists' : 'create';
  lines.push(
    `- ${entry.targetFilePath} — ${entry.targetQualifiedName} (${entry.layer}, ${status}); based on ${entry.sourceSymbol.qualifiedName ?? entry.sourceSymbol.name}`
  );

  const detailLines: string[] = [];
  detailLines.push(`source: ${entry.sourceFilePath}`);
  if (entry.depth > 0) {
    detailLines.push(`depth: ${entry.depth}`);
  }
  if (entry.reasons.length > 0) {
    detailLines.push(`reason: ${entry.reasons.join('; ')}`);
  }
  if (entry.wiresTo.length > 0) {
    detailLines.push(`wire to: ${entry.wiresTo.join('; ')}`);
  }
  if (entry.existingFilePath && !entry.existingSymbol) {
    detailLines.push('status: target file exists, but the planned symbol name was not indexed in it');
  } else if (entry.compareSummary) {
    detailLines.push(
      `gap: missing ${entry.compareSummary.missing}, extra ${entry.compareSummary.extra}, shared diffs ${entry.compareSummary.differing}`
    );
  }

  for (const detail of detailLines) {
    lines.push(`  ${detail}`);
  }
}

function toTopLevelSymbol(
  symbol: SymbolRecord | null,
  symbolRepo: ScaffoldPlanDeps['symbolRepo']
): SymbolRecord | null {
  let current = symbol;
  while (current?.parentSymbolId) {
    current = symbolRepo.findById(current.parentSymbolId);
  }
  return current;
}

function inferSourceStem(name: string): { stem: string; suffix: string | null } | null {
  for (const suffix of STEM_SUFFIXES) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      return {
        stem: name.slice(0, -suffix.length),
        suffix,
      };
    }
  }

  return name ? { stem: name, suffix: null } : null;
}

function inferTargetStem(value: string, suffix: string | null): string {
  const leaf = basename(value.replace(/\\/g, '/'), extname(value));
  if (suffix && leaf.endsWith(suffix) && leaf.length > suffix.length) {
    return leaf.slice(0, -suffix.length);
  }
  return leaf;
}

function isRenameableFamilySymbol(symbol: SymbolRecord, filePath: string, sourceStem: string): boolean {
  if (isTestPath(filePath)) {
    return false;
  }
  return containsStem(symbol.name, sourceStem)
    || containsStem(symbol.qualifiedName ?? '', sourceStem)
    || containsStem(basename(filePath, extname(filePath)), sourceStem);
}

function replaceStem(value: string, sourceStem: string, targetStem: string): string {
  return value.replace(new RegExp(escapeRegExp(sourceStem), 'g'), targetStem);
}

function containsStem(value: string, sourceStem: string): boolean {
  return new RegExp(escapeRegExp(sourceStem), 'i').test(value);
}

function formatWireLabel(sourceSymbolName: string | null, referenceKind: string, targetQualifiedName: string): string {
  const via = sourceSymbolName ? `via ${sourceSymbolName}()` : `via ${referenceKind}`;
  return `${via} -> ${targetQualifiedName}`;
}

function classifyLayer(symbolName: string, filePath: string): string {
  const path = filePath.toLowerCase();
  for (const layer of LAYER_ORDER) {
    if (layer === 'Other') continue;
    if (symbolName.endsWith(layer) || path.includes(`/${layer.toLowerCase()}/`)) {
      return layer;
    }
  }
  return 'Other';
}

function comparePlannedSymbols(a: PlannedSymbol, b: PlannedSymbol): number {
  const layerDiff = layerRank(a.layer) - layerRank(b.layer);
  if (layerDiff !== 0) return layerDiff;
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.targetFilePath.localeCompare(b.targetFilePath);
}

function layerRank(layer: string): number {
  const index = LAYER_ORDER.indexOf(layer as typeof LAYER_ORDER[number]);
  return index === -1 ? LAYER_ORDER.length : index;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
