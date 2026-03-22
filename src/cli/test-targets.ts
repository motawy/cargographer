import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { FileRepository } from '../db/repositories/file-repository.js';
import { SymbolRepository } from '../db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';
import { DbSchemaRepository } from '../db/repositories/db-schema-repository.js';
import { SymbolSchemaRepository } from '../db/repositories/symbol-schema-repository.js';
import { handleTestTargets } from '../mcp/tools/test-targets.js';

export function renderTestTargetsForRepo(
  db: Database.Database,
  repoPath: string,
  opts: {
    symbol?: string;
    file?: string;
    table?: string;
    limit?: number;
  }
): string {
  const absoluteRepoPath = resolve(repoPath);
  const repo = new RepoRepository(db).findByPath(absoluteRepoPath);

  if (!repo) {
    throw new Error(`No index found for ${absoluteRepoPath}. Run \`cartograph index\` first.`);
  }

  return handleTestTargets({
    repoId: repo.id,
    repoPath: absoluteRepoPath,
    fileRepo: new FileRepository(db),
    symbolRepo: new SymbolRepository(db),
    refRepo: new ReferenceRepository(db),
    schemaRepo: new DbSchemaRepository(db),
    symbolSchemaRepo: new SymbolSchemaRepository(db),
  }, opts);
}

export function createTestTargetsCommand(): Command {
  return new Command('test-targets')
    .description('Suggest likely test files for a symbol, file, or table')
    .option('--repo-path <path>', 'Repository path', '.')
    .option('--symbol <name>', 'Symbol to find relevant tests for')
    .option('--file <path>', 'File to find relevant tests for')
    .option('--table <name>', 'Database table to find relevant tests for')
    .option('--limit <n>', 'Maximum number of test targets to show', '10')
    .action((opts: { repoPath: string; symbol?: string; file?: string; table?: string; limit: string }) => {
      const config = loadConfig(opts.repoPath);
      const db = openDatabase(config.database);

      try {
        console.log(
          renderTestTargetsForRepo(db, opts.repoPath, {
            symbol: opts.symbol,
            file: opts.file,
            table: opts.table,
            limit: Number.parseInt(opts.limit, 10),
          })
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
