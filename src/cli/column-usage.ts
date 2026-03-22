import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { DbSchemaRepository } from '../db/repositories/db-schema-repository.js';
import { SymbolSchemaRepository } from '../db/repositories/symbol-schema-repository.js';
import { TableReferenceRepository } from '../db/repositories/table-reference-repository.js';
import { SymbolRepository } from '../db/repositories/symbol-repository.js';
import { handleColumnUsage } from '../mcp/tools/column-usage.js';

export function renderColumnUsageForRepo(
  db: Database.Database,
  repoPath: string,
  table: string,
  column: string,
  limit?: number,
  includeTests?: boolean
): string {
  const absoluteRepoPath = resolve(repoPath);
  const repo = new RepoRepository(db).findByPath(absoluteRepoPath);

  if (!repo) {
    throw new Error(`No index found for ${absoluteRepoPath}. Run \`cartograph index\` first.`);
  }

  return handleColumnUsage({
    repoId: repo.id,
    repoPath: absoluteRepoPath,
    schemaRepo: new DbSchemaRepository(db),
    symbolSchemaRepo: new SymbolSchemaRepository(db),
    tableReferenceRepo: new TableReferenceRepository(db),
    symbolRepo: new SymbolRepository(db),
  }, { table, column, limit, includeTests });
}

export function createColumnUsageCommand(): Command {
  return new Command('column-usage')
    .description('Show mapped properties and likely write refs for a column scoped to files that touch its table')
    .argument('<table>', 'Table name')
    .argument('<column>', 'Column name')
    .option('--repo-path <path>', 'Repository path', '.')
    .option('--limit <n>', 'Maximum number of column refs to scan', '15')
    .option('--include-tests', 'Include test files in scoped column refs')
    .action((table: string, column: string, opts: { repoPath: string; limit: string; includeTests?: boolean }) => {
      const config = loadConfig(opts.repoPath);
      const db = openDatabase(config.database);

      try {
        console.log(
          renderColumnUsageForRepo(
            db,
            opts.repoPath,
            table,
            column,
            Number.parseInt(opts.limit, 10),
            opts.includeTests ?? false
          )
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
