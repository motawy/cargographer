import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { FileRepository } from '../db/repositories/file-repository.js';
import { SymbolRepository } from '../db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';
import { DbSchemaRepository } from '../db/repositories/db-schema-repository.js';
import { SymbolSchemaRepository } from '../db/repositories/symbol-schema-repository.js';
import { TableReferenceRepository } from '../db/repositories/table-reference-repository.js';
import type { ToolDeps, RepoStats } from './types.js';
import { handleFind } from './tools/find.js';
import { handleSymbol } from './tools/symbol.js';
import { handleDeps } from './tools/deps.js';
import { handleFlow } from './tools/flow.js';
import { handleDependents } from './tools/dependents.js';
import { handleBlastRadius } from './tools/blast-radius.js';
import { handleCompare } from './tools/compare.js';
import { handleCompareMany } from './tools/compare-many.js';
import { handleStatus } from './tools/status.js';
import { handleSchema } from './tools/schema.js';
import { handleTable } from './tools/table.js';
import { handleTableGraph } from './tools/table-graph.js';
import { handleSearchContent } from './tools/search-content.js';
import { handleScaffoldPlan } from './tools/scaffold-plan.js';
import { handleTableUsage } from './tools/table-usage.js';
import { handleTestTargets } from './tools/test-targets.js';

interface ServerOptions {
  db: Database.Database;
  repoId: number;
  repoPath?: string;
}

