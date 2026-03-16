# Generate Output Polish — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 accuracy issues in `cartograph generate` output so the v1 static context files are trustworthy.

**Architecture:** Pure function generators take data interfaces, return strings. Pipeline queries DB, passes data to generators, writes files. Fixes are isolated to generators (Phase 1) or indexer (Phase 2). No new files needed — all changes modify existing code and tests.

**Tech Stack:** TypeScript, PostgreSQL, Vitest

---

## Chunk 1: Generator Fixes (#6, #2, #5, #4, #3)

### Task 1: Fix method naming regex (#6)

**Files:**
- Modify: `src/output/conventions-generator.ts:59-68`
- Modify: `src/output/generate-pipeline.ts:365-370`
- Modify: `tests/output/conventions-generator.test.ts:69-79`

- [ ] **Step 1: Update the failing test for naming conventions**

Delete the existing `detects naming conventions` test (line 69-73) and `detects magic methods` test (lines 75-79). The magic method reporting is intentionally removed from the generator — magic methods are now excluded at the SQL level, so the generator no longer needs to count them in the sample. Replace with these new tests:

```typescript
// In tests/output/conventions-generator.test.ts, replace tests starting at the 'detects naming conventions' test:

  it('detects camelCase method naming', () => {
    const result = generateConventions(makeConventions({
      methodNames: ['findById', 'createUser', 'getName', 'updateProfile', 'deleteRecord'],
    }));
    expect(result).toContain('100% camelCase');
    expect(result).not.toContain('snake_case');
  });

  it('detects snake_case method naming', () => {
    const result = generateConventions(makeConventions({
      methodNames: ['find_by_id', 'create_user', 'get_name', 'update_profile', 'delete_record'],
    }));
    expect(result).toContain('100% snake_case');
    expect(result).not.toContain('camelCase');
  });

  it('reports mixed naming styles', () => {
    const result = generateConventions(makeConventions({
      methodNames: ['findById', 'createUser', 'get_name', 'update_profile'],
    }));
    expect(result).toContain('50% camelCase');
    expect(result).toContain('50% snake_case');
  });

  it('does not count magic methods in naming sample', () => {
    // Magic methods should be excluded at the SQL level, but if they
    // somehow appear in the sample, they should not affect percentages
    const result = generateConventions(makeConventions({
      methodNames: ['findById', 'createUser'],
    }));
    expect(result).not.toContain('__construct');
    expect(result).toContain('camelCase');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/output/conventions-generator.test.ts`
Expected: FAIL — the current regex produces wrong percentages

- [ ] **Step 3: Implement the method naming fix in the generator**

In `src/output/conventions-generator.ts`, replace the method naming section (lines 59-68):

```typescript
  if (data.methodNames.length > 0) {
    // Filter out any magic methods that slipped through
    const nonMagic = data.methodNames.filter(n => !n.startsWith('__'));
    if (nonMagic.length > 0) {
      const camelCount = nonMagic.filter(n => /^[a-z][a-zA-Z0-9]*$/.test(n)).length;
      const snakeCount = nonMagic.filter(n => /^[a-z][a-z0-9_]*$/.test(n) && n.includes('_')).length;
      const camelPct = pct(camelCount, nonMagic.length);
      const snakePct = pct(snakeCount, nonMagic.length);

      if (camelPct > 0 && snakePct > 0) {
        lines.push(`- **Method naming:** ${camelPct}% camelCase, ${snakePct}% snake_case (sample of ${nonMagic.length})`);
      } else if (camelPct > 0) {
        lines.push(`- **Method naming:** ${camelPct}% camelCase (sample of ${nonMagic.length})`);
      } else if (snakePct > 0) {
        lines.push(`- **Method naming:** ${snakePct}% snake_case (sample of ${nonMagic.length})`);
      }
    }
  }
```

- [ ] **Step 4: Update the SQL query to exclude magic methods**

In `src/output/generate-pipeline.ts`, modify the method names query (around line 365):

