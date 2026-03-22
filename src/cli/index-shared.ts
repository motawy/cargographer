import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { IndexPipeline } from '../indexer/pipeline.js';
import { importSchemaForRepo } from './schema-import.js';
import type { PostgresSchemaSourceConfig } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface IndexRepoOptions {
  verbose?: boolean;
  log?: string;
  postgresOverrides?: Partial<PostgresSchemaSourceConfig>;
}

export interface IndexRepoResult {
  repoPath: string;
  schemaImportSummary: { tables: number; columns: number; foreignKeys: number } | null;
}

export async function indexRepo(
  repoPath: string,
  opts: IndexRepoOptions = {}
): Promise<IndexRepoResult> {
  const absoluteRepoPath = resolve(repoPath);
  const config = loadConfig(absoluteRepoPath);
  const db = openDatabase(config.database);

  try {
    runMigrations(db, join(__dirname, '..', 'db', 'migrations'));

    const pipeline = new IndexPipeline(db);
    pipeline.run(absoluteRepoPath, config, {
      verbose: opts.verbose,
      logFile: opts.log,
    });

    let schemaImportSummary: { tables: number; columns: number; foreignKeys: number } | null = null;
    if (config.schemaSource?.type === 'postgres') {
      schemaImportSummary = await importSchemaForRepo(db, absoluteRepoPath, config, opts.postgresOverrides);
    }

    return {
      repoPath: absoluteRepoPath,
      schemaImportSummary,
    };
  } finally {
    db.close();
  }
}
