import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, resolvePostgresSchemaSource } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { importPgSchema } from '../db/pg-schema-importer.js';
import { DbSchemaRepository } from '../db/repositories/db-schema-repository.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import type { CartographConfig, PostgresSchemaSourceConfig } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SchemaImportCliOptions {
  dbHost?: string;
  dbPort?: string;
  dbUser?: string;
  dbPassword?: string;
  dbName?: string;
}

export async function importSchemaForRepo(
  db: Database.Database,
  repoPath: string,
  config: CartographConfig,
  overrides: Partial<PostgresSchemaSourceConfig> = {}
): Promise<{ tables: number; columns: number; foreignKeys: number }> {
  const absoluteRepoPath = resolve(repoPath);
  const repoRepo = new RepoRepository(db);
  const repo = repoRepo.findByPath(absoluteRepoPath);
  if (!repo) {
    throw new Error(`No index found for ${absoluteRepoPath}. Run \`cartograph index\` first.`);
  }

  const schemaSource = resolvePostgresSchemaSource(
    config.schemaSource?.type === 'postgres' ? config.schemaSource : undefined,
    overrides
  );
  const imported = await importPgSchema(schemaSource);
  const schemaRepo = new DbSchemaRepository(db);
  schemaRepo.replaceCurrentSchemaFromImport(repo.id, imported);
  repoRepo.updateLastIndexed(repo.id);

  return summarizeImportedSchema(imported);
}

export function createSchemaImportCommand(): Command {
  return new Command('schema-import')
    .description('Import current schema directly from PostgreSQL into Cartograph')
    .argument('<repo-path>', 'Path to the already indexed repository')
    .option('--db-host <host>', 'PostgreSQL host')
    .option('--db-port <port>', 'PostgreSQL port')
    .option('--db-user <user>', 'PostgreSQL user')
    .option('--db-password <password>', 'PostgreSQL password')
    .option('--db-name <name>', 'PostgreSQL database name')
    .action(async (repoPath: string, opts: SchemaImportCliOptions) => {
      const config = loadConfig(repoPath);
      const db = openDatabase(config.database);

      try {
        runMigrations(db, join(__dirname, '..', 'db', 'migrations'));

        const summary = await importSchemaForRepo(db, repoPath, config, {
          host: opts.dbHost,
          port: parseOptionalPort(opts.dbPort),
          user: opts.dbUser,
          password: opts.dbPassword,
          database: opts.dbName,
        });

        console.log(
          `Imported ${summary.tables} tables, ${summary.columns} columns, ` +
          `${summary.foreignKeys} foreign keys from PostgreSQL`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exitCode = 1;
      } finally {
        db.close();
      }
    });
}

function summarizeImportedSchema(
  tables: Awaited<ReturnType<typeof importPgSchema>>
): { tables: number; columns: number; foreignKeys: number } {
  return {
    tables: tables.length,
    columns: tables.reduce((sum, table) => sum + table.columns.length, 0),
    foreignKeys: tables.reduce((sum, table) => sum + table.foreignKeys.length, 0),
  };
}

function parseOptionalPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