```typescript
    const { rows: methodNameRows } = await this.pool.query(
      `SELECT s.name FROM symbols s JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = $1 AND s.kind = 'method'
         AND s.name NOT LIKE E'\\_\\_%'
       LIMIT 200`,
      [repoId]
    );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/output/conventions-generator.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/output/conventions-generator.ts src/output/generate-pipeline.ts tests/output/conventions-generator.test.ts
git commit -m "fix: method naming detection — separate camelCase/snake_case, exclude magic methods"
```

---

### Task 2: Filter external deps noise (#2)

**Files:**
- Modify: `src/output/generate-pipeline.ts:268-280`
- Modify: `tests/output/deps-generator.test.ts`

- [ ] **Step 1: Add test for filtering non-namespaced external deps**

In `tests/output/deps-generator.test.ts`, add after the existing tests:

```typescript
  it('filters non-namespaced external deps', () => {
    const result = generateDeps(makeDeps({
      external: [
        { namespace: 'Symfony', referenceCount: 580 },
        { namespace: 'm::mock', referenceCount: 52 },
        { namespace: 'PDO::FETCH_NUM', referenceCount: 32 },
        { namespace: 'Console::Log', referenceCount: 24 },
      ],
    }));
    expect(result).toContain('Symfony');
    expect(result).not.toContain('m::mock');
    expect(result).not.toContain('PDO::FETCH_NUM');
    expect(result).not.toContain('Console::Log');
  });
```

Wait — this test won't work as-is. The filtering happens at the SQL level in the pipeline, not in the generator. The `generateDeps()` function receives already-queried data. We have two options:

1. Filter in SQL (pipeline) — keeps generator pure, but unit test can't verify
2. Filter in generator — testable, but duplicates logic

Best approach: filter in the generator too, since the data interface allows non-namespaced entries from any source. The SQL filter is a performance optimization, not the only line of defense.

- [ ] **Step 1 (revised): Add test for filtering non-namespaced external deps**

Add to `tests/output/deps-generator.test.ts`:

```typescript
  it('filters non-namespaced external deps', () => {
    const result = generateDeps(makeDeps({
      external: [
        { namespace: 'Symfony', referenceCount: 580 },
        { namespace: 'm::mock', referenceCount: 52 },
        { namespace: 'PDO::FETCH_NUM', referenceCount: 32 },
        { namespace: 'Console::Log', referenceCount: 24 },
      ],
    }));
    expect(result).toContain('Symfony');
    expect(result).not.toContain('m::mock');
    expect(result).not.toContain('PDO::FETCH_NUM');
    expect(result).not.toContain('Console::Log');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/output/deps-generator.test.ts`
Expected: FAIL — generator currently passes all external deps through

- [ ] **Step 3: Filter non-namespaced entries in the generator**

In `src/output/deps-generator.ts`, add filtering before rendering external deps. Around line 41, change:

```typescript
  // External dependencies
  if (data.external.length > 0) {
```

to:

```typescript
  // External dependencies — filter out non-namespaced entries (bare Class::method refs)
  const namespacedExternal = data.external.filter(e => !e.namespace.includes('::'));
  if (namespacedExternal.length > 0) {
```

And update the rendering loop (lines 44-50) to use `namespacedExternal` instead of `data.external`:

```typescript
    for (const ext of namespacedExternal.slice(0, 20)) {
      lines.push(`| ${ext.namespace} | ${ext.referenceCount} |`);
    }
    if (namespacedExternal.length > 20) {
      lines.push(`\n*... and ${namespacedExternal.length - 20} more*`);
    }
```

- [ ] **Step 4: Also add the SQL-level filter in the pipeline**

In `src/output/generate-pipeline.ts`, in `queryDependencies()`, add a WHERE clause to the external deps query (around line 276, before `GROUP BY`). Use the same escaping convention as the existing `split_part(sr.target_qualified_name, E'\\\\', 1)` on line 270:

```sql
AND sr.target_qualified_name LIKE E'%\\\\%'
```

