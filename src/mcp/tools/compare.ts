import { readFile } from 'fs/promises';
import { join } from 'path';
import type { ToolDeps } from '../types.js';
import type { SymbolRecord } from '../../db/repositories/symbol-repository.js';
import type { ReferenceRecord } from '../../db/repositories/reference-repository.js';

interface CompareParams {
  symbolA: string;
  symbolB: string;
}

const MAX_INLINE_LINES = 5; // Only inline methods this short or shorter

export async function handleCompare(deps: ToolDeps, params: CompareParams): Promise<string> {
  const { repoId, repoPath, symbolRepo, refRepo } = deps;

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

  // Load references for all children to show what they wire to
  const refsMap = new Map<number, ReferenceRecord[]>();
  for (const child of [...childrenA, ...childrenB]) {
    const refs = await refRepo.findDependencies(child.id);
    if (refs.length > 0) {
      refsMap.set(child.id, refs);
    }
  }

  const namesA = new Set(childrenA.map(c => c.name));
  const namesB = new Set(childrenB.map(c => c.name));

  const onlyInA = childrenA.filter(c => !namesB.has(c.name));
  const onlyInB = childrenB.filter(c => !namesA.has(c.name));
  const shared = childrenA.filter(c => namesB.has(c.name));

  // Pre-load method bodies for delta AND shared methods (short methods only)
  const bodyMap = new Map<number, string>();
  if (repoPath) {
    // Load bodies for all children — delta methods get inlined,
    // shared methods get diffed to flag behavioral differences
    await loadMethodBodies([...childrenA, ...childrenB], repoPath, symbolRepo, bodyMap);
  }

  const lines: string[] = [];
  lines.push(`## Compare: ${symA.qualifiedName} vs ${symB.qualifiedName}\n`);

  lines.push(`### In ${symA.qualifiedName} but NOT in ${symB.qualifiedName}:`);
  if (onlyInA.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of onlyInA) {
      lines.push(formatChild(c, refsMap.get(c.id), bodyMap.get(c.id)));
    }
  }
  lines.push('');

  lines.push(`### In ${symB.qualifiedName} but NOT in ${symA.qualifiedName}:`);
  if (onlyInB.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of onlyInB) {
      lines.push(formatChild(c, refsMap.get(c.id), bodyMap.get(c.id)));
    }
  }
  lines.push('');

  // Shared methods: split into identical vs different implementations
  const sharedIdentical: string[] = [];
  const sharedDifferent: string[] = [];

  for (const c of shared) {
    const refs = refsMap.get(c.id);
    const bChild = childrenB.find(b => b.name === c.name)!;
    const refsB = refsMap.get(bChild.id);
    const refHintA = formatRefHint(refs);
    const refHintB = formatRefHint(refsB);
    const bodyA = bodyMap.get(c.id);
    const bodyB = bodyMap.get(bChild.id);

    // Check if implementations differ (by body or by wiring)
    const wiringDiffers = (refHintA || refHintB) && refHintA !== refHintB;
    const bodyDiffers = bodyA && bodyB && bodyA !== bodyB;

    if (wiringDiffers || bodyDiffers) {
      // Show the difference
      let line = `- **${c.name}()** ⚠ differs`;
      if (wiringDiffers) {
        line += `\n  A: → ${refHintA || '(none)'}\n  B: → ${refHintB || '(none)'}`;
      }
      if (bodyDiffers) {
        line += `\n  A (line ${c.lineStart}):\n  \`\`\`\n  ${bodyA}\n  \`\`\``;
        line += `\n  B (line ${bChild.lineStart}):\n  \`\`\`\n  ${bodyB}\n  \`\`\``;
      } else if (wiringDiffers && !bodyA && !bodyB) {
        // No bodies available but wiring differs — already shown above
      }
      sharedDifferent.push(line);
    } else {
      // Identical or no info to compare
      if (refHintA) {
        sharedIdentical.push(`- ${c.name}() → ${refHintA}`);
      } else {
        sharedIdentical.push(`- ${c.name}()`);
      }
    }
  }

  if (sharedDifferent.length > 0) {
    lines.push(`### Shared — different implementations (${sharedDifferent.length}):`);
    lines.push(...sharedDifferent);
    lines.push('');
  }

  if (sharedIdentical.length > 0) {
    lines.push(`### Shared — identical (${sharedIdentical.length}):`);
    lines.push(...sharedIdentical);
  } else if (sharedDifferent.length === 0 && shared.length > 0) {
    lines.push(`### Shared (${shared.length}):`);
    lines.push('(all identical or no body data available)');
  }

  return lines.join('\n');
}

function formatChild(c: SymbolRecord, refs?: ReferenceRecord[], body?: string): string {
  const vis = c.visibility ? `${c.visibility} ` : '';
  const refHint = formatRefHint(refs);
  const refSuffix = refHint ? ` → ${refHint}` : '';
  // Prefer inline body over signature for short methods
  if (body) {
    return `- ${vis}${c.name}()${refSuffix} (line ${c.lineStart})\n  \`\`\`\n  ${body}\n  \`\`\``;
  }
  const sig = c.signature ? ` → ${c.signature}` : '';
  return `- ${vis}${c.name}${sig}${refSuffix} (line ${c.lineStart})`;
}

function formatRefHint(refs?: ReferenceRecord[]): string | null {
  if (!refs || refs.length === 0) return null;
  // Show class_reference targets (the return Foo::class pattern)
  const classRefs = refs.filter(r => r.referenceKind === 'class_reference');
  if (classRefs.length > 0) {
    return classRefs.map(r => r.targetQualifiedName).join(', ');
  }
  return null;
}

async function loadMethodBodies(
  symbols: SymbolRecord[],
  repoPath: string,
  symbolRepo: ToolDeps['symbolRepo'],
  bodyMap: Map<number, string>
): Promise<void> {
  // Group short methods by fileId to minimize file reads
  const shortMethods = symbols.filter(s => s.lineEnd - s.lineStart <= MAX_INLINE_LINES);
  if (shortMethods.length === 0) return;

  const byFile = new Map<number, SymbolRecord[]>();
  for (const s of shortMethods) {
    const list = byFile.get(s.fileId) || [];
    list.push(s);
    byFile.set(s.fileId, list);
  }

  for (const [fileId, methods] of byFile) {
    const filePath = await symbolRepo.getFilePath(fileId);
    if (!filePath) continue;

    try {
      const fullPath = join(repoPath, filePath);
      const content = await readFile(fullPath, 'utf-8');
      const fileLines = content.split('\n');

      for (const method of methods) {
        // Extract method body (skip the opening line with function signature)
        const bodyLines = fileLines.slice(method.lineStart, method.lineEnd)
          .map(l => l.trim())
          .filter(l => l !== '' && l !== '{' && l !== '}');
        if (bodyLines.length > 0 && bodyLines.length <= 3) {
          bodyMap.set(method.id, bodyLines.join('\n  '));
        }
      }
    } catch {
      // File not accessible — skip silently (e.g., remote DB without local repo)
    }
  }
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
