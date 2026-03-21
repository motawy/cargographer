import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { FileRepository } from '../db/repositories/file-repository.js';
import { DbSchemaRepository } from '../db/repositories/db-schema-repository.js';
import { SymbolSchemaRepository } from '../db/repositories/symbol-schema-repository.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';
import { SymbolRepository } from '../db/repositories/symbol-repository.js';
import { handleTableUsage } from '../mcp/tools/table-usage.js';

export function renderTableUsageForRepo(
  db: Database.Database,
  repoPath: string,
  tableName: string,
  depth?: number,
  limit?: number,
  includeTests?: boolean
): string {
  const absoluteRepoPath = resolve(repoPath);
  const repo = new RepoRepository(db).findByPath(absoluteRepoPath);

  if (!repo) {
    throw new Error(`No index found for ${absoluteRepoPath}. Run \`cartograph index\` first.`);
  }

  return handleTableUsage({
    repoId: repo.id,
    repoPath: absoluteRepoPath,
    fileRepo: new FileRepository(db),
    symbolRepo: new SymbolRepository(db),
    schemaRepo: new DbSchemaRepository(db),
    symbolSchemaRepo: new SymbolSchemaRepository(db),
    refRepo: new ReferenceRepository(db),
  }, { name: tableName, depth, limit, includeTests });
}

export function createTableUsageCommand(): Command {
  return new Command('table-usage')
    .description('Bridge database schema to code by showing mapped entities, entity-based touchpoints, and direct table-name references')
    .argument('<table>', 'Table name')
    .option('--repo-path <path>', 'Repository path', '.')
    .option('--depth <n>', 'Transitive code-reference depth', '3')
    .option('--limit <n>', 'Maximum number of code touchpoints to show', '25')
    .option('--include-tests', 'Include test code in touchpoints and direct references')
    .action((tableName: string, opts: { repoPath: string; depth: string; limit: string; includeTests?: boolean }) => {
      const config = loadConfig(opts.repoPath);
      const db = openDatabase(config.database);

      try {
        console.log(
          renderTableUsageForRepo(
            db,
            opts.repoPath,
            tableName,
            Number.parseInt(opts.depth, 10),
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