This is defense-in-depth: the SQL filter removes non-namespaced refs (no backslash), while the generator filter removes bare `Class::method` refs (has `::`). Together they catch all noise patterns.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/output/deps-generator.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/output/deps-generator.ts src/output/generate-pipeline.ts tests/output/deps-generator.test.ts
git commit -m "fix: filter non-namespaced entries from external dependencies"
```

---

### Task 3: Single files as standalone section (#5) + test module filtering (#4)

This task implements both Fix #5 (standalone files) and Fix #4 (test modules). They're combined because both require partitioning modules in the generator — doing them separately would mean rewriting the same partitioning logic twice.

**Files:**
- Modify: `src/output/generate-pipeline.ts:17-23,179-238`
- Modify: `src/output/modules-generator.ts`
- Modify: `tests/output/modules-generator.test.ts`

- [ ] **Step 1: Add optional `fileCount` to `ModuleInfo` interface**

In `src/output/generate-pipeline.ts`, add `fileCount` as optional to the `ModuleInfo` interface (optional so existing consumers don't break):

```typescript
export interface ModuleInfo {
  path: string;
  symbols: ModuleSymbol[];
  fileCount?: number;
}
```

- [ ] **Step 2: Populate `fileCount` in queryModules()**

In `src/output/generate-pipeline.ts`, in `queryModules()`, add a window function to the existing query to get the file count per module without a separate query. Add this to the SELECT list (after the `uses_traits` subquery):

```sql
(SELECT COUNT(DISTINCT f2.id)
 FROM files f2
 WHERE split_part(f2.path, '/', 1) ||
   CASE WHEN position('/' in f2.path) > 0
        THEN '/' || split_part(f2.path, '/', 2)
        ELSE '' END = split_part(f.path, '/', 1) ||
   CASE WHEN position('/' in f.path) > 0
        THEN '/' || split_part(f.path, '/', 2)
        ELSE '' END
   AND f2.repo_id = $1
) AS module_file_count
```

Then when building moduleMap, track file counts per module using a Set of file paths. Replace the aggregation section:

```typescript
    const moduleMap = new Map<string, { symbols: ModuleSymbol[]; filePaths: Set<string> }>();
    for (const row of rows) {
      const dir = row.module_dir as string;
      const entry = moduleMap.get(dir) || { symbols: [], filePaths: new Set() };
      entry.filePaths.add(row.file_path as string);
      entry.symbols.push({
        qualifiedName: row.qualified_name as string,
        kind: row.kind as string,
        linesOfCode: row.lines_of_code as number,
        implements: (row.implements as string[]) || [],
        extends: (row.extends_from as string) || null,
        traits: (row.uses_traits as string[]) || [],
        referenceCount: row.ref_count as number,
      });
      moduleMap.set(dir, entry);
    }

    return Array.from(moduleMap.entries())
      .map(([path, { symbols, filePaths }]) => ({
        path,
        symbols,
        fileCount: filePaths.size,
      }))
      .sort((a, b) => {
        const aTotal = a.symbols.reduce((sum, s) => sum + s.referenceCount, 0);
        const bTotal = b.symbols.reduce((sum, s) => sum + s.referenceCount, 0);
        return bTotal - aTotal;
      });
