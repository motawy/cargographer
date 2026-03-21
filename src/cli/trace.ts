import { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';

export function createTraceCommand(): Command {
  return new Command('trace')
    .description('Trace execution flow forward from a symbol')
    .argument('<symbol>', 'Fully qualified symbol name to trace from')
    .option('--depth <n>', 'Maximum trace depth (default: 5)', '5')
    .option('--repo-path <path>', 'Repository path (for config loading)', '.')
    .action((symbol: string, opts: { depth: string; repoPath: string }) => {
      const config = loadConfig(opts.repoPath);
      const db = openDatabase(config.database);

      try {
        const repoPath = resolve(opts.repoPath);
        const repo = new RepoRepository(db).findByPath(repoPath);
        if (!repo) {
          console.error(`No index found for ${repoPath}. Run \`cartograph index\` first.`);
          process.exit(1);
        }

        const symbolRows = db.prepare(
          `SELECT s.id, s.qualified_name, s.kind
           FROM symbols s
           JOIN files f ON s.file_id = f.id
           WHERE f.repo_id = ? AND s.qualified_name = ?`
        ).all(repo.id, symbol) as { id: number; qualified_name: string; kind: string }[];

        if (symbolRows.length === 0) {
          console.error(`Symbol not found: ${symbol}`);
          process.exit(1);
        }

        const refRepo = new ReferenceRepository(db);
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
          const arrow = current.depth > 0 ? '\u2192 ' : '';
          console.log(`${indent}${current.depth + 1}. ${arrow}${current.qualifiedName}`);

          const deps = refRepo.findDependencies(current.symbolId);
          const callDeps = deps.filter(d =>
            ['static_call', 'self_call', 'instantiation'].includes(d.referenceKind)
          );

          for (const dep of callDeps) {
            if (dep.targetSymbolId && !visited.has(dep.targetSymbolId)) {
              const row = db.prepare(
                'SELECT qualified_name FROM symbols WHERE id = ?'
              ).get(dep.targetSymbolId) as { qualified_name: string } | undefined;
              if (row) {
                queue.push({
                  symbolId: dep.targetSymbolId,
                  qualifiedName: row.qualified_name,
                  depth: current.depth + 1,
                });
              }
            }
          }
        }
      } finally {
        db.close();
      }
    });
}
