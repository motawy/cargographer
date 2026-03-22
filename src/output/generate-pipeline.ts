import type Database from 'better-sqlite3';
import { resolve } from 'path';
import { RepoRepository } from '../db/repositories/repo-repository.js';
import { GenerateError } from '../errors.js';
import { generateClaudeMdSection } from './claudemd-generator.js';

export interface GenerateOptions {
  claudeMdPath?: string;
}

export interface DirectoryStats {
  path: string;
  fileCount: number;
  symbolCount: number;
  classCount: number;
  dominantKinds: string[];
}

export interface RepoStats {
  totalFiles: number;
  totalSymbols: number;
  totalReferences: number;
  language: string;
  directories: DirectoryStats[];
}

export interface ModuleSymbol {
  qualifiedName: string;
  kind: string;
  linesOfCode: number;
  implements: string[];
  extends: string | null;
  traits: string[];
  referenceCount: number;
}

export interface ModuleInfo {
  path: string;
  symbols: ModuleSymbol[];
  fileCount?: number;
}

export interface ModuleDependency {
  sourceModule: string;
  targetModule: string;
  referenceCount: number;
}

export interface ExternalDependency {
  namespace: string;
  referenceCount: number;
}

export interface DepsData {
  internal: ModuleDependency[];
  external: ExternalDependency[];
}

export interface ConventionsData {
  totalClasses: number;
  totalInterfaces: number;
  totalTraits: number;
  totalEnums: number;
  classesWithInterface: number;
  classesWithInheritance: number;
  classesWithTraits: number;
  interfaceAdoptionByModule: Map<string, { total: number; withInterface: number }>;
  classNames: string[];
  methodNames: string[];
}

/** Extract top-2-level directory: "app/Services/Foo.php" → "app/Services" */
function extractTopDir(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 2) return parts[0];
  return parts[0] + '/' + parts[1];
}

export class GeneratePipeline {
  private repoRepo: RepoRepository;

  constructor(private db: Database.Database) {
    this.repoRepo = new RepoRepository(db);
  }

  generateClaudeMdContent(repoPath: string): string {
    const absPath = resolve(repoPath);
    const repo = this.repoRepo.findByPath(absPath);
    if (!repo) {
      throw new GenerateError(
        `Repository not indexed: ${absPath}. Run \`cartograph index <path>\` first.`
      );
    }

    const fileCount = this.db.prepare(
      'SELECT COUNT(*) AS count FROM files WHERE repo_id = ?'
    ).get(repo.id) as { count: number };
    if (fileCount.count === 0) {
      throw new GenerateError(
        `No indexed data found for ${absPath}. Run \`cartograph index <path>\` first.`
      );
    }

    const stats = this.queryRepoStats(repo.id);
    const conventions = this.queryConventions(repo.id);
    return generateClaudeMdSection(stats, conventions);
  }

  private queryRepoStats(repoId: number): RepoStats {
    const fileCounts = this.db.prepare(
      'SELECT COUNT(*) AS count, MAX(language) AS language FROM files WHERE repo_id = ?'
    ).get(repoId) as Record<string, unknown>;

    const symbolCounts = this.db.prepare(
      `SELECT COUNT(*) AS count FROM symbols s
       JOIN files f ON s.file_id = f.id WHERE f.repo_id = ?`
    ).get(repoId) as { count: number };

    const refCounts = this.db.prepare(
      `SELECT COUNT(*) AS count FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id WHERE f.repo_id = ?`
    ).get(repoId) as { count: number };

    // Directory stats: query files+symbols, aggregate in JS
    const dirRows = this.db.prepare(
      `SELECT f.id AS file_id, f.path, s.id AS symbol_id, s.kind
       FROM files f
       LEFT JOIN symbols s ON s.file_id = f.id
       WHERE f.repo_id = ?`
    ).all(repoId) as { file_id: number; path: string; symbol_id: number | null; kind: string | null }[];

    const dirMap = new Map<string, { files: Set<number>; symbols: number; classes: number; kinds: Set<string> }>();
    for (const row of dirRows) {
      const dir = extractTopDir(row.path);
      const entry = dirMap.get(dir) || { files: new Set(), symbols: 0, classes: 0, kinds: new Set() };
      entry.files.add(row.file_id);
      if (row.symbol_id) {
        entry.symbols++;
        if (row.kind === 'class') entry.classes++;
        if (row.kind && ['class', 'interface', 'trait', 'enum'].includes(row.kind)) {
          entry.kinds.add(row.kind);
        }
      }
      dirMap.set(dir, entry);
    }

    const directories = [...dirMap.entries()]
      .map(([path, d]) => ({
        path,
        fileCount: d.files.size,
        symbolCount: d.symbols,
        classCount: d.classes,
        dominantKinds: [...d.kinds],
      }))
      .sort((a, b) => b.symbolCount - a.symbolCount);

    return {
      totalFiles: (fileCounts as { count: number }).count,
      totalSymbols: symbolCounts.count,
      totalReferences: refCounts.count,
      language: ((fileCounts as { language: string }).language) || 'unknown',
      directories,
    };
  }

