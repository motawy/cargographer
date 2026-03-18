import type { ReferenceRecord } from '../../db/repositories/reference-repository.js';
import type { ToolDeps, RepoStats, DependentRow } from '../types.js';

interface SymbolParams {
  name: string;
  deep?: boolean;
}

export async function handleSymbol(deps: ToolDeps, stats: RepoStats, params: SymbolParams): Promise<string> {
  const { repoId, symbolRepo, refRepo } = deps;
  const { name } = params;

  // Search with suffix pattern — works for both exact qualified names and short names.
  // Escape backslashes for ILIKE (PostgreSQL treats \ as escape char in ILIKE patterns).
  const escapedName = name.replace(/\\/g, '\\\\');
  const searchResults = await symbolRepo.search(repoId, `%${escapedName}`, undefined, 10);
  let matches: { symbol: (typeof searchResults)[0]; filePath: string }[] = [];

  if (searchResults.length === 0) {
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

    // Forward deps (fetched early so conventions context can reuse them)
    const forwardDeps = await refRepo.findDependencies(sym.id);

    // Conventions context for classes
    if (sym.kind === 'class') {
      const context = buildConventionsContext(forwardDeps, stats);
      if (context) lines.push(`Context: ${context}`);
    }

    // Deep mode: show full vertical stack for classes
    if (params.deep && sym.kind === 'class') {
      lines.push('');
      await appendDeepView(lines, sym.id, forwardDeps, repoId, symbolRepo, refRepo);
    } else {
      lines.push('');
      if (forwardDeps.length > 0) {
        lines.push(`### Depends on (${forwardDeps.length})`);
        for (const dep of forwardDeps) {
          const targetName = dep.targetSymbolId
            ? (await symbolRepo.findById(dep.targetSymbolId))?.qualifiedName ?? dep.targetQualifiedName
            : `${dep.targetQualifiedName} (unresolved)`;
          const lineRef = dep.lineNumber ? `, line ${dep.lineNumber}` : '';
          const via = dep.sourceSymbolName && dep.sourceSymbolId !== sym.id
            ? ` via ${dep.sourceSymbolName}()` : '';
          lines.push(`- ${targetName} (${dep.referenceKind}${lineRef}${via})`);
        }
        lines.push('');
      }

      // Reverse deps
      const reverseDeps = (await refRepo.findDependents(sym.id, 1)) as unknown as DependentRow[];
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

async function appendDeepView(
  lines: string[],
  symbolId: number,
  forwardDeps: ReferenceRecord[],
  repoId: number,
  symbolRepo: ToolDeps['symbolRepo'],
  refRepo: ToolDeps['refRepo']
): Promise<void> {
  lines.push('### Stack');

  // 1. Inheritance chain
  const inheritance = forwardDeps.filter(d => d.referenceKind === 'inheritance');
  if (inheritance.length > 0) {
    for (const inh of inheritance) {
      const targetName = inh.targetSymbolId
        ? (await symbolRepo.findById(inh.targetSymbolId))?.qualifiedName ?? inh.targetQualifiedName
        : inh.targetQualifiedName;
      lines.push(`  Extends: ${targetName}`);
    }
  }

  // 2. Wiring: class_reference edges from child methods (getControllerName → Controller::class)
  const classRefs = forwardDeps.filter(d => d.referenceKind === 'class_reference');
  if (classRefs.length > 0) {
    for (const ref of classRefs) {
      const targetName = ref.targetSymbolId
        ? (await symbolRepo.findById(ref.targetSymbolId))?.qualifiedName ?? ref.targetQualifiedName
        : ref.targetQualifiedName;
      const via = ref.sourceSymbolName ? `via ${ref.sourceSymbolName}()` : '';
      lines.push(`  ${via ? via + ': ' : '→ '}${targetName}`);
    }
  }

  // 3. Concrete implementations (who extends this class?)
  const implementors = (await refRepo.findDependents(symbolId, 1)) as unknown as DependentRow[];
  const concreteExtenders = implementors.filter(d => d.reference_kind === 'inheritance');
  if (concreteExtenders.length > 0 && concreteExtenders.length <= 5) {
    lines.push('');
    lines.push('### Extended by');
    for (const ext of concreteExtenders) {
      lines.push(`  - ${ext.source_qualified_name}`);
    }
  } else if (concreteExtenders.length > 5) {
    lines.push('');
    lines.push(`### Extended by (${concreteExtenders.length} classes — showing first 5)`);
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
      const target = await symbolRepo.findById(ref.targetSymbolId);
      if (!target) continue;

      const targetDeps = await refRepo.findDependencies(target.id);
      const targetClassRefs = targetDeps.filter(d => d.referenceKind === 'class_reference');
      const targetInheritance = targetDeps.filter(d => d.referenceKind === 'inheritance');

      const via = ref.sourceSymbolName ? `${ref.sourceSymbolName}()` : '?';
      const parts: string[] = [];
      for (const inh of targetInheritance) {
        parts.push(`extends ${inh.targetQualifiedName}`);
      }
      for (const cr of targetClassRefs) {
        const crVia = cr.sourceSymbolName ? `via ${cr.sourceSymbolName}()` : '';
        parts.push(`${crVia ? crVia + ': ' : '→ '}${cr.targetQualifiedName}`);
      }

      lines.push(`  ${via} → ${target.qualifiedName}`);
      for (const part of parts) {
        lines.push(`    ${part}`);
      }
    }
  }

  // 5. Context requirements: what route args/params does this class consume?
  const children = await symbolRepo.findChildren(symbolId);
  const argEntries: { key: string; method: string; }[] = [];
  const paramEntries: { key: string; method: string; }[] = [];

  for (const child of children) {
    const meta = child.metadata || {};
    const contextArgs = meta.contextArgs as string[] | undefined;
    const contextParams = meta.contextParams as string[] | undefined;
    if (contextArgs) {
      for (const key of contextArgs) {
        argEntries.push({ key, method: child.name });
      }
    }
    if (contextParams) {
      for (const key of contextParams) {
        paramEntries.push({ key, method: child.name });
      }
    }
  }

  if (argEntries.length > 0 || paramEntries.length > 0) {
    lines.push('');
    lines.push('### Context requirements');
    if (argEntries.length > 0) {
      lines.push('Route args consumed:');
      for (const entry of argEntries) {
        lines.push(`  - ${entry.key} (via ${entry.method}())`);
      }
    }
    if (paramEntries.length > 0) {
      lines.push('Request params consumed:');
      for (const entry of paramEntries) {
        lines.push(`  - ${entry.key} (via ${entry.method}())`);
      }
    }
  }
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