```

Note: `file_path` is already in the query's SELECT (line 184). We derive file count from distinct file paths per module — no extra query needed.

- [ ] **Step 3: Write failing tests for standalone files**

Add to `tests/output/modules-generator.test.ts`:

```typescript
  it('renders single-file modules in standalone section', () => {
    const modules: ModuleInfo[] = [
      {
        path: 'app/Services',
        fileCount: 5,
        symbols: [{ qualifiedName: 'App\\Services\\UserService', kind: 'class', linesOfCode: 100, implements: [], extends: null, traits: [], referenceCount: 10 }],
      },
      {
        path: 'objects/PermissionFunctions.php',
        fileCount: 1,
        symbols: Array.from({ length: 20 }, (_, i) => ({
          qualifiedName: `PermissionFunctions::method${i}`,
          kind: 'class',
          linesOfCode: 10,
          implements: [],
          extends: null,
          traits: [],
          referenceCount: 5 - (i % 5),
        })),
      },
    ];
    const result = generateModules(modules);
    expect(result).toContain('## Standalone Files');
    expect(result).toContain('| objects/PermissionFunctions.php |');
    // Should NOT appear as a regular module heading
    expect(result).not.toContain('## objects/PermissionFunctions.php (');
  });

  it('limits standalone files to 10', () => {
    const modules: ModuleInfo[] = Array.from({ length: 15 }, (_, i) => ({
      path: `objects/File${i}.php`,
      fileCount: 1,
      symbols: [{ qualifiedName: `File${i}`, kind: 'class', linesOfCode: 50, implements: [], extends: null, traits: [], referenceCount: 0 }],
    }));
    const result = generateModules(modules);
    expect(result).toContain('... and 5 more');
  });

  it('renders test modules as summary line', () => {
    const modules: ModuleInfo[] = [
      {
        path: 'app/Services',
        fileCount: 5,
        symbols: [{ qualifiedName: 'App\\Services\\UserService', kind: 'class', linesOfCode: 100, implements: [], extends: null, traits: [], referenceCount: 10 }],
      },
      {
        path: 'tests/objects',
        fileCount: 50,
        symbols: Array.from({ length: 100 }, (_, i) => ({
          qualifiedName: `Tests\\Objects\\Test${i}`,
          kind: 'class',
          linesOfCode: 30,
          implements: [],
          extends: null,
          traits: [],
          referenceCount: 0,
        })),
      },
    ];
    const result = generateModules(modules);
    expect(result).toContain('**Test suite:**');
    expect(result).toContain('100');
    expect(result).toContain('tests/objects');
    // Should NOT appear as a regular module heading
    expect(result).not.toContain('## tests/objects');
  });
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/output/modules-generator.test.ts`
Expected: FAIL — generator doesn't have standalone section

- [ ] **Step 5: Implement standalone file rendering**

Replace the content of `src/output/modules-generator.ts`:

```typescript
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

  // Production modules
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

  // Standalone files
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

  // Test suite summary
  if (test.length > 0) {
    const testSymbols = test.reduce((sum, m) => sum + m.symbols.length, 0);
    const testDirs = test.map(m => m.path).join(', ');
    lines.push(`**Test suite:** ${testSymbols.toLocaleString()} symbols across ${testDirs}\n`);
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
```

- [ ] **Step 6: Update existing module tests to include `fileCount`**

In `tests/output/modules-generator.test.ts`, update the `makeModules` helper to include `fileCount` so existing tests don't become standalone modules:

```typescript
function makeModules(count = 3, symbolsPerModule = 5): ModuleInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `app/Module${i}`,
    fileCount: symbolsPerModule, // multiple files = not standalone
    symbols: Array.from({ length: symbolsPerModule }, (_, j) => ({
      qualifiedName: `App\\Module${i}\\Class${j}`,
      kind: 'class',
      linesOfCode: 50,
      implements: j === 0 ? [`App\\Contracts\\Interface${i}`] : [],
      extends: j === 1 ? `App\\Base\\BaseClass` : null,
      traits: [],
      referenceCount: 10 - j,
    })),
  }));
}
```

Also check the integration test at `tests/integration/generate.test.ts`. The test `'modules.md lists fixture classes'` asserts `UserService` and `UserController` appear in the output. The fixture's `app/` directory has multiple files, so `fileCount > 1` and it won't be treated as standalone. These assertions should still pass. Verify by running the integration tests in Step 7.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/output/modules-generator.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/output/modules-generator.ts src/output/generate-pipeline.ts tests/output/modules-generator.test.ts
git commit -m "feat: separate standalone files and test modules in modules.md"
```

---

### Task 4: Architecture description uses conventions data (#3)

**Files:**
- Modify: `src/output/root-generator.ts`
- Modify: `src/output/generate-pipeline.ts:111`
- Modify: `tests/output/root-generator.test.ts`

