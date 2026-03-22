import type { ReferenceRecord } from '../../db/repositories/reference-repository.js';
import type { ToolDeps, RepoStats, DependentRow } from '../types.js';

interface SymbolParams {
  name: string;
  deep?: boolean;
}

interface ContextRequirementEntry {
  key: string;
  method: string;
  ownerQualifiedName: string;
  depth: number;
}

export function handleSymbol(deps: ToolDeps, stats: RepoStats, params: SymbolParams): string {
  const { repoId, symbolRepo, refRepo } = deps;
  const { name } = params;

  // Search with suffix pattern — works for both exact qualified names and short names.
  const searchResults = symbolRepo.search(repoId, `%${name}`, undefined, 10);
  let matches: { symbol: (typeof searchResults)[0]; filePath: string }[] = [];

  if (searchResults.length === 0) {
    const suggestions = symbolRepo.suggestSymbols(repoId, name);
    if (suggestions.length > 0) {
      return `Symbol not found: "${name}". Use cartograph_find to search.\n\nDid you mean:\n${suggestions.map((suggestion) =>
        `- ${suggestion.qualifiedName ?? suggestion.name} (${suggestion.kind}) — ${suggestion.filePath}`
      ).join('\n')}`;
    }
    return `Symbol not found: "${name}". Use cartograph_find to search.`;
  }

  // Prefer exact match (case-insensitive) when available
  const exactMatch = searchResults.find(r => r.qualifiedName?.toLowerCase() === name.toLowerCase());
  if (exactMatch) {
    matches = [{ symbol: exactMatch, filePath: exactMatch.filePath }];
  } else {
    matches = searchResults.map(r => ({ symbol: r, filePath: r.filePath }));
  }

  const sections: string[] = [];

  for (const match of matches) {
    const sym = match.symbol!;
    const lines: string[] = [];

    lines.push(`## ${sym.qualifiedName ?? sym.name} (${sym.kind})`);
    lines.push(`File: ${match.filePath}:${sym.lineStart}-${sym.lineEnd}`);
    if (sym.visibility) lines.push(`Visibility: ${sym.visibility}`);
    if (deps.symbolSchemaRepo) {
      const mappedTables = deps.symbolSchemaRepo.findTablesBySymbol(repoId, sym.id);
      if (mappedTables.length > 0) {
        lines.push(`Mapped tables: ${mappedTables.map((link) => link.tableName).join(', ')}`);
      }
    }

    // Forward deps (fetched early so conventions context can reuse them)
    const forwardDeps = refRepo.findDependencies(sym.id);

    // Conventions context for classes
    if (sym.kind === 'class') {
      const context = buildConventionsContext(forwardDeps, stats);
      if (context) lines.push(`Context: ${context}`);
    }

    // Deep mode: show full vertical stack for classes
    if (params.deep && supportsDeepView(sym.kind)) {
      lines.push('');
      appendDeepView(lines, sym.id, forwardDeps, repoId, symbolRepo, refRepo);
    } else {
      lines.push('');
      if (forwardDeps.length > 0) {
        lines.push(`### Depends on (${forwardDeps.length})`);
        for (const dep of forwardDeps) {
          const targetName = dep.targetSymbolId
            ? symbolRepo.findById(dep.targetSymbolId)?.qualifiedName ?? dep.targetQualifiedName
            : `${dep.targetQualifiedName} (unresolved)`;
          const lineRef = dep.lineNumber ? `, line ${dep.lineNumber}` : '';
          const via = dep.sourceSymbolName && dep.sourceSymbolId !== sym.id
            ? ` via ${dep.sourceSymbolName}()` : '';
          lines.push(`- ${targetName} (${dep.referenceKind}${lineRef}${via})`);
        }
        lines.push('');
      }

      // Reverse deps
      const reverseDeps = refRepo.findDependents(sym.id, 1) as unknown as DependentRow[];
      if (reverseDeps.length > 0) {
        lines.push(`### Used by (${reverseDeps.length})`);
        for (const dep of reverseDeps) {
          const line = dep.line_number ? `, line ${dep.line_number}` : '';
          lines.push(`- ${dep.source_qualified_name} (${dep.reference_kind}${line})`);
          lines.push(`  ${dep.source_file_path}`);
        }
      }
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n---\n\n');
}

function appendDeepView(
  lines: string[],
  symbolId: number,
  forwardDeps: ReferenceRecord[],
  repoId: number,
  symbolRepo: ToolDeps['symbolRepo'],
  refRepo: ToolDeps['refRepo']
): void {
  lines.push('### Stack');

  // 1. Inheritance chain
  const inheritance = forwardDeps.filter(d => d.referenceKind === 'inheritance');
  if (inheritance.length > 0) {
    for (const inh of inheritance) {
      const targetName = inh.targetSymbolId
        ? symbolRepo.findById(inh.targetSymbolId)?.qualifiedName ?? inh.targetQualifiedName
        : inh.targetQualifiedName;
      lines.push(`  Extends: ${targetName}`);
    }
  }

  // 2. Wiring: class_reference edges from child methods (getControllerName → Controller::class)
  const classRefs = forwardDeps.filter(d => d.referenceKind === 'class_reference');
  if (classRefs.length > 0) {
    for (const ref of classRefs) {
      const targetName = ref.targetSymbolId
        ? symbolRepo.findById(ref.targetSymbolId)?.qualifiedName ?? ref.targetQualifiedName
        : ref.targetQualifiedName;
      const via = ref.sourceSymbolName ? `via ${ref.sourceSymbolName}()` : '';
      lines.push(`  ${via ? via + ': ' : '\u2192 '}${targetName}`);
    }
  }

  // 3. Concrete implementations (who extends this class?)
  const implementors = refRepo.findDependents(symbolId, 1) as unknown as DependentRow[];
  const concreteExtenders = implementors.filter(d => d.reference_kind === 'inheritance');
  if (concreteExtenders.length > 0 && concreteExtenders.length <= 5) {
    lines.push('');
    lines.push('### Extended by');
    for (const ext of concreteExtenders) {
      lines.push(`  - ${ext.source_qualified_name}`);
    }
  } else if (concreteExtenders.length > 5) {
    lines.push('');
    lines.push(`### Extended by (${concreteExtenders.length} classes \u2014 showing first 5)`);
    for (const ext of concreteExtenders.slice(0, 5)) {
      lines.push(`  - ${ext.source_qualified_name}`);
    }
  }

  // 4. Follow one level deeper: for each class_reference target, show ITS wiring
  if (classRefs.length > 0) {
    lines.push('');
    lines.push('### Wiring detail (depth 2)');
    for (const ref of classRefs) {
      if (!ref.targetSymbolId) continue;
      const target = symbolRepo.findById(ref.targetSymbolId);
      if (!target) continue;

      const targetDeps = refRepo.findDependencies(target.id);
      const targetClassRefs = targetDeps.filter(d => d.referenceKind === 'class_reference');
      const targetInheritance = targetDeps.filter(d => d.referenceKind === 'inheritance');

      const via = ref.sourceSymbolName ? `${ref.sourceSymbolName}()` : '?';
      const parts: string[] = [];
      for (const inh of targetInheritance) {
        parts.push(`extends ${inh.targetQualifiedName}`);
      }
      for (const cr of targetClassRefs) {
        const crVia = cr.sourceSymbolName ? `via ${cr.sourceSymbolName}()` : '';
        parts.push(`${crVia ? crVia + ': ' : '\u2192 '}${cr.targetQualifiedName}`);
      }

      lines.push(`  ${via} \u2192 ${target.qualifiedName}`);
      for (const part of parts) {
        lines.push(`    ${part}`);
      }
    }
  }

  // 5. Context requirements across the wired stack.
  const contextRequirements = collectContextRequirements(symbolId, symbolRepo, refRepo);
  const argEntries = contextRequirements.args;
  const paramEntries = contextRequirements.params;

  if (argEntries.length > 0 || paramEntries.length > 0) {
    lines.push('');
    lines.push('### Context requirements');
    if (argEntries.length > 0) {
      lines.push('Route args consumed:');
      for (const entry of argEntries) {
        lines.push(`  - ${entry.key} (via ${entry.ownerQualifiedName}::${entry.method}())`);
      }
    }
    if (paramEntries.length > 0) {
      lines.push('Request params consumed:');
      for (const entry of paramEntries) {
        lines.push(`  - ${entry.key} (via ${entry.ownerQualifiedName}::${entry.method}())`);
      }
    }
  }
}

function collectContextRequirements(
  rootSymbolId: number,
  symbolRepo: ToolDeps['symbolRepo'],
  refRepo: ToolDeps['refRepo'],
  maxDepth: number = 4
): { args: ContextRequirementEntry[]; params: ContextRequirementEntry[] } {
  const args = new Map<string, ContextRequirementEntry>();
  const params = new Map<string, ContextRequirementEntry>();
  const queue: Array<{ symbolId: number; depth: number }> = [{ symbolId: rootSymbolId, depth: 0 }];
  const visitedDepths = new Map<number, number>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const previousDepth = visitedDepths.get(current.symbolId);
    if (previousDepth !== undefined && previousDepth <= current.depth) {
      continue;
    }
    visitedDepths.set(current.symbolId, current.depth);

    const currentSymbol = symbolRepo.findById(current.symbolId);
    if (!currentSymbol) continue;

    for (const child of symbolRepo.findChildren(current.symbolId)) {
      const meta = child.metadata || {};
      const contextArgs = meta.contextArgs as string[] | undefined;
      const contextParams = meta.contextParams as string[] | undefined;

      if (contextArgs) {
        for (const key of contextArgs) {
          const entryKey = `${key}|${currentSymbol.qualifiedName ?? currentSymbol.name}|${child.name}`;
          const existing = args.get(entryKey);
          if (!existing || existing.depth > current.depth) {
            args.set(entryKey, {
              key,
              method: child.name,
              ownerQualifiedName: currentSymbol.qualifiedName ?? currentSymbol.name,
              depth: current.depth,
            });
          }
        }
      }

      if (contextParams) {
        for (const key of contextParams) {
          const entryKey = `${key}|${currentSymbol.qualifiedName ?? currentSymbol.name}|${child.name}`;
          const existing = params.get(entryKey);
          if (!existing || existing.depth > current.depth) {
            params.set(entryKey, {
              key,
              method: child.name,
              ownerQualifiedName: currentSymbol.qualifiedName ?? currentSymbol.name,
              depth: current.depth,
            });
          }
        }
      }
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    const deps = refRepo.findDependencies(current.symbolId);
    for (const dep of deps) {
      if (!dep.targetSymbolId) continue;
      if (dep.referenceKind !== 'class_reference' && dep.referenceKind !== 'inheritance') continue;
      queue.push({
        symbolId: dep.targetSymbolId,
        depth: current.depth + 1,
      });
    }
  }

  return {
    args: sortContextEntries([...args.values()]),
    params: sortContextEntries([...params.values()]),
  };
}

function sortContextEntries(entries: ContextRequirementEntry[]): ContextRequirementEntry[] {
  return entries.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.key !== b.key) return a.key.localeCompare(b.key);
    if (a.ownerQualifiedName !== b.ownerQualifiedName) {
      return a.ownerQualifiedName.localeCompare(b.ownerQualifiedName);
    }
    return a.method.localeCompare(b.method);
  });
}

