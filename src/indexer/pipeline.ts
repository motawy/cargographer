import type pg from 'pg';
import type { CartographConfig, DiscoveredFile } from '../types.js';
import { discoverFiles } from './file-walker.js';
import { AstParser } from './ast-parser.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { FileRepository } from '../db/repositories/file-repository.js';
import { SymbolRepository } from '../db/repositories/symbol-repository.js';
import { IndexError } from '../errors.js';
import { basename, resolve } from 'path';
import { appendFileSync, writeFileSync } from 'fs';

export interface PipelineOptions {
  verbose?: boolean;
  logFile?: string;
}

export class IndexPipeline {
  private repoRepo: RepoRepository;
  private fileRepo: FileRepository;
  private symbolRepo: SymbolRepository;

  constructor(pool: pg.Pool) {
    this.repoRepo = new RepoRepository(pool);
    this.fileRepo = new FileRepository(pool);
    this.symbolRepo = new SymbolRepository(pool);
  }

  async run(
    repoPath: string,
    config: CartographConfig,
    opts: PipelineOptions = {}
  ): Promise<void> {
    const log = this.createLogger(opts);
    const absPath = resolve(repoPath);
    const runStart = Date.now();

    log(`Indexing ${absPath}...`);

    // 1. Register repo
    const repo = await this.repoRepo.findOrCreate(absPath, basename(absPath));

    // 2. Discover files
    const discoverStart = Date.now();
    const discovered = await discoverFiles(absPath, config);
    log(`Found ${discovered.length} source files (${this.elapsed(discoverStart)})`);

    if (discovered.length === 0) {
      log(
        'No source files found. Check your language and exclude config.'
      );
      return;
    }

    // 3. Compute changeset
    const storedHashes = await this.fileRepo.getFileHashes(repo.id);
    const changeset = this.computeChangeset(discovered, storedHashes);
    log(
      `Changes: ${changeset.added.length} new, ${changeset.modified.length} modified, ${changeset.deleted.length} deleted`
    );

    // 4. Remove deleted files (CASCADE deletes their symbols)
    if (changeset.deleted.length > 0) {
      await this.fileRepo.deleteByPaths(repo.id, changeset.deleted);
      if (opts.verbose) {
        for (const path of changeset.deleted) {
          log(`  deleted: ${path}`);
        }
      }
    }

    // 5. Parse and store new/modified files
    const parser = new AstParser();
    const toProcess = [...changeset.added, ...changeset.modified];
    let errors = 0;
    const parseStart = Date.now();
    const errorDetails: string[] = [];

    for (let i = 0; i < toProcess.length; i++) {
      const file = toProcess[i];
      try {
        const fileStart = Date.now();
        const { symbols, linesOfCode } = parser.parse(file);
        const fileRecord = await this.fileRepo.upsert(
          repo.id,
          file.relativePath,
          file.language,
          file.hash,
          linesOfCode
        );
        await this.symbolRepo.replaceFileSymbols(fileRecord.id, symbols);

        if (opts.verbose) {
          log(`  [${i + 1}/${toProcess.length}] ${file.relativePath} — ${symbols.length} symbols (${this.elapsed(fileStart)})`);
        }
      } catch (err) {
        errors++;
        const msg = `  Error parsing ${file.relativePath}: ${err}`;
        errorDetails.push(msg);
        log(msg, true);
      }
    }

    log(`Parsing complete (${this.elapsed(parseStart)})`);

    // 6. Update repo timestamp
    await this.repoRepo.updateLastIndexed(repo.id);

    // 7. Report
    const totalSymbols = await this.symbolRepo.countByRepo(repo.id);
    log(
      `Done. Processed ${toProcess.length - errors} files (${errors} errors). ${totalSymbols} symbols indexed. Total time: ${this.elapsed(runStart)}`
    );

    if (errors > 0) {
      throw new IndexError(`${errors} file(s) failed to parse`);
    }
  }

  private createLogger(opts: PipelineOptions): (msg: string, isError?: boolean) => void {
    if (opts.logFile) {
      writeFileSync(opts.logFile, `[${new Date().toISOString()}] Cartograph index run\n`);
    }

    return (msg: string, isError = false) => {
      if (isError) {
        console.error(msg);
      } else {
        console.log(msg);
      }

      if (opts.logFile) {
        appendFileSync(opts.logFile, `[${new Date().toISOString()}] ${msg}\n`);
      }
    };
  }

  private elapsed(since: number): string {
    const ms = Date.now() - since;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  private computeChangeset(
    discovered: DiscoveredFile[],
    storedHashes: Map<string, string>
  ): {
    added: DiscoveredFile[];
    modified: DiscoveredFile[];
    deleted: string[];
  } {
    const added: DiscoveredFile[] = [];
    const modified: DiscoveredFile[] = [];
    const currentPaths = new Set<string>();

    for (const file of discovered) {
      currentPaths.add(file.relativePath);
      const stored = storedHashes.get(file.relativePath);

      if (!stored) {
        added.push(file);
      } else if (stored !== file.hash) {
        modified.push(file);
      }
    }

    const deleted = [...storedHashes.keys()].filter(
      (p) => !currentPaths.has(p)
    );
    return { added, modified, deleted };
  }
}