  private queryModules(repoId: number): ModuleInfo[] {
    const rows = this.db.prepare(
      `SELECT s.id, s.qualified_name, s.kind, f.path AS file_path,
              (s.line_end - s.line_start + 1) AS lines_of_code
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ? AND s.kind IN ('class', 'interface', 'trait', 'enum')
         AND s.parent_symbol_id IS NULL
       ORDER BY f.path`
    ).all(repoId) as Record<string, unknown>[];

    const refCountStmt = this.db.prepare(
      'SELECT COUNT(*) AS count FROM symbol_references WHERE target_symbol_id = ?'
    );
    const relStmt = this.db.prepare(
      `SELECT sr.reference_kind, COALESCE(ts.qualified_name, sr.target_qualified_name) AS target_name
       FROM symbol_references sr
       LEFT JOIN symbols ts ON sr.target_symbol_id = ts.id
       WHERE sr.source_symbol_id = ? AND sr.reference_kind IN ('implementation', 'inheritance', 'trait_use')`
    );

    const moduleMap = new Map<string, { symbols: ModuleSymbol[]; filePaths: Set<string> }>();

    for (const row of rows) {
      const dir = extractTopDir(row.file_path as string);
      const refCount = (refCountStmt.get(row.id) as { count: number }).count;
      const rels = relStmt.all(row.id) as { reference_kind: string; target_name: string }[];

      const entry = moduleMap.get(dir) || { symbols: [], filePaths: new Set() };
      entry.filePaths.add(row.file_path as string);
      entry.symbols.push({
        qualifiedName: row.qualified_name as string,
        kind: row.kind as string,
        linesOfCode: row.lines_of_code as number,
        implements: rels.filter(r => r.reference_kind === 'implementation').map(r => r.target_name),
        extends: rels.find(r => r.reference_kind === 'inheritance')?.target_name || null,
        traits: rels.filter(r => r.reference_kind === 'trait_use').map(r => r.target_name),
        referenceCount: refCount,
      });
      moduleMap.set(dir, entry);
    }

    return Array.from(moduleMap.entries())
      .map(([path, { symbols, filePaths }]) => ({ path, symbols, fileCount: filePaths.size }))
      .sort((a, b) => {
        const aTotal = a.symbols.reduce((sum, s) => sum + s.referenceCount, 0);
        const bTotal = b.symbols.reduce((sum, s) => sum + s.referenceCount, 0);
        return bTotal - aTotal;
      });
  }

