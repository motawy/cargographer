import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createPool } from '../db/connection.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';

export function createUsesCommand(): Command {
  return new Command('uses')
    .description('Find what uses a given symbol')
    .argument('<symbol>', 'Fully qualified symbol name')
    .option('--depth <n>', 'Depth of transitive search (default: 1)', '1')
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
          console.error('Hint: Use fully qualified names, e.g. App\\\\Services\\\\UserService::findById');
          process.exit(1);
        }

        const refRepo = new ReferenceRepository(pool);
        const depth = parseInt(opts.depth, 10);
        const dependents = await refRepo.findDependents(symbolRows[0].id, depth);

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
        await pool.end();
      }
    });
}
