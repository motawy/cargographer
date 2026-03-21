import { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';

export function createUsesCommand(): Command {
  return new Command('uses')
    .description('Find what uses a given symbol')
    .argument('<symbol>', 'Fully qualified symbol name')
    .option('--depth <n>', 'Depth of transitive search (default: 1)', '1')
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
          console.error('Hint: Use fully qualified names, e.g. App\\\\Services\\\\UserService::findById');
          process.exit(1);
        }

        const refRepo = new ReferenceRepository(db);
        const depth = parseInt(opts.depth, 10);
        const dependents = refRepo.findDependents(symbolRows[0].id, depth);

        if (dependents.length === 0) {
          console.log(`No references found for ${symbol}`);
          return;
        }

        console.log(`\nSymbol: ${symbol} (${symbolRows[0].kind})`);
        console.log(`Found ${dependents.length} reference(s):\n`);

        for (const dep of dependents) {
          const sourceQN = dep.source_qualified_name || 'unknown';
          const filePath = dep.source_file_path || 'unknown';
          const kind = dep.reference_kind || '?';
          const line = dep.line_number || '?';
          console.log(`  ${sourceQN} (${kind}, line ${line})`);
          console.log(`    ${filePath}`);
        }
      } finally {
        db.close();
      }
    });
}
