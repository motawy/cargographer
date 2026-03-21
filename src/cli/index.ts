import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { IndexPipeline } from '../indexer/pipeline.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { importSchemaForRepo } from './schema-import.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createIndexCommand(): Command {
  return new Command('index')
    .description('Build or update the codebase index')
    .argument('<repo-path>', 'Path to the repository to index')
    .option('--run-migrations', 'Run database migrations before indexing')
    .option('--verbose', 'Log every file as it is processed')
    .option('--log <path>', 'Write full log output to a file')
    .action(async (repoPath: string, opts: { runMigrations?: boolean; verbose?: boolean; log?: string }) => {
      const config = loadConfig(repoPath);
      const db = openDatabase(config.database);

      try {
        if (opts.runMigrations || config.schemaSource?.type === 'postgres') {
          console.log('Running migrations...');
          runMigrations(
            db,
            join(__dirname, '..', 'db', 'migrations')
          );
        }

        const pipeline = new IndexPipeline(db);
        pipeline.run(repoPath, config, {
          verbose: opts.verbose,
          logFile: opts.log,
        });

        if (config.schemaSource?.type === 'postgres') {
          const summary = await importSchemaForRepo(db, repoPath, config);
          console.log(
            `DB schema: imported ${summary.tables} tables, ${summary.columns} columns, ` +
            `${summary.foreignKeys} foreign keys from PostgreSQL`
          );
        }
      } finally {
        db.close();
      }
    });
}
