import type { ModuleInfo } from './generate-pipeline.js';

const TOKEN_BUDGET_CHARS = 20000; // ~5K tokens
const MAX_SYMBOLS_PER_MODULE = 15;
const MAX_MODULES = 40;
const MAX_STANDALONE = 10;

function isTestModule(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.startsWith('test/') || lower.startsWith('tests/');
}

function isStandaloneFile(mod: ModuleInfo): boolean {
  return mod.fileCount === 1 || (mod.fileCount === undefined && mod.path.match(/\.\w+$/) !== null);
}

export function generateModules(modules: ModuleInfo[]): string {
  const lines: string[] = [];

  // Partition into production, test, and standalone
  const production: ModuleInfo[] = [];
  const test: ModuleInfo[] = [];
  const standalone: ModuleInfo[] = [];

  for (const mod of modules) {
    if (isTestModule(mod.path)) {
      test.push(mod);
    } else if (isStandaloneFile(mod)) {
      standalone.push(mod);
    } else {
      production.push(mod);
    }
  }

  const totalSymbols = modules.reduce((sum, m) => sum + m.symbols.length, 0);
  lines.push('# Modules\n');
  lines.push(`${production.length} module areas, ${totalSymbols} top-level symbols.\n`);

  // Test suite summary (compact, rendered first to survive truncation)
  if (test.length > 0) {
    const testSymbols = test.reduce((sum, m) => sum + m.symbols.length, 0);
    const testDirs = test.map(m => m.path).join(', ');
    lines.push(`**Test suite:** ${testSymbols.toLocaleString()} symbols across ${testDirs}\n`);
  }

  // Standalone files (compact, rendered before module tables)
  if (standalone.length > 0) {
    const sorted = standalone.sort((a, b) => b.symbols.length - a.symbols.length);
    lines.push('## Standalone Files\n');
    lines.push('| File | Symbols | Top Kind |');
    lines.push('|------|---------|----------|');

    for (const mod of sorted.slice(0, MAX_STANDALONE)) {
      const topKind = mod.symbols[0]?.kind || 'unknown';
      lines.push(`| ${mod.path} | ${mod.symbols.length} | ${topKind} |`);
    }

    if (standalone.length > MAX_STANDALONE) {
      lines.push(`\n*... and ${standalone.length - MAX_STANDALONE} more*`);
    }
    lines.push('');
  }

  // Production modules (verbose tables — these get truncated first)
  let shown = 0;
  for (const mod of production) {
    if (shown >= MAX_MODULES) {
      lines.push(`\n... and ${production.length - MAX_MODULES} more modules\n`);
      break;
    }

    const totalSymCount = mod.symbols.length;
    lines.push(`## ${mod.path} (${totalSymCount} ${pluralize(totalSymCount, 'symbol')})\n`);
    lines.push('| Symbol | Kind | Refs | Relationships |');
    lines.push('|--------|------|------|---------------|');

    const toShow = mod.symbols.slice(0, MAX_SYMBOLS_PER_MODULE);
    for (const sym of toShow) {
      const shortName = sym.qualifiedName.split('\\').pop() || sym.qualifiedName;
      const rels = formatRelationships(sym);
      lines.push(`| ${shortName} | ${sym.kind} | ${sym.referenceCount} | ${rels} |`);
    }

    if (totalSymCount > MAX_SYMBOLS_PER_MODULE) {
      lines.push(`\n*... and ${totalSymCount - MAX_SYMBOLS_PER_MODULE} more*\n`);
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
