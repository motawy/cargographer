import { Command } from 'commander';
import { indexRepo } from './index-shared.js';

export function createIndexCommand(): Command {
  return new Command('index')
    .description('Build or update the codebase index')
    .argument('<repo-path>', 'Path to the repository to index')
    .option('--verbose', 'Log every file as it is processed')
    .option('--log <path>', 'Write full log output to a file')
    .action(async (repoPath: string, opts: { verbose?: boolean; log?: string }) => {
      try {
        console.log('Running migrations...');
        const result = await indexRepo(repoPath, {
          verbose: opts.verbose,
          log: opts.log,
        });
        if (result.schemaImportSummary) {
          console.log(
            `DB schema: imported ${result.schemaImportSummary.tables} tables, ` +
            `${result.schemaImportSummary.columns} columns, ` +
            `${result.schemaImportSummary.foreignKeys} foreign keys from PostgreSQL`
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exitCode = 1;
      }
    });
}
