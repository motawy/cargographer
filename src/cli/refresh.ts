import { Command } from 'commander';
import type { PostgresSchemaSourceConfig } from '../types.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { indexRepo } from './index-shared.js';
import { updateClaudeMdSection } from './setup-shared.js';

interface RefreshCliOptions {
  claudeMd?: string;
  verbose?: boolean;
  log?: string;
  dbHost?: string;
  dbPort?: string;
  dbUser?: string;
  dbPassword?: string;
  dbName?: string;
}

export interface RefreshRepoResult {
  claudeMdPath: string;
  claudeMdVerb: 'Added' | 'Updated';
  removedLegacyFiles: string[];
  schemaImportSummary: { tables: number; columns: number; foreignKeys: number } | null;
}

export async function refreshRepo(
  repoPath: string,
  opts: RefreshCliOptions = {}
): Promise<RefreshRepoResult> {
  const postgresOverrides = toPostgresOverrides(opts);
  const indexResult = await indexRepo(repoPath, {
    verbose: opts.verbose,
    log: opts.log,
    postgresOverrides,
  });

  const config = loadConfig(repoPath);
  const db = openDatabase(config.database);
  try {
    const generateResult = updateClaudeMdSection(db, repoPath, opts.claudeMd);
    return {
      claudeMdPath: generateResult.path,
      claudeMdVerb: generateResult.verb,
      removedLegacyFiles: generateResult.removedLegacyFiles,
      schemaImportSummary: indexResult.schemaImportSummary,
    };
  } finally {
    db.close();
  }
}

export function createRefreshCommand(): Command {
  return new Command('refresh')
    .description('Run the full Cartograph refresh flow: migrate, reindex, import live schema when configured, and update CLAUDE.md')
    .argument('[repo-path]', 'Path to the repository', '.')
    .option('--claude-md <path>', 'Path to CLAUDE.md to inject into (default: auto-detect)')
    .option('--verbose', 'Log every file as it is processed during indexing')
    .option('--log <path>', 'Write a full index log to a file')
    .option('--db-host <host>', 'Override PostgreSQL host for live schema import')
    .option('--db-port <port>', 'Override PostgreSQL port for live schema import')
    .option('--db-user <user>', 'Override PostgreSQL user for live schema import')
    .option('--db-password <password>', 'Override PostgreSQL password for live schema import')
    .option('--db-name <name>', 'Override PostgreSQL database for live schema import')
    .action(async (repoPath: string, opts: RefreshCliOptions) => {
      try {
        console.log('Running Cartograph refresh...');
        const result = await refreshRepo(repoPath, opts);
        if (result.schemaImportSummary) {
          console.log(
            `Imported ${result.schemaImportSummary.tables} tables, ` +
            `${result.schemaImportSummary.columns} columns, ` +
            `${result.schemaImportSummary.foreignKeys} foreign keys from PostgreSQL`
          );
        }
        console.log(`${result.claudeMdVerb} Cartograph section in ${result.claudeMdPath}`);
        if (result.removedLegacyFiles.length > 0) {
          console.log(`Removed legacy generated files: ${result.removedLegacyFiles.join(', ')}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exitCode = 1;
      }
    });
}

function toPostgresOverrides(opts: RefreshCliOptions): Partial<PostgresSchemaSourceConfig> | undefined {
  const overrides: Partial<PostgresSchemaSourceConfig> = {};
  if (opts.dbHost) overrides.host = opts.dbHost;
  if (opts.dbPort) {
    const parsed = Number.parseInt(opts.dbPort, 10);
    if (Number.isFinite(parsed)) overrides.port = parsed;
  }
  if (opts.dbUser) overrides.user = opts.dbUser;
  if (opts.dbPassword) overrides.password = opts.dbPassword;
  if (opts.dbName) overrides.database = opts.dbName;

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
