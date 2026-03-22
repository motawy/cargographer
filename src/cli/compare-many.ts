import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { SymbolRepository } from '../db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';
import { handleCompareMany } from '../mcp/tools/compare-many.js';

export function renderCompareManyForRepo(
  db: Database.Database,
  repoPath: string,
  baseline: string,
  others: string[],
  includeIdentical?: boolean
): string {
  const absoluteRepoPath = resolve(repoPath);
  const repo = new RepoRepository(db).findByPath(absoluteRepoPath);

  if (!repo) {
    throw new Error(`No index found for ${absoluteRepoPath}. Run \`cartograph index\` first.`);
  }

  return handleCompareMany({
    repoId: repo.id,
    repoPath: absoluteRepoPath,
    symbolRepo: new SymbolRepository(db),
    refRepo: new ReferenceRepository(db),
  }, { baseline, others, includeIdentical });
}

export function createCompareManyCommand(): Command {
  return new Command('compare-many')
    .description('Compare one baseline symbol against multiple siblings to spot pattern gaps quickly')
    .argument('<baseline>', 'Baseline symbol')
    .argument('<others...>', 'One or more symbols to compare against the baseline')
    .option('--repo-path <path>', 'Repository path', '.')
    .option('--include-identical', 'Include methods that are identical across the compared symbols')
    .action((baseline: string, others: string[], opts: { repoPath: string; includeIdentical?: boolean }) => {
      const config = loadConfig(opts.repoPath);
      const db = openDatabase(config.database);

      try {
        console.log(renderCompareManyForRepo(db, opts.repoPath, baseline, others, opts.includeIdentical));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exitCode = 1;
      } finally {
        db.close();
      }
    });
}
