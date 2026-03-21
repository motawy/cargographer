import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { DbSchemaRepository } from '../db/repositories/db-schema-repository.js';
import { SymbolSchemaRepository } from '../db/repositories/symbol-schema-repository.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';
import { handleTableUsage } from '../mcp/tools/table-usage.js';

export function renderTableUsageForRepo(
  db: Database.Database,
  repoPath: string,
  tableName: string,
  depth?: number,
  limit?: number
): string {
  const absoluteRepoPath = resolve(repoPath);
  const repo = new RepoRepository(db).findByPath(absoluteRepoPath);

  if (!repo) {
    throw new Error(`No index found for ${absoluteRepoPath}. Run \`cartograph index\` first.`);
  }

  return handleTableUsage({
    repoId: repo.id,
    schemaRepo: new DbSchemaRepository(db),
    symbolSchemaRepo: new SymbolSchemaRepository(db),
    refRepo: new ReferenceRepository(db),
  }, { name: tableName, depth, limit });
}

export function createTableUsageCommand(): Command {
  return new Command('table-usage')
    .description('Bridge database schema to code by showing mapped entities and code references for a table')
    .argument('<table>', 'Table name')
    .option('--repo-path <path>', 'Repository path', '.')
    .option('--depth <n>', 'Transitive code-reference depth', '3')
    .option('--limit <n>', 'Maximum number of code touchpoints to show', '25')
    .action((tableName: string, opts: { repoPath: string; depth: string; limit: string }) => {
      const config = loadConfig(opts.repoPath);
      const db = openDatabase(config.database);

      try {
        console.log(
          renderTableUsageForRepo(
            db,
            opts.repoPath,
            tableName,
            Number.parseInt(opts.depth, 10),
            Number.parseInt(opts.limit, 10)
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
