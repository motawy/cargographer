import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { SymbolRepository } from '../db/repositories/symbol-repository.js';
import { handleRoutePairs } from '../mcp/tools/route-pairs.js';

export function renderRoutePairsForRepo(
  db: Database.Database,
  repoPath: string,
  query?: string,
  path?: string,
  limit?: number
): string {
  const absoluteRepoPath = resolve(repoPath);
  const repo = new RepoRepository(db).findByPath(absoluteRepoPath);

  if (!repo) {
    throw new Error(`No index found for ${absoluteRepoPath}. Run \`cartograph index\` first.`);
  }

  return handleRoutePairs({
    repoId: repo.id,
    symbolRepo: new SymbolRepository(db),
  }, { query, path, limit });
}

export function createRoutePairsCommand(): Command {
  return new Command('route-pairs')
    .description('Audit nested route endpoints against likely flat equivalents')
    .option('--repo-path <path>', 'Repository path', '.')
    .option('--query <text>', 'Optional text filter for route names or paths')
    .option('--path <path>', 'Optional file-path substring filter')
    .option('--limit <n>', 'Maximum number of nested route families to show', '25')
    .action((opts: { repoPath: string; query?: string; path?: string; limit: string }) => {
      const config = loadConfig(opts.repoPath);
      const db = openDatabase(config.database);

      try {
        console.log(
          renderRoutePairsForRepo(
            db,
            opts.repoPath,
            opts.query,
            opts.path,
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
