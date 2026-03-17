import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type pg from 'pg';
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
  pool: pg.Pool;
  repoId: number;
}

export async function createServer(opts: ServerOptions): Promise<McpServer> {
  const symbolRepo = new SymbolRepository(opts.pool);
  const refRepo = new ReferenceRepository(opts.pool);

  const deps: ToolDeps = {
    repoId: opts.repoId,
    symbolRepo,
    refRepo,
  };

  const stats = await computeRepoStats(opts.pool, opts.repoId);

  const server = new McpServer({
    name: 'cartograph',
    version: '0.1.0',
  });

  // Error wrapper — catch DB errors, format as user-facing text, log to stderr.
  function wrap(fn: () => Promise<string>): Promise<{ content: { type: 'text'; text: string }[] }> {
    return fn()
      .then(text => ({ content: [{ type: 'text' as const, text }] }))
      .catch(err => {
        console.error('Cartograph tool error:', err);
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Database error: ${message}` }] };
      });
  }

  // --- cartograph_status ---
  server.tool(
    'cartograph_status',
    'Check index health: when it was last built, how many symbols/files are indexed, and whether a re-index is needed',
    {},
    async () => wrap(() => handleStatus({ pool: opts.pool, repoId: opts.repoId }))
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
    'Look up a class/interface/function and its relationships',
    { name: z.string().describe('Fully or partially qualified symbol name') },
    async ({ name }) => wrap(() => handleSymbol(deps, stats, { name }))
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

async function computeRepoStats(pool: pg.Pool, repoId: number): Promise<RepoStats> {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total_classes,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM symbol_references sr WHERE sr.source_symbol_id = s.id AND sr.reference_kind = 'implementation'
       ))::int AS with_interface,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM symbol_references sr WHERE sr.source_symbol_id = s.id AND sr.reference_kind = 'inheritance'
       ))::int AS with_base_class,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM symbol_references sr WHERE sr.source_symbol_id = s.id AND sr.reference_kind = 'trait_use'
       ))::int AS with_traits
     FROM symbols s
     JOIN files f ON s.file_id = f.id
     WHERE f.repo_id = $1 AND s.kind = 'class'`,
    [repoId]
  );
  return {
    totalClasses: rows[0].total_classes,
    classesWithInterface: rows[0].with_interface,
    classesWithBaseClass: rows[0].with_base_class,
    classesWithTraits: rows[0].with_traits,
  };
}