- [ ] **Step 1: Write failing test for stats-aware architecture**

Add to `tests/output/root-generator.test.ts`:

```typescript
import type { ConventionsData } from '../../src/output/generate-pipeline.js';

function makeConventions(overrides: Partial<ConventionsData> = {}): ConventionsData {
  return {
    totalClasses: 100,
    totalInterfaces: 20,
    totalTraits: 10,
    totalEnums: 0,
    classesWithInterface: 45,
    classesWithInheritance: 60,
    classesWithTraits: 15,
    interfaceAdoptionByModule: new Map(),
    classNames: [],
    methodNames: [],
    ...overrides,
  };
}
```

And add tests:

```typescript
  it('qualifies interface contracts when adoption is low', () => {
    const stats = makeStats({
      directories: [
        { path: 'objects/Interfaces', fileCount: 50, symbolCount: 168, classCount: 0, dominantKinds: ['interface'] },
        { path: 'objects/Entity', fileCount: 100, symbolCount: 500, classCount: 500, dominantKinds: ['class'] },
      ],
    });
    const conventions = makeConventions({
      totalClasses: 15000,
      classesWithInterface: 39,
    });
    const result = generateRoot(stats, conventions);
    expect(result).toContain('interface');
    expect(result).toContain('low');
    expect(result).not.toContain('uses interface contracts');
  });

  it('confirms interface contracts when adoption is high', () => {
    const stats = makeStats({
      directories: [
        { path: 'app/Contracts', fileCount: 20, symbolCount: 50, classCount: 0, dominantKinds: ['interface'] },
        { path: 'app/Services', fileCount: 30, symbolCount: 100, classCount: 100, dominantKinds: ['class'] },
      ],
    });
    const conventions = makeConventions({
      totalClasses: 100,
      classesWithInterface: 45,
    });
    const result = generateRoot(stats, conventions);
    expect(result).toContain('interface contracts');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/output/root-generator.test.ts`
Expected: FAIL — `generateRoot` doesn't accept conventions parameter

- [ ] **Step 3: Update `generateRoot()` to accept conventions data**

In `src/output/root-generator.ts`, change the function signature and architecture detection:

```typescript
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
  const inheritanceAdoption = conventions && conventions.totalClasses > 0
    ? Math.round((conventions.classesWithInheritance / conventions.totalClasses) * 100)
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
    if (interfaceAdoption !== null && interfaceAdoption < 5) {
      patterns.push(`dedicated interfaces directory (adoption low at ${interfaceAdoption}%)`);
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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

- [ ] **Step 4: Update the pipeline to pass conventions to root generator**

In `src/output/generate-pipeline.ts`, in the `run()` method, query conventions before generating root (reorder the calls):

```typescript
    const repoStats = await this.queryRepoStats(repo.id);
    const conventions = await this.queryConventions(repo.id);

    writeFileSync(`${outputDir}/CLAUDE.md`, HEADER + generateRoot(repoStats, conventions));

    const modules = await this.queryModules(repo.id);
    writeFileSync(`${outputDir}/modules.md`, HEADER + generateModules(modules));

    const deps = await this.queryDependencies(repo.id);
    writeFileSync(`${outputDir}/dependencies.md`, HEADER + generateDeps(deps));

    writeFileSync(`${outputDir}/conventions.md`, HEADER + generateConventions(conventions));
```

- [ ] **Step 5: Update existing root generator tests**

Existing tests call `generateRoot(makeStats())` without conventions — since the param is optional, they still work. But update the test for `detects architecture from directory names` to also verify the conventions-aware path:

The existing tests should still pass since `conventions` is optional. Verify.

- [ ] **Step 6: Run all tests to verify**

Run: `npx vitest run tests/output/root-generator.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/output/root-generator.ts src/output/generate-pipeline.ts tests/output/root-generator.test.ts
git commit -m "fix: architecture description uses conventions stats to qualify claims"
```

---

### Task 5: Run full test suite and integration tests

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run`
Expected: All pass (should be ~96+ tests)

