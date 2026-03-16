import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createPool } from '../db/connection.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';

export function createImpactCommand(): Command {
  return new Command('impact')
    .description('Show what is affected by changes to a file')
    .argument('<file>', 'File path relative to repo root')
    .option('--depth <n>', 'Depth of transitive impact (default: 3)', '3')
    .option('--repo-path <path>', 'Repository path (for config loading)', '.')
    .action(async (file: string, opts: { depth: string; repoPath: string }) => {
      const config = loadConfig(opts.repoPath);
      const pool = createPool(config.database);

      try {
        const { rows: fileSymbols } = await pool.query(
          `SELECT s.id, s.qualified_name, s.kind
           FROM symbols s
           JOIN files f ON s.file_id = f.id
           WHERE f.path = $1`,
          [file]
        );

        if (fileSymbols.length === 0) {
          console.error(`No symbols found in file: ${file}`);
          console.error('Hint: Use the path relative to the repo root, e.g. app/Services/UserService.php');
          process.exit(1);
        }

        const refRepo = new ReferenceRepository(pool);
        const depth = parseInt(opts.depth, 10);

        const allDependents = new Map<string, { qualifiedName: string; filePath: string; kind: string }>();

        for (const sym of fileSymbols) {
          const deps = await refRepo.findDependents(sym.id, depth);
          for (const dep of deps) {
            const sourceQN = dep.source_qualified_name as string;
            const filePath = dep.source_file_path as string;
            if (sourceQN && !allDependents.has(sourceQN)) {
              allDependents.set(sourceQN, {
                qualifiedName: sourceQN,
                filePath: filePath || 'unknown',
                kind: dep.reference_kind as string,
              });
            }
          }
        }

        if (allDependents.size === 0) {
          console.log(`No dependents found for ${file}`);
          return;
        }

        // Group by file
        const byFile = new Map<string, string[]>();
        for (const dep of allDependents.values()) {
          const list = byFile.get(dep.filePath) || [];
          list.push(dep.qualifiedName);
          byFile.set(dep.filePath, list);
        }

        console.log(`\nImpact analysis: ${file}`);
        console.log(`Symbols in file: ${fileSymbols.length}`);
        console.log(`Affected files: ${byFile.size}\n`);

        for (const [filePath, symbols] of byFile) {
          console.log(`  ${filePath}`);
          for (const sym of symbols) {
            console.log(`    → ${sym}`);
          }
        }
      } finally {
        await pool.end();
      }
    });
}