export function createServer(opts: ServerOptions): McpServer {
  const symbolRepo = new SymbolRepository(opts.db);
  const refRepo = new ReferenceRepository(opts.db);
  const schemaRepo = new DbSchemaRepository(opts.db);
  const fileRepo = new FileRepository(opts.db);
  const symbolSchemaRepo = new SymbolSchemaRepository(opts.db);
  const tableReferenceRepo = new TableReferenceRepository(opts.db);

  const deps: ToolDeps = {
    repoId: opts.repoId,
    repoPath: opts.repoPath,
    fileRepo,
    symbolRepo,
    refRepo,
    schemaRepo,
    symbolSchemaRepo,
    tableReferenceRepo,
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

  // --- cartograph_table ---
  server.tool(
    'cartograph_table',
    'Inspect current SQL table state: columns, outbound foreign keys, and inbound references from other tables.',
    {
      name: z.string().describe('Table name, optionally schema-qualified (e.g. "users", "public.orders")'),
    },
    async ({ name }) => wrap(() => handleTable(deps, { name }))
  );

  // --- cartograph_schema ---
  server.tool(
    'cartograph_schema',
    'List or search current database tables with column and foreign-key counts.',
    {
      query: z.string().optional().describe('Optional table-name search, e.g. "quote"'),
      limit: z.number().min(1).max(200).optional().describe('Max results (default 50)'),
    },
    async ({ query, limit }) => wrap(() => handleSchema(deps, { query, limit }))
  );

  // --- cartograph_table_graph ---
  server.tool(
    'cartograph_table_graph',
    'Traverse the foreign-key neighborhood around a table.',
    {
      name: z.string().describe('Table name, optionally schema-qualified (e.g. "quotes", "public.orders")'),
      depth: z.number().min(1).max(5).optional().describe('Traversal depth (default 1)'),
    },
    async ({ name, depth }) => wrap(() => handleTableGraph(deps, { name, depth }))
  );

  // --- cartograph_table_usage ---
  server.tool(
    'cartograph_table_usage',
    'Bridge schema to code: show mapped entities, mapped columns, entity-based touchpoints, indexed direct table-name references, and an explicit upstream framework-wiring section for a table. It climbs through table-backed adapters such as Models, Repositories, Builders, and DataObjects to surface controllers/routes above them. Best for table-to-code tracing; may still miss patterns with no explicit mapping, symbol reference, or table-name signal.',
    {
      name: z.string().describe('Table name, optionally schema-qualified. Use the full table name when partial matches are ambiguous.'),
      depth: z.number().min(1).max(5).optional().describe('Transitive entity-graph depth for code touchpoints (default 3)'),
      limit: z.number().min(1).max(100).optional().describe('Max touchpoints to show per section before test filtering (default 25)'),
      includeTests: z.boolean().optional().describe('Include test code in both touchpoints and direct table-name references (default false)'),
    },
    async ({ name, depth, limit, includeTests }) => wrap(() => handleTableUsage(deps, { name, depth, limit, includeTests }))
  );

  // --- cartograph_test_targets ---
  server.tool(
    'cartograph_test_targets',
    'Suggest likely test files for a symbol, file, or table using indexed structure, naming heuristics, and direct test-side signals such as imports, instantiations, and class references. Provide exactly one of symbol/file/table. Results are ranked suggestions, not an exhaustive list.',
    {
      symbol: z.string().optional().describe('Symbol to find relevant tests for. Mutually exclusive with file and table.'),
      file: z.string().optional().describe('File path relative to repo root. Mutually exclusive with symbol and table.'),
      table: z.string().optional().describe('Database table name. Mutually exclusive with symbol and file.'),
      limit: z.number().min(1).max(25).optional().describe('Max ranked suggestions to return (default 10)'),
    },
    async ({ symbol, file, table, limit }) => wrap(() => handleTestTargets(deps, { symbol, file, table, limit }))
  );

  // --- cartograph_scaffold_plan ---
  server.tool(
    'cartograph_scaffold_plan',
    'Plan the files and class names needed to mirror a reference slice for a new target stem. Also infers conventional concrete companions for Interface files when that pattern exists. Rename-based planning only: it does not write files and may miss framework/config wiring outside the indexed slice.',
    {
      reference: z.string().describe('Reference top-level symbol to mirror, usually a Route/Controller/Builder/Model-style class'),
      target: z.string().describe('Target stem or class-family name to substitute into the inferred slice'),
      depth: z.number().min(1).max(6).optional().describe('Forward traversal depth for collecting the reference slice (default 4). Larger values pull in more neighboring classes.'),
    },
    async ({ reference, target, depth }) => wrap(() => handleScaffoldPlan(deps, { reference, target, depth }))
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

  // --- cartograph_search_content ---
  server.tool(
    'cartograph_search_content',
    'Search indexed source content by literal substring and map matches back to enclosing symbols.',
    {
      query: z.string().describe('Literal text to search for inside indexed source files'),
      path: z.string().optional().describe('Optional file-path substring filter'),
      limit: z.number().min(1).max(100).optional().describe('Max matches (default 20)'),
    },
    async ({ query, path, limit }) => wrap(() => handleSearchContent(deps, { query, path, limit }))
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
    'Compare two symbols and show the structural delta — what methods/properties one has that the other doesn\'t, plus behavioral diffs in shared methods.',
    {
      symbolA: z.string().describe('First symbol name (fully or partially qualified)'),
      symbolB: z.string().describe('Second symbol name (fully or partially qualified)'),
      omitIdentical: z.boolean().optional().describe('Hide the "Shared — identical" section to focus only on deltas (default false)'),
    },
    async ({ symbolA, symbolB, omitIdentical }) => wrap(() => handleCompare(deps, { symbolA, symbolB, omitIdentical }))
  );

  // --- cartograph_compare_many ---
  server.tool(
    'cartograph_compare_many',
    'Compare one baseline symbol against multiple peers to spot missing methods, extra methods, and full inlined shared-method wiring/body differences. Identical shared methods are omitted by default. Symbol-level comparison only: it does not infer file lists to create.',
    {
      baseline: z.string().describe('Baseline symbol to use as the pattern or reference implementation'),
      others: z.array(z.string()).min(1).max(10).describe('One or more peer symbols to compare against the baseline. Best used for sibling classes in the same pattern family.'),
      includeIdentical: z.boolean().optional().describe('Include a summary of identical shared methods (default false)'),
    },
    async ({ baseline, others, includeIdentical }) => wrap(() => handleCompareMany(deps, { baseline, others, includeIdentical }))
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
