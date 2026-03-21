import type Database from 'better-sqlite3';
import type { CartographConfig, DiscoveredFile } from '../types.js';
import { discoverFiles } from './file-walker.js';
import { AstParser } from './ast-parser.js';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { FileRepository } from '../db/repositories/file-repository.js';
import { SymbolRepository } from '../db/repositories/symbol-repository.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';
import { DbSchemaRepository } from '../db/repositories/db-schema-repository.js';
import { SymbolSchemaRepository } from '../db/repositories/symbol-schema-repository.js';
import { extractReferences } from './reference-extractor.js';
import { IndexError } from '../errors.js';
import { basename, resolve } from 'path';
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { extractSqlSchema } from './sql-schema-extractor.js';
import { buildCurrentSqlSchema } from './sql-schema-state.js';
import { extractDoctrineMappings } from './doctrine-mapping-extractor.js';

export interface PipelineOptions {
  verbose?: boolean;
  logFile?: string;
}

export class IndexPipeline {
  private repoRepo: RepoRepository;
  private fileRepo: FileRepository;
  private symbolRepo: SymbolRepository;
  private referenceRepo: ReferenceRepository;
  private dbSchemaRepo: DbSchemaRepository;
  private symbolSchemaRepo: SymbolSchemaRepository;

  constructor(db: Database.Database) {
    this.repoRepo = new RepoRepository(db);
    this.fileRepo = new FileRepository(db);
    this.symbolRepo = new SymbolRepository(db);
    this.referenceRepo = new ReferenceRepository(db);
    this.dbSchemaRepo = new DbSchemaRepository(db);
    this.symbolSchemaRepo = new SymbolSchemaRepository(db);
  }

  run(
    repoPath: string,
    config: CartographConfig,
    opts: PipelineOptions = {}
  ): void {
    const log = this.createLogger(opts);
    const absPath = resolve(repoPath);
    const runStart = Date.now();

    log(`Indexing ${absPath}...`);

    // 1. Register repo
    const repo = this.repoRepo.findOrCreate(absPath, basename(absPath));

    // 2. Discover files
    const discoverStart = Date.now();
    const discovered = discoverFiles(absPath, config);
    log(`Found ${discovered.length} source files (${this.elapsed(discoverStart)})`);

    if (discovered.length === 0) {
      log(
        'No source files found. Check your language and exclude config.'
      );
      return;
    }

    // 3. Compute changeset
    const storedHashes = this.fileRepo.getFileHashes(repo.id);
    const changeset = this.computeChangeset(discovered, storedHashes);
    log(
      `Changes: ${changeset.added.length} new, ${changeset.modified.length} modified, ${changeset.deleted.length} deleted`
    );

    // 4. Remove deleted files (CASCADE deletes their symbols)
    if (changeset.deleted.length > 0) {
      this.fileRepo.deleteByPaths(repo.id, changeset.deleted);
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

        if (file.language === 'sql') {
          const fileRecord = this.fileRepo.upsert(
            repo.id,
            file.relativePath,
            file.language,
            file.hash,
            this.countLines(file.absolutePath)
          );
          this.symbolRepo.replaceFileSymbols(fileRecord.id, []);
          const tables = extractSqlSchema(file.absolutePath);
          this.dbSchemaRepo.replaceFileSchema(fileRecord.id, tables);
          if (opts.verbose) {
            log(
              `  [${i + 1}/${toProcess.length}] ${file.relativePath} — ${tables.length} tables (${this.elapsed(fileStart)})`
            );
          }
          continue;
        }

        const { symbols, linesOfCode, tree, context } = parser.parse(file);
        const fileRecord = this.fileRepo.upsert(
          repo.id,
          file.relativePath,
          file.language,
          file.hash,
          linesOfCode
        );
        this.dbSchemaRepo.replaceFileSchema(fileRecord.id, []);
        const symbolIdMap = this.symbolRepo.replaceFileSymbols(fileRecord.id, symbols);
        const doctrineMappings = extractDoctrineMappings(tree, context, symbols);
        this.symbolSchemaRepo.replaceFileLinks(
          fileRecord.id,
          symbolIdMap,
          doctrineMappings.tableLinks,
          doctrineMappings.columnLinks
        );

        // Extract and store references (best-effort)
        try {
          const references = extractReferences(tree, context, symbols);
          this.referenceRepo.replaceFileReferences(fileRecord.id, symbolIdMap, references);
        } catch (refErr) {
          if (opts.verbose) {
            log(`  Warning: reference extraction failed for ${file.relativePath}: ${refErr}`);
          }
        }

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

    // 6. Rebuild current SQL schema from migrations unless live DB import is configured.
    if (config.schemaSource?.type !== 'postgres') {
      const sqlFiles = discovered.filter((file) => file.language === 'sql');
      const fileIdsByPath = new Map(
        this.fileRepo.listByRepo(repo.id).map((file) => [file.path, file.id] as const)
      );
      const currentSchema = sqlFiles.length > 0
        ? buildCurrentSqlSchema(
          sqlFiles.map((file) => ({
            path: file.relativePath,
            absolutePath: file.absolutePath,
          }))
        )
        : [];
      this.dbSchemaRepo.replaceCurrentSchema(repo.id, currentSchema, fileIdsByPath);
    }

    // 7. Cross-file reference resolution
    const resolution = this.referenceRepo.resolveTargets(repo.id);
    log(`References: ${resolution.resolved} resolved, ${resolution.unresolved} unresolved`);

    // 8. Update repo timestamp
    this.repoRepo.updateLastIndexed(repo.id);

    // 9. Report
    const totalSymbols = this.symbolRepo.countByRepo(repo.id);
    const totalRefs = this.referenceRepo.countByRepo(repo.id);
    log(
      `Done. Processed ${toProcess.length - errors} files (${errors} errors). ` +
      `${totalSymbols} symbols, ${totalRefs} references indexed. Total time: ${this.elapsed(runStart)}`
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

  private countLines(filePath: string): number {
    return readFileSync(filePath, 'utf-8').split('\n').length;
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
