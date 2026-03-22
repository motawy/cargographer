import { readFileSync } from 'fs';
import { loadConfig } from '../../config.js';
import { resolveIndexedFilePath } from '../../utils/indexed-path.js';
import type { ToolDeps } from '../types.js';
import type { SymbolRecord } from '../../db/repositories/symbol-repository.js';
import type { ReferenceRecord } from '../../db/repositories/reference-repository.js';

const MAX_INLINE_METHOD_SPAN = 40;
const MAX_INLINE_BODY_LINES = 8;

export interface ComparedChild {
  symbol: SymbolRecord;
  refs?: ReferenceRecord[];
  body?: string;
}

export interface SharedComparison {
  name: string;
  childA: SymbolRecord;
  childB: SymbolRecord;
  refHintA: string | null;
  refHintB: string | null;
  bodyA?: string;
  bodyB?: string;
  wiringDiffers: boolean;
  bodyDiffers: boolean;
}

export interface CompareAnalysis {
  symbolA: SymbolRecord;
  symbolB: SymbolRecord;
  onlyInA: ComparedChild[];
  onlyInB: ComparedChild[];
  sharedIdentical: SharedComparison[];
  sharedDifferent: SharedComparison[];
}

type CompareDeps = Pick<ToolDeps, 'repoId' | 'repoPath' | 'symbolRepo' | 'refRepo'>;

export function resolveSymbol(
  repoId: number,
  name: string,
  symbolRepo: ToolDeps['symbolRepo']
): SymbolRecord | null {
  const exact = symbolRepo.findByQualifiedName(repoId, name);
  if (exact) return exact;

  const escapedName = name.replace(/\\/g, '\\\\');
  const results = symbolRepo.search(repoId, `%${escapedName}`, undefined, 1);
  return results.length > 0 ? results[0] : null;
}

export function analyzeComparison(
  deps: CompareDeps,
  symbolA: SymbolRecord,
  symbolB: SymbolRecord
): CompareAnalysis {
  const { repoPath, symbolRepo, refRepo } = deps;

  const childrenA = symbolRepo.findChildren(symbolA.id);
  const childrenB = symbolRepo.findChildren(symbolB.id);

  const refsMap = new Map<number, ReferenceRecord[]>();
  for (const child of [...childrenA, ...childrenB]) {
    const refs = refRepo.findDependencies(child.id);
    if (refs.length > 0) refsMap.set(child.id, refs);
  }

  const namesA = new Set(childrenA.map((child) => child.name));
  const namesB = new Set(childrenB.map((child) => child.name));

  const bodyMap = new Map<number, string>();
  if (repoPath) {
    loadMethodBodies([...childrenA, ...childrenB], repoPath, symbolRepo, bodyMap);
  }

  const onlyInA = childrenA
    .filter((child) => !namesB.has(child.name))
    .map((child) => ({
      symbol: child,
      refs: refsMap.get(child.id),
      body: bodyMap.get(child.id),
    }));

  const onlyInB = childrenB
    .filter((child) => !namesA.has(child.name))
    .map((child) => ({
      symbol: child,
      refs: refsMap.get(child.id),
      body: bodyMap.get(child.id),
    }));

  const sharedIdentical: SharedComparison[] = [];
  const sharedDifferent: SharedComparison[] = [];

  for (const childA of childrenA.filter((child) => namesB.has(child.name))) {
    const childB = childrenB.find((candidate) => candidate.name === childA.name);
    if (!childB) continue;

    const refHintA = formatRefHint(refsMap.get(childA.id));
    const refHintB = formatRefHint(refsMap.get(childB.id));
    const bodyA = bodyMap.get(childA.id);
    const bodyB = bodyMap.get(childB.id);
    const wiringDiffers = (refHintA || refHintB) && refHintA !== refHintB;
    const bodyDiffers = Boolean(bodyA && bodyB && bodyA !== bodyB);

    const entry: SharedComparison = {
      name: childA.name,
      childA,
      childB,
      refHintA,
      refHintB,
      bodyA,
      bodyB,
      wiringDiffers: Boolean(wiringDiffers),
      bodyDiffers,
    };

    if (entry.wiringDiffers || entry.bodyDiffers) {
      sharedDifferent.push(entry);
    } else {
      sharedIdentical.push(entry);
    }
  }

  return {
    symbolA,
    symbolB,
    onlyInA,
    onlyInB,
    sharedIdentical,
    sharedDifferent,
  };
}

