import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { DbSchemaRepository } from '../db/repositories/db-schema-repository.js';
import { handleTable } from '../mcp/tools/table.js';

export function renderTableForRepo(
  db: Database.Database,
  repoPath: string,
  tableName: string
): string {
  const absoluteRepoPath = resolve(repoPath);
  const repo = new RepoRepository(db).findByPath(absoluteRepoPath);

  if (!repo) {
    throw new Error(`No index found for ${absoluteRepoPath}. Run \`cartograph index\` first.`);
  }

  return handleTable({
    repoId: repo.id,
    schemaRepo: new DbSchemaRepository(db),
  }, { name: tableName });
}

export function createTableCommand(): Command {
  return new Command('table')
    .description('Inspect an indexed SQL table and its relationships')
    .argument('<table>', 'Table name')
    .option('--repo-path <path>', 'Repository path', '.')
    .action((tableName: string, opts: { repoPath: string }) => {
      const config = loadConfig(opts.repoPath);
      const db = openDatabase(config.database);

      try {
        console.log(renderTableForRepo(db, opts.repoPath, tableName));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exitCode = 1;
      } finally {
        db.close();
      }
    });
}