- [ ] **Step 2: Run integration tests specifically**

Run: `npx vitest run tests/integration/generate.test.ts`
Expected: PASS — integration tests use fixture data with `fileCount` etc.

If integration tests fail due to `fileCount` not being in fixture query results, fix the fixture expectations.

- [ ] **Step 3: Commit any integration test fixes**

```bash
git add -A
git commit -m "fix: update integration tests for generator polish changes"
```

---

## Chunk 2: Indexer Fix (#1)

### Task 6: Case-insensitive reference resolution

**Files:**
- Modify: `src/indexer/reference-extractor.ts:337-352`
- Modify: `src/db/repositories/reference-repository.ts:55-70`
- Create: `src/db/migrations/006_add-lowercase-qualified-index.sql`
- Modify: `tests/indexer/reference-extractor.test.ts`

- [ ] **Step 1: Write failing test for lowercase target resolution**

Add to `tests/indexer/reference-extractor.test.ts`:

```typescript
  describe('case normalization', () => {
    it('lowercases target qualified names', () => {
      const refs = parseAndExtract(`<?php
        namespace App\\Models;
        use Illuminate\\Database\\Eloquent\\Model;
        class User extends Model {}
      `);

      const inheritance = refs.filter(r => r.kind === 'inheritance');
      expect(inheritance[0].targetQualifiedName).toBe('illuminate\\database\\eloquent\\model');
    });

    it('lowercases instantiation targets', () => {
      const refs = parseAndExtract(`<?php
        namespace App\\Services;
        use App\\Repositories\\UserRepository;
        class UserService {
            public function init(): void {
                $repo = new UserRepository();
            }
        }
      `);

      const insts = refs.filter(r => r.kind === 'instantiation');
      expect(insts[0].targetQualifiedName).toBe('app\\repositories\\userrepository');
    });

    it('preserves source qualified name case', () => {
      const refs = parseAndExtract(`<?php
        namespace App\\Models;
        use Illuminate\\Database\\Eloquent\\Model;
        class User extends Model {}
      `);

      const inheritance = refs.filter(r => r.kind === 'inheritance');
      expect(inheritance[0].sourceQualifiedName).toBe('App\\Models\\User');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/reference-extractor.test.ts`
Expected: FAIL — targets currently preserve original case

- [ ] **Step 3: Add `.toLowerCase()` to reference extractor's `resolveTypeName()`**

In `src/indexer/reference-extractor.ts`, modify the `resolveTypeName` function (around line 337):

```typescript
function resolveTypeName(name: string, context: NamespaceContext): string {
  if (name.startsWith('\\')) return name.substring(1).toLowerCase();

  const firstPart = name.split('\\')[0];
  if (context.imports.has(firstPart)) {
    const resolved = context.imports.get(firstPart)!;
    const rest = name.substring(firstPart.length);
    return (resolved + rest).toLowerCase();
  }

  if (context.namespace) {
    return `${context.namespace}\\${name}`.toLowerCase();
  }

  return name.toLowerCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/reference-extractor.test.ts`
Expected: Some existing tests will fail because they assert original-case targets. Update them.

- [ ] **Step 5: Update existing reference extractor tests**

All `targetQualifiedName` assertions need to be lowercased. For example:

```typescript
expect(inheritance[0].targetQualifiedName).toBe('illuminate\\database\\eloquent\\model');
// was: 'Illuminate\\Database\\Eloquent\\Model'

expect(impls[0].targetQualifiedName).toBe('app\\contracts\\userserviceinterface');
// was: 'App\\Contracts\\UserServiceInterface'
```

Update ALL `targetQualifiedName` expectations in the test file to be lowercase. The `sourceQualifiedName` assertions stay as-is (original case).

