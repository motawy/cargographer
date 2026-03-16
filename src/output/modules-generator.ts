import type { ModuleInfo } from './generate-pipeline.js';

const TOKEN_BUDGET_CHARS = 20000; // ~5K tokens
const MAX_SYMBOLS_PER_MODULE = 15;
const MAX_MODULES = 40;

export function generateModules(modules: ModuleInfo[]): string {
  const lines: string[] = [];

  lines.push('# Modules\n');
  lines.push(`${modules.length} module areas, ${modules.reduce((sum, m) => sum + m.symbols.length, 0)} top-level symbols.\n`);

  let shown = 0;
  for (const mod of modules) {
    if (shown >= MAX_MODULES) {
      lines.push(`\n... and ${modules.length - MAX_MODULES} more modules\n`);
      break;
    }

    const totalSymbols = mod.symbols.length;
    lines.push(`## ${mod.path} (${totalSymbols} ${pluralize(totalSymbols, 'symbol')})\n`);
    lines.push('| Symbol | Kind | Refs | Relationships |');
    lines.push('|--------|------|------|---------------|');

    const toShow = mod.symbols.slice(0, MAX_SYMBOLS_PER_MODULE);
    for (const sym of toShow) {
      const shortName = sym.qualifiedName.split('\\').pop() || sym.qualifiedName;
      const rels = formatRelationships(sym);
      lines.push(`| ${shortName} | ${sym.kind} | ${sym.referenceCount} | ${rels} |`);
    }

    if (totalSymbols > MAX_SYMBOLS_PER_MODULE) {
      lines.push(`\n*... and ${totalSymbols - MAX_SYMBOLS_PER_MODULE} more*\n`);
    } else {
      lines.push('');
    }

    shown++;
  }

  let result = lines.join('\n');
  if (result.length > TOKEN_BUDGET_CHARS) {
    result = result.substring(0, TOKEN_BUDGET_CHARS) + '\n\n... (truncated to fit token budget)\n';
  }

  return result;
}

function formatRelationships(sym: { implements: string[]; extends: string | null; traits: string[] }): string {
  const parts: string[] = [];

  if (sym.extends) {
    parts.push(`extends ${shortName(sym.extends)}`);
  }
  for (const iface of sym.implements) {
    parts.push(`impl ${shortName(iface)}`);
  }
  for (const trait of sym.traits) {
    parts.push(`uses ${shortName(trait)}`);
  }

  return parts.join(', ') || '—';
}

function shortName(qualifiedName: string): string {
  return qualifiedName.split('\\').pop() || qualifiedName;
}

function pluralize(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
