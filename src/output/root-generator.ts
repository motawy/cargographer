import type { RepoStats, ConventionsData } from './generate-pipeline.js';

const TOKEN_BUDGET_CHARS = 12000;

export function generateRoot(stats: RepoStats, conventions?: ConventionsData): string {
  const lines: string[] = [];

  lines.push(`# Project Overview\n`);
  lines.push(`**Language:** ${capitalize(stats.language)} | **Files:** ${stats.totalFiles.toLocaleString()} | **Symbols:** ${stats.totalSymbols.toLocaleString()} | **References:** ${stats.totalReferences.toLocaleString()}\n`);

  lines.push(`## Architecture\n`);
  lines.push(`${detectArchitecture(stats.directories, conventions)}\n`);

  lines.push(`## Directory Map\n`);
  lines.push('```');
  let shown = 0;
  const maxDirs = 30;
  for (const dir of stats.directories) {
    if (shown >= maxDirs) {
      lines.push(`... and ${stats.directories.length - maxDirs} more directories`);
      break;
    }
    const kinds = dir.dominantKinds.length > 0
      ? ` (${dir.dominantKinds.join(', ')})`
      : '';
    lines.push(`${dir.path.padEnd(35)} ${String(dir.symbolCount).padStart(5)} symbols${kinds}`);
    shown++;
  }
  lines.push('```\n');

  lines.push(`## Context Files\n`);
  lines.push(`- [Modules](modules.md) — what exists where, grouped by area`);
  lines.push(`- [Dependencies](dependencies.md) — how modules connect (directed graph)`);
  lines.push(`- [Conventions](conventions.md) — coding patterns and style\n`);

  lines.push(`## Cartograph Tools\n`);
  lines.push(`This project is indexed by Cartograph. Use these MCP tools for cross-cutting queries instead of exploring files manually:\n`);
  lines.push(`- **cartograph_schema** \`[query]\` — list or search current database tables with column and foreign-key counts`);
  lines.push(`- **cartograph_table** \`<table>\` — inspect the exact current shape of a table and its direct foreign-key relationships`);
  lines.push(`- **cartograph_table_graph** \`<table>\` — walk the foreign-key neighborhood around a table to understand connected areas`);
  lines.push(`- **cartograph_table_usage** \`<table>\` — bridge database tables to mapped entities, entity touchpoints, and direct table-name references`);
  lines.push(`- **cartograph_test_targets** — suggest likely test files for a symbol, file, or table`);
  lines.push(`- **cartograph_search_content** \`<query>\` — search method bodies and other indexed source text by literal substring`);
  lines.push(`- **cartograph_symbol** \`<name>\` — look up a class/interface/function and its relationships`);
  lines.push(`- **cartograph_deps** \`<symbol>\` — what does this symbol depend on? (directed graph, configurable depth)`);
  lines.push(`- **cartograph_dependents** \`<symbol>\` — what depends on this? (reverse dependency lookup)`);
  lines.push(`- **cartograph_blast_radius** \`<file>\` — what breaks if this file changes?`);
  lines.push(`- **cartograph_find** \`<query>\` — find symbols across modules by name or pattern`);
  lines.push(`- **cartograph_compare** \`<a> <b>\` — compare two symbols structurally, including short method bodies and wiring targets`);
  lines.push(`- **cartograph_compare_many** \`<baseline> <others...>\` — compare one symbol against several siblings at once`);
  lines.push(`- **cartograph_flow** \`<entrypoint>\` — trace an execution flow end-to-end\n`);
  lines.push(`Use these before grepping the codebase. They answer in seconds from the pre-built index.\n`);

  let result = lines.join('\n');
  if (result.length > TOKEN_BUDGET_CHARS) {
    result = result.substring(0, TOKEN_BUDGET_CHARS) + '\n\n... (truncated to fit token budget)\n';
  }

  return result;
}

function detectArchitecture(
  dirs: { path: string; classCount: number }[],
  conventions?: ConventionsData
): string {
  const dirNames = new Set(dirs.map(d => d.path.split('/').pop()?.toLowerCase()));
  const patterns: string[] = [];

  const interfaceAdoption = conventions && conventions.totalClasses > 0
    ? Math.round((conventions.classesWithInterface / conventions.totalClasses) * 100)
    : null;

  if (dirNames.has('controllers') || dirNames.has('http')) {
    patterns.push('HTTP controllers');
  }
  if (dirNames.has('services')) {
    patterns.push('service layer');
  }
  if (dirNames.has('repositories')) {
    patterns.push('repository pattern for data access');
  }
  if (dirNames.has('models')) {
    patterns.push('model layer');
  }
  if (dirNames.has('contracts') || dirNames.has('interfaces')) {
    if (interfaceAdoption !== null) {
      const topModules = conventions ? getTopAdoptingModules(conventions) : '';
      patterns.push(`interfaces (${interfaceAdoption}% of classes implement one${topModules})`);
    } else {
      patterns.push('interface contracts');
    }
  }

  if (patterns.length === 0) {
    return 'Architecture pattern could not be determined from directory structure.';
  }

  return `This codebase uses ${patterns.join(', ')}. ` +
    `Top-level directories organize code by responsibility.`;
}

function getTopAdoptingModules(conventions: ConventionsData): string {
  const entries = [...conventions.interfaceAdoptionByModule.entries()]
    .filter(([, v]) => v.total >= 10 && v.withInterface > 0)
    .map(([mod, v]) => ({ mod, rate: Math.round((v.withInterface / v.total) * 100) }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 3);

  if (entries.length === 0) return '';
  const list = entries.map(e => `${e.mod} ${e.rate}%`).join(', ');
  return `, concentrated in ${list}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
