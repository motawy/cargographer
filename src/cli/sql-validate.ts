import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { FileRepository } from '../db/repositories/file-repository.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { DbSchemaRepository } from '../db/repositories/db-schema-repository.js';
import { SymbolRepository } from '../db/repositories/symbol-repository.js';
import { handleSqlValidate } from '../mcp/tools/sql-validate.js';

export function renderSqlValidateForRepo(
  db: Database.Database,
  repoPath: string,
  params: { symbol?: string; file?: string; limit?: number }
): string {
  const absoluteRepoPath = resolve(repoPath);
  const repo = new RepoRepository(db).findByPath(absoluteRepoPath);

  if (!repo) {
    throw new Error(`No index found for ${absoluteRepoPath}. Run \`cartograph index\` first.`);
  }

  return handleSqlValidate({
    repoId: repo.id,
    repoPath: absoluteRepoPath,
    fileRepo: new FileRepository(db),
    schemaRepo: new DbSchemaRepository(db),
    symbolRepo: new SymbolRepository(db),
  }, params);
}

export function createSqlValidateCommand(): Command {
  return new Command('sql-validate')
    .description('Validate literal SQL-ish table/column/join refs in a symbol or file against the current indexed schema')
    .option('--repo-path <path>', 'Repository path', '.')
    .option('--symbol <name>', 'Symbol to validate SQL refs inside')
    .option('--file <path>', 'File to validate SQL refs inside')
    .option('--limit <n>', 'Maximum number of rows to show per result section', '20')
    .action((opts: { repoPath: string; symbol?: string; file?: string; limit: string }) => {
      const config = loadConfig(opts.repoPath);
      const db = openDatabase(config.database);

      try {
        console.log(renderSqlValidateForRepo(db, opts.repoPath, {
          symbol: opts.symbol,
          file: opts.file,
          limit: Number.parseInt(opts.limit, 10),
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exitCode = 1;
      } finally {
        db.close();
      }
    });
}