Note: `$this->method()` self_call targets use the class QN from the symbol (which is NOT lowercased by this change — it comes from `php.ts`'s `qualifyName`). But the reference extractor builds self_call targets as `${classQN}::${memberName.text}`. Since `classQN` comes from `classSymbol.qualifiedName` (original case from the parser), self_call targets will be mixed case. This is acceptable because self_calls resolve against the same class's methods, which have the same case prefix. However, for consistency, we should lowercase the full target:

In `extractBodyReferences()` (line 244):
```typescript
const sourceQN = `${classSymbol.qualifiedName}::${methodName}`;
```

This is the SOURCE, which stays original case. But in `walkForReferences`, the self_call target at line 320:
```typescript
targetQualifiedName: `${classQN}::${memberName.text}`,
```

Change to:
```typescript
targetQualifiedName: `${classQN}::${memberName.text}`.toLowerCase(),
```

And similarly for static_call (line 288) and static_access (line 305) and instantiation (line 270) — but wait, these already go through `resolveTypeName()` which now lowercases. Only the `::method` suffix appended after `resolveTypeName()` is not lowercased. Fix:

For `static_call` (line 288):
```typescript
targetQualifiedName: `${resolveTypeName(className, context)}::${memberNode.text}`.toLowerCase(),
```

Actually, `resolveTypeName()` already returns lowercase now, so we just need to lowercase `memberNode.text`:
```typescript
targetQualifiedName: `${resolveTypeName(className, context)}::${memberNode.text.toLowerCase()}`,
```

Apply the same to `static_access` (line 305) and `self_call` (line 320):

```typescript
// static_access
targetQualifiedName: `${resolveTypeName(className, context)}::${memberNode.text.toLowerCase()}`,

// self_call
targetQualifiedName: `${classQN}::${memberName.text}`.toLowerCase(),
```

- [ ] **Step 6: Run all reference extractor tests**

Run: `npx vitest run tests/indexer/reference-extractor.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/indexer/reference-extractor.ts tests/indexer/reference-extractor.test.ts
git commit -m "fix: lowercase all reference target qualified names for case-insensitive resolution"
```

---

### Task 7: Update `resolveTargets()` and add migration

**Files:**
- Modify: `src/db/repositories/reference-repository.ts:56-62`
- Create: `src/db/migrations/006_add-lowercase-qualified-index.sql`

- [ ] **Step 1: Create the migration file**

Create `src/db/migrations/006_add-lowercase-qualified-index.sql`:

```sql
CREATE INDEX IF NOT EXISTS idx_symbols_qualified_lower ON symbols(LOWER(qualified_name));
```

- [ ] **Step 2: Update `resolveTargets()` to use `LOWER()`**

In `src/db/repositories/reference-repository.ts`, change the UPDATE query (line 57):

```typescript
  async resolveTargets(repoId: number): Promise<{ resolved: number; unresolved: number }> {
    const { rowCount: resolved } = await this.pool.query(
      `UPDATE symbol_references sr
       SET target_symbol_id = s.id
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = $1
         AND sr.target_qualified_name = LOWER(s.qualified_name)
         AND sr.target_symbol_id IS NULL
         AND sr.source_symbol_id IN (
           SELECT id FROM symbols WHERE file_id IN (
             SELECT id FROM files WHERE repo_id = $1
           )
         )`,
      [repoId]
    );

    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = $1 AND sr.target_symbol_id IS NULL`,
      [repoId]
    );

    return {
      resolved: resolved || 0,
      unresolved: rows[0].count as number,
    };
  }
```

- [ ] **Step 3: Run the migration**

Run: `npm run dev -- migrate` (or however migrations are run)

If there's no CLI command for migrations, run it directly:
```bash
psql -h localhost -p 5435 -U cartograph -d cartograph -f src/db/migrations/006_add-lowercase-qualified-index.sql
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/reference-repository.ts src/db/migrations/006_add-lowercase-qualified-index.sql
git commit -m "feat: case-insensitive reference resolution with functional index"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 2: Verify against fixture data**

Run: `npx vitest run tests/integration/generate.test.ts`
Expected: All 6 integration tests pass

- [ ] **Step 3: Commit any remaining fixes**

If any tests needed adjustment, commit them.

```bash
git add -A
git commit -m "chore: final test adjustments for generate output polish"
```
