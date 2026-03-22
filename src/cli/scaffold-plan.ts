import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { FileRepository } from '../db/repositories/file-repository.js';
import { SymbolRepository } from '../db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';
import { handleScaffoldPlan } from '../mcp/tools/scaffold-plan.js';

export function renderScaffoldPlanForRepo(
  db: Database.Database,
  repoPath: string,
  reference: string,
  target: string,
  depth?: number
): string {
  const absoluteRepoPath = resolve(repoPath);
  const repo = new RepoRepository(db).findByPath(absoluteRepoPath);

  if (!repo) {
    throw new Error(`No index found for ${absoluteRepoPath}. Run \`cartograph index\` first.`);
  }

  return handleScaffoldPlan({
    repoId: repo.id,
    repoPath: absoluteRepoPath,
    fileRepo: new FileRepository(db),
    symbolRepo: new SymbolRepository(db),
    refRepo: new ReferenceRepository(db),
  }, { reference, target, depth });
}

export function createScaffoldPlanCommand(): Command {
  return new Command('scaffold-plan')
    .description('Plan the files and class names needed to mirror a reference slice for a new target stem')
    .argument('<reference>', 'Reference symbol to mirror')
    .argument('<target>', 'Target stem or class name to substitute into the slice')
    .option('--repo-path <path>', 'Repository path', '.')
    .option('--depth <n>', 'Forward traversal depth for collecting the reference slice', '4')
    .action((reference: string, target: string, opts: { repoPath: string; depth: string }) => {
      const config = loadConfig(opts.repoPath);
      const db = openDatabase(config.database);

      try {
        console.log(
          renderScaffoldPlanForRepo(
            db,
            opts.repoPath,
            reference,
            target,
            Number.parseInt(opts.depth, 10)
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