  private queryDependencies(repoId: number): DepsData {
    const internalRows = this.db.prepare(
      `SELECT sf.path AS source_path, tf.path AS target_path
       FROM symbol_references sr
       JOIN symbols ss ON sr.source_symbol_id = ss.id
       JOIN files sf ON ss.file_id = sf.id
       JOIN symbols ts ON sr.target_symbol_id = ts.id
       JOIN files tf ON ts.file_id = tf.id
       WHERE sf.repo_id = ? AND tf.repo_id = ?
         AND sr.target_symbol_id IS NOT NULL`
    ).all(repoId, repoId) as { source_path: string; target_path: string }[];

    const depCounts = new Map<string, number>();
    for (const row of internalRows) {
      const sourceDir = extractTopDir(row.source_path);
      const targetDir = extractTopDir(row.target_path);
      if (sourceDir === targetDir) continue;
      const key = `${sourceDir}\u2192${targetDir}`;
      depCounts.set(key, (depCounts.get(key) || 0) + 1);
    }

    const internal = [...depCounts.entries()]
      .map(([key, count]) => {
        const [sourceModule, targetModule] = key.split('\u2192');
        return { sourceModule, targetModule, referenceCount: count };
      })
      .sort((a, b) => b.referenceCount - a.referenceCount);

    // External deps: unresolved refs with backslash (PHP namespaces)
    const externalRows = this.db.prepare(
      `SELECT sr.target_qualified_name
       FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ?
         AND sr.target_symbol_id IS NULL
         AND sr.target_qualified_name LIKE '%\\%'`
    ).all(repoId) as { target_qualified_name: string }[];

    const nsCounts = new Map<string, number>();
    for (const row of externalRows) {
      const firstBackslash = row.target_qualified_name.indexOf('\\');
      if (firstBackslash < 0) continue;
      const ns = row.target_qualified_name.substring(0, firstBackslash);
      nsCounts.set(ns, (nsCounts.get(ns) || 0) + 1);
    }

    const external = [...nsCounts.entries()]
      .map(([namespace, count]) => ({ namespace, referenceCount: count }))
      .sort((a, b) => b.referenceCount - a.referenceCount);

    return { internal, external };
  }

  private queryConventions(repoId: number): ConventionsData {
    const kindCounts = this.db.prepare(
      `SELECT s.kind, COUNT(*) AS count
       FROM symbols s JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ? AND s.kind IN ('class','interface','trait','enum')
         AND s.parent_symbol_id IS NULL
       GROUP BY s.kind`
    ).all(repoId) as { kind: string; count: number }[];
    const countMap = Object.fromEntries(kindCounts.map(r => [r.kind, r.count]));

    const implCount = this.db.prepare(
      `SELECT COUNT(DISTINCT sr.source_symbol_id) AS count
       FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ? AND sr.reference_kind = 'implementation'`
    ).get(repoId) as { count: number };

    const inheritCount = this.db.prepare(
      `SELECT COUNT(DISTINCT sr.source_symbol_id) AS count
       FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ? AND sr.reference_kind = 'inheritance'`
    ).get(repoId) as { count: number };

    const traitCount = this.db.prepare(
      `SELECT COUNT(DISTINCT sr.source_symbol_id) AS count
       FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ? AND sr.reference_kind = 'trait_use'`
    ).get(repoId) as { count: number };

    const adoptionRows = this.db.prepare(
      `SELECT s.id, f.path,
         (SELECT COUNT(*) FROM symbol_references sr2
          WHERE sr2.source_symbol_id = s.id AND sr2.reference_kind = 'implementation') AS has_impl
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ? AND s.kind = 'class' AND s.parent_symbol_id IS NULL`
    ).all(repoId) as { id: number; path: string; has_impl: number }[];

    const adoptionMap = new Map<string, { total: number; withInterface: number }>();
    for (const row of adoptionRows) {
      const mod = extractTopDir(row.path);
      const entry = adoptionMap.get(mod) || { total: 0, withInterface: 0 };
      entry.total++;
      if (row.has_impl > 0) entry.withInterface++;
      adoptionMap.set(mod, entry);
    }

    const classNameRows = this.db.prepare(
      `SELECT s.name FROM symbols s JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ? AND s.kind = 'class' AND s.parent_symbol_id IS NULL
       LIMIT 200`
    ).all(repoId) as { name: string }[];

    const methodNameRows = this.db.prepare(
      `SELECT s.name FROM symbols s JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ? AND s.kind = 'method'
         AND s.name NOT LIKE '\\_\\_%' ESCAPE '\\'
       LIMIT 200`
    ).all(repoId) as { name: string }[];

    return {
      totalClasses: (countMap.class || 0),
      totalInterfaces: (countMap.interface || 0),
      totalTraits: (countMap.trait || 0),
      totalEnums: (countMap.enum || 0),
      classesWithInterface: implCount.count,
      classesWithInheritance: inheritCount.count,
      classesWithTraits: traitCount.count,
      interfaceAdoptionByModule: adoptionMap,
      classNames: classNameRows.map(r => r.name),
      methodNames: methodNameRows.map(r => r.name),
    };
  }
}
