import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { GenerateError } from '../errors.js';
import { updateClaudeMdSection } from './setup-shared.js';

export function createGenerateCommand(): Command {
  return new Command('generate')
    .description('Inject or update the Cartograph guidance block in your CLAUDE.md')
    .argument('<repo-path>', 'Path to the indexed repository')
    .option('--claude-md <path>', 'Path to CLAUDE.md to inject into (default: auto-detect)')
    .action((repoPath: string, opts: { claudeMd?: string }) => {
      const config = loadConfig(repoPath);
      const db = openDatabase(config.database);

      try {
        const result = updateClaudeMdSection(db, repoPath, opts.claudeMd);
        console.log(`\n${result.verb} Cartograph section in ${result.path}`);
        if (result.removedLegacyFiles.length > 0) {
          console.log(`Removed legacy generated files: ${result.removedLegacyFiles.join(', ')}`);
        }
        console.log('');
      } catch (err) {
        if (err instanceof GenerateError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      } finally {
        db.close();
      }
    });
}
