import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createPool } from '../db/connection.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';

export function createTraceCommand(): Command {
  return new Command('trace')
    .description('Trace execution flow forward from a symbol')
    .argument('<symbol>', 'Fully qualified symbol name to trace from')
    .option('--depth <n>', 'Maximum trace depth (default: 5)', '5')
    .option('--repo-path <path>', 'Repository path (for config loading)', '.')
    .action(async (symbol: string, opts: { depth: string; repoPath: string }) => {
      const config = loadConfig(opts.repoPath);
      const pool = createPool(config.database);

      try {
        const { rows: symbolRows } = await pool.query(
          'SELECT id, qualified_name, kind FROM symbols WHERE qualified_name = $1',
          [symbol]
        );

        if (symbolRows.length === 0) {
          console.error(`Symbol not found: ${symbol}`);
          process.exit(1);
        }

        const refRepo = new ReferenceRepository(pool);
        const maxDepth = parseInt(opts.depth, 10);

        console.log(`\nTrace: ${symbol}\n`);

        // BFS trace
        const visited = new Set<number>();
        const queue: { symbolId: number; qualifiedName: string; depth: number }[] = [
          { symbolId: symbolRows[0].id, qualifiedName: symbol, depth: 0 },
        ];

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (visited.has(current.symbolId)) continue;
          if (current.depth > maxDepth) continue;
          visited.add(current.symbolId);

          const indent = '  '.repeat(current.depth);
          const arrow = current.depth > 0 ? '→ ' : '';
          console.log(`${indent}${current.depth + 1}. ${arrow}${current.qualifiedName}`);

          const deps = await refRepo.findDependencies(current.symbolId);
          const callDeps = deps.filter(d =>
            ['static_call', 'self_call', 'instantiation'].includes(d.referenceKind)
          );

          for (const dep of callDeps) {
            if (dep.targetSymbolId && !visited.has(dep.targetSymbolId)) {
              const { rows } = await pool.query(
                'SELECT qualified_name FROM symbols WHERE id = $1',
                [dep.targetSymbolId]
              );
              if (rows.length > 0) {
                queue.push({
                  symbolId: dep.targetSymbolId,
                  qualifiedName: rows[0].qualified_name,
                  depth: current.depth + 1,
                });
              }
            }
          }
        }
      } finally {
        await pool.end();
      }
    });
}