function supportsDeepView(kind: string): boolean {
  return kind === 'class' || kind === 'interface';
}

function buildConventionsContext(
  forwardDeps: ReferenceRecord[],
  stats: RepoStats
): string | null {
  const parts: string[] = [];

  const implementations = forwardDeps.filter(d => d.referenceKind === 'implementation');
  const inheritance = forwardDeps.filter(d => d.referenceKind === 'inheritance');
  const traits = forwardDeps.filter(d => d.referenceKind === 'trait_use');

  if (implementations.length > 0) {
    const ifaceName = implementations[0].targetQualifiedName.split('\\').pop() ?? implementations[0].targetQualifiedName;
    const pct = stats.totalClasses > 0 ? Math.round((stats.classesWithInterface / stats.totalClasses) * 100) : 0;
    parts.push(`Implements ${ifaceName} (${pct}% of classes do)`);
  }

  if (inheritance.length > 0) {
    const baseName = inheritance[0].targetQualifiedName.split('\\').pop() ?? inheritance[0].targetQualifiedName;
    parts.push(`Extends ${baseName}`);
  }

  if (traits.length > 0) {
    const pct = stats.totalClasses > 0 ? Math.round((stats.classesWithTraits / stats.totalClasses) * 100) : 0;
    parts.push(`Uses ${traits.length} trait${traits.length > 1 ? 's' : ''} (${pct}% of classes do)`);
  }

  if (parts.length === 0 && stats.totalClasses > 0) {
    const noIfacePct = stats.totalClasses > 0
      ? Math.round(((stats.totalClasses - stats.classesWithInterface) / stats.totalClasses) * 100)
      : 0;
    parts.push(`No interface, no base class (matches ${noIfacePct}% of classes)`);
  }

  return parts.length > 0 ? parts.join('. ') + '.' : null;
}
