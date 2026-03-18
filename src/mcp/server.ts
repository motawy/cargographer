import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { SymbolRepository } from '../db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';
import type { ToolDeps, RepoStats } from './types.js';
import { handleFind } from './tools/find.js';
import { handleSymbol } from './tools/symbol.js';
import { handleDeps } from './tools/deps.js';
import { handleFlow } from './tools/flow.js';
import { handleDependents } from './tools/dependents.js';
import { handleBlastRadius } from './tools/blast-radius.js';
import { handleCompare } from './tools/compare.js';
import { handleStatus } from './tools/status.js';

interface ServerOptions {
  db: Database.Database;
  repoId: number;
  repoPath?: string;
}

export function createServer(opts: ServerOptions): McpServer {
  const symbolRepo = new SymbolRepository(opts.db);
  const refRepo = new ReferenceRepository(opts.db);

  const deps: ToolDeps = {
    repoId: opts.repoId,
    repoPath: opts.repoPath,
    symbolRepo,
    refRepo,
  };

  const stats = computeRepoStats(opts.db, opts.repoId);

  const server = new McpServer({
    name: 'cartograph',
    version: '0.1.0',
  });

  // Error wrapper — catch DB errors, format as user-facing text, log to stderr.
  function wrap(fn: () => string): Promise<{ content: { type: 'text'; text: string }[] }> {
    try {
      const text = fn();
      return Promise.resolve({ content: [{ type: 'text' as const, text }] });
    } catch (err) {
      console.error('Cartograph tool error:', err);
      const message = err instanceof Error ? err.message : String(err);
      return Promise.resolve({ content: [{ type: 'text' as const, text: `Database error: ${message}` }] });
    }
  }

  // --- cartograph_status ---
  server.tool(
    'cartograph_status',
    'Check index health: when it was last built, how many symbols/files are indexed, and whether a re-index is needed',
    {},
    async () => wrap(() => handleStatus({ db: opts.db, repoId: opts.repoId }))
  );

  // --- cartograph_find ---
  server.tool(
    'cartograph_find',
    'Search for symbols by name. Use kind and path filters to narrow results in large codebases.',
    {
      query: z.string().describe('Class or symbol name to search for (e.g. "UserService", "RecurringJobs*"). Always matches anywhere in the qualified name.'),
      kind: z.enum(['class', 'interface', 'trait', 'method', 'function', 'property', 'constant', 'enum']).optional().describe('Filter by symbol kind'),
      path: z.string().optional().describe('Filter by file path prefix (e.g. "app/Services", "src/Routes/Root")'),
      limit: z.number().min(1).max(50).optional().describe('Max results (default 20)'),
    },
    async ({ query, kind, path, limit }) => wrap(() => handleFind(deps, { query, kind, path, limit }))
  );

  // --- cartograph_symbol ---
  server.tool(
    'cartograph_symbol',
    'Look up a class/interface/function and its relationships. Use deep=true on Route/Controller/Builder classes to see the full vertical stack in one call.',
    {
      name: z.string().describe('Fully or partially qualified symbol name'),
      deep: z.boolean().optional().describe('Show full vertical stack: inheritance, wiring (class_reference), implementors, and depth-2 wiring detail'),
    },
    async ({ name, deep }) => wrap(() => handleSymbol(deps, stats, { name, deep }))
  );

  // --- cartograph_deps ---
  server.tool(
    'cartograph_deps',
    'What does this symbol depend on? (forward dependency graph)',
    {
      symbol: z.string().describe('Fully qualified symbol name'),
      depth: z.number().min(1).max(10).optional().describe('Max traversal depth (default 3)'),
    },
    async ({ symbol, depth }) => wrap(() => handleDeps(deps, { symbol, depth }))
  );

  // --- cartograph_dependents ---
  server.tool(
    'cartograph_dependents',
    'What depends on this symbol? (reverse dependency lookup)',
    {
      symbol: z.string().describe('Fully qualified symbol name'),
      depth: z.number().min(1).max(5).optional().describe('Transitive depth (default 1)'),
    },
    async ({ symbol, depth }) => wrap(() => handleDependents(deps, { symbol, depth }))
  );

  // --- cartograph_blast_radius ---
  server.tool(
    'cartograph_blast_radius',
    'What breaks if this file changes?',
    {
      file: z.string().describe('File path relative to repo root'),
      depth: z.number().min(1).max(5).optional().describe('Transitive impact depth (default 2)'),
    },
    async ({ file, depth }) => wrap(() => handleBlastRadius(deps, { file, depth }))
  );

  // --- cartograph_compare ---
  server.tool(
    'cartograph_compare',
    'Compare two symbols and show the structural delta — what methods/properties one has that the other doesn\'t',
    {
      symbolA: z.string().describe('First symbol name (fully or partially qualified)'),
      symbolB: z.string().describe('Second symbol name (fully or partially qualified)'),
    },
    async ({ symbolA, symbolB }) => wrap(() => handleCompare(deps, { symbolA, symbolB }))
  );

  // --- cartograph_flow ---
  server.tool(
    'cartograph_flow',
    'Trace an execution flow end-to-end from an entrypoint',
    {
      symbol: z.string().describe('Fully qualified symbol name (entrypoint)'),
      depth: z.number().min(1).max(15).optional().describe('Max trace depth (default 5)'),
    },
    async ({ symbol, depth }) => wrap(() => handleFlow(deps, { symbol, depth }))
  );

  return server;
}

function computeRepoStats(db: Database.Database, repoId: number): RepoStats {
  const row = db.prepare(
    `SELECT
       COUNT(*) AS total_classes,
       SUM(CASE WHEN EXISTS (
         SELECT 1 FROM symbol_references sr WHERE sr.source_symbol_id = s.id AND sr.reference_kind = 'implementation'
       ) THEN 1 ELSE 0 END) AS with_interface,
       SUM(CASE WHEN EXISTS (
         SELECT 1 FROM symbol_references sr WHERE sr.source_symbol_id = s.id AND sr.reference_kind = 'inheritance'
       ) THEN 1 ELSE 0 END) AS with_base_class,
       SUM(CASE WHEN EXISTS (
         SELECT 1 FROM symbol_references sr WHERE sr.source_symbol_id = s.id AND sr.reference_kind = 'trait_use'
       ) THEN 1 ELSE 0 END) AS with_traits
     FROM symbols s
     JOIN files f ON s.file_id = f.id
     WHERE f.repo_id = ? AND s.kind = 'class'`
  ).get(repoId) as Record<string, number>;
  return {
    totalClasses: row.total_classes ?? 0,
    classesWithInterface: row.with_interface ?? 0,
    classesWithBaseClass: row.with_base_class ?? 0,
    classesWithTraits: row.with_traits ?? 0,
  };
}