export function formatChild(child: ComparedChild): string {
  const vis = child.symbol.visibility ? `${child.symbol.visibility} ` : '';
  const refHint = formatRefHint(child.refs);
  const refSuffix = refHint ? ` -> ${refHint}` : '';
  if (child.body) {
    return `- ${vis}${child.symbol.name}()${refSuffix} (line ${child.symbol.lineStart})\n  \`\`\`\n  ${child.body}\n  \`\`\``;
  }
  const sig = child.symbol.signature ? ` -> ${child.symbol.signature}` : '';
  return `- ${vis}${child.symbol.name}${sig}${refSuffix} (line ${child.symbol.lineStart})`;
}

export function formatRefHint(refs?: ReferenceRecord[]): string | null {
  if (!refs || refs.length === 0) return null;
  const classRefs = refs.filter((ref) => ref.referenceKind === 'class_reference');
  if (classRefs.length > 0) {
    return classRefs.map((ref) => ref.targetQualifiedName).join(', ');
  }
  return null;
}

export function formatSharedDifference(
  entry: SharedComparison,
  labelA = 'A',
  labelB = 'B'
): string {
  let line = `- **${entry.name}()** differs`;
  if (entry.wiringDiffers) {
    line += `\n  ${labelA}: -> ${entry.refHintA || '(none)'}`;
    line += `\n  ${labelB}: -> ${entry.refHintB || '(none)'}`;
  }
  if (entry.bodyDiffers) {
    line += `\n  ${labelA} (line ${entry.childA.lineStart}):\n  \`\`\`\n  ${entry.bodyA}\n  \`\`\``;
    line += `\n  ${labelB} (line ${entry.childB.lineStart}):\n  \`\`\`\n  ${entry.bodyB}\n  \`\`\``;
  }
  return line;
}

function loadMethodBodies(
  symbols: SymbolRecord[],
  repoPath: string,
  symbolRepo: ToolDeps['symbolRepo'],
  bodyMap: Map<number, string>
): void {
  const shortMethods = symbols.filter((symbol) =>
    symbol.kind === 'method' && symbol.lineEnd - symbol.lineStart <= MAX_INLINE_METHOD_SPAN
  );
  if (shortMethods.length === 0) return;

  const config = loadConfig(repoPath);
  const byFile = new Map<number, SymbolRecord[]>();
  for (const symbol of shortMethods) {
    const list = byFile.get(symbol.fileId) || [];
    list.push(symbol);
    byFile.set(symbol.fileId, list);
  }

  for (const [fileId, methods] of byFile) {
    const indexedPath = symbolRepo.getFilePath(fileId);
    if (!indexedPath) continue;

    const absolutePath = resolveIndexedFilePath(repoPath, indexedPath, config);
    if (!absolutePath) continue;

    try {
      const content = readFileSync(absolutePath, 'utf-8');
      const fileLines = content.split('\n');

      for (const method of methods) {
        const bodyLines = fileLines
          .slice(method.lineStart, method.lineEnd)
          .map((line) => line.trim())
          .filter((line) => line !== '' && line !== '{' && line !== '}');
        if (bodyLines.length > 0) {
          const previewLines = bodyLines.slice(0, MAX_INLINE_BODY_LINES);
          if (bodyLines.length > MAX_INLINE_BODY_LINES) {
            previewLines.push('...');
          }
          bodyMap.set(method.id, previewLines.join('\n  '));
        }
      }
    } catch {
      // If the source file is unavailable locally, skip inline body extraction.
    }
  }
}
