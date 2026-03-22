import { basename, dirname, extname } from 'path';
import { normalizeSchemaName } from '../../db/repositories/db-schema-repository.js';
import type { ToolDeps } from '../types.js';
import type { FileRecord } from '../../db/repositories/file-repository.js';
import type { DependentRow } from '../types.js';
import { findContentMatches, isTestPath } from './content-search-shared.js';
import { resolveSymbol } from './compare-shared.js';

interface TestTargetsParams {
  symbol?: string;
  file?: string;
  table?: string;
  limit?: number;
}

type TestTargetsDeps = Pick<
  ToolDeps,
  'repoId' | 'repoPath' | 'fileRepo' | 'symbolRepo' | 'refRepo' | 'schemaRepo' | 'symbolSchemaRepo'
>;

interface SeedFile {
  path: string;
  weight: number;
  reason: string;
  symbolName?: string | null;
}

interface CandidateScore {
  path: string;
  score: number;
  reasons: string[];
}

const MIN_TEST_TARGET_SCORE = 8;

export function handleTestTargets(deps: TestTargetsDeps, params: TestTargetsParams): string {
  const selectorCount = [params.symbol, params.file, params.table].filter(Boolean).length;
  if (selectorCount !== 1) {
    return 'Provide exactly one selector: symbol, file, or table.';
  }
  if (!deps.fileRepo) {
    throw new Error('File repository is not available.');
  }

  const limit = Math.max(1, Math.min(params.limit ?? 10, 25));
  const allFiles = deps.fileRepo.listByRepo(deps.repoId);
  const testFiles = allFiles.filter((file) => isTestPath(file.path));
  if (testFiles.length === 0) {
    return 'No indexed test files were found in this repository.';
  }

  let selectorLabel = '';
  let seedFiles: SeedFile[] = [];
  let directTestHints = new Map<string, string[]>();

  if (params.symbol) {
    selectorLabel = `symbol ${params.symbol}`;
    const result = collectSymbolSeeds(deps, params.symbol);
    if (typeof result === 'string') return result;
    seedFiles = result;
  } else if (params.file) {
    selectorLabel = `file ${params.file}`;
    const result = collectFileSeeds(deps, allFiles, params.file);
    if (typeof result === 'string') return result;
    seedFiles = result;
  } else if (params.table) {
    selectorLabel = `table ${params.table}`;
    const result = collectTableSeeds(deps, params.table);
    if (typeof result === 'string') return result;
    seedFiles = result.seedFiles;
    directTestHints = result.directTestHints;
  }

  if (seedFiles.length === 0 && directTestHints.size === 0) {
    return `No production touchpoints were found for ${selectorLabel}.`;
  }

  const ranked = rankTestFiles(testFiles, seedFiles, directTestHints).slice(0, limit);
  if (ranked.length === 0) {
    return `No likely test targets were found for ${selectorLabel}.`;
  }

  const uniqueSeedPaths = new Set(seedFiles.map((seed) => seed.path));
  const lines: string[] = [];
  lines.push('## Test Targets');
  lines.push(`- Selector: ${selectorLabel}`);
  lines.push(`- Production files considered: ${uniqueSeedPaths.size}`);
  lines.push(`- Indexed test files: ${testFiles.length}`);
  lines.push('');

  for (const candidate of ranked) {
    lines.push(`- ${candidate.path} — score ${candidate.score}; ${candidate.reasons.join('; ')}`);
  }

  return lines.join('\n');
}

function collectSymbolSeeds(deps: TestTargetsDeps, symbolName: string): SeedFile[] | string {
  const symbol = resolveSymbol(deps.repoId, symbolName, deps.symbolRepo);
  if (!symbol) {
    return `Symbol not found: "${symbolName}". Use cartograph_find to search.`;
  }

  const filePath = deps.symbolRepo.getFilePath(symbol.fileId);
  const seeds: SeedFile[] = [];
  if (filePath) {
    seeds.push({
      path: filePath,
      weight: 12,
      reason: `defines ${symbol.qualifiedName ?? symbol.name}`,
      symbolName: symbol.name,
    });
  }

  const dependents = deps.refRepo.findDependents(symbol.id, 2) as unknown as DependentRow[];
  for (const row of dependents) {
    if (!row.source_file_path || isTestPath(row.source_file_path)) continue;
    const depth = row.depth ?? 1;
    seeds.push({
      path: row.source_file_path,
      weight: Math.max(4, 10 - depth * 2),
      reason: `depends on ${symbol.qualifiedName ?? symbol.name}`,
      symbolName: row.source_qualified_name,
    });
  }

  return dedupeSeedFiles(seeds);
}

function collectFileSeeds(
  deps: TestTargetsDeps,
  files: FileRecord[],
  filePath: string
): SeedFile[] | string {
  const exact = files.find((file) => file.path === filePath);
  if (!exact) {
    const suggestions = files
      .filter((file) => file.path.includes(filePath))
      .slice(0, 5)
      .map((file) => `- ${file.path}`);

    if (suggestions.length > 0) {
      return [`File not found: "${filePath}".`, '', 'Did you mean:', ...suggestions].join('\n');
    }
    return `File not found: "${filePath}".`;
  }

  const seeds: SeedFile[] = [{
    path: exact.path,
    weight: 12,
    reason: 'selected file',
    symbolName: basenameWithoutExtension(exact.path),
  }];

  const symbols = deps.symbolRepo.findByFilePath(deps.repoId, exact.path);
  for (const symbol of symbols.filter((entry) => entry.parentSymbolId === null && entry.qualifiedName)) {
    const dependents = deps.refRepo.findDependents(symbol.id, 1) as unknown as DependentRow[];
    for (const row of dependents) {
      if (!row.source_file_path || isTestPath(row.source_file_path)) continue;
      seeds.push({
        path: row.source_file_path,
        weight: 8,
        reason: `wired to ${exact.path}`,
        symbolName: row.source_qualified_name,
      });
    }
  }

  return dedupeSeedFiles(seeds);
}

function collectTableSeeds(
  deps: TestTargetsDeps,
  tableName: string
): { seedFiles: SeedFile[]; directTestHints: Map<string, string[]> } | string {
  if (!deps.schemaRepo || !deps.symbolSchemaRepo) {
    throw new Error('Schema repositories are not available.');
  }

  const matches = deps.schemaRepo.findCurrentTablesByName(deps.repoId, tableName, 10);
  if (matches.length === 0) {
    return `Table not found: "${tableName}".`;
  }

  const normalized = normalizeSchemaName(tableName);
  const exactMatch = matches.find((match) => match.normalizedName === normalized);
  const table = exactMatch ?? matches[0]!;
  if (!exactMatch && matches.length > 1) {
    return [
      `Multiple tables match "${tableName}".`,
      '',
      ...matches.map((match) => `- ${match.name}`),
      '',
      'Retry with the full table name for an exact match.',
    ].join('\n');
  }

  const entityLinks = deps.symbolSchemaRepo.findEntitySymbolsByTable(deps.repoId, table.normalizedName);
  const seeds: SeedFile[] = entityLinks.map((entity) => ({
    path: entity.filePath,
    weight: 12,
    reason: `mapped entity ${entity.qualifiedName ?? entity.symbolName}`,
    symbolName: entity.qualifiedName ?? entity.symbolName,
  }));

  for (const entity of entityLinks) {
    const dependents = deps.refRepo.findDependents(entity.sourceSymbolId, 2) as unknown as DependentRow[];
    for (const row of dependents) {
      if (!row.source_file_path || isTestPath(row.source_file_path)) continue;
      const depth = row.depth ?? 1;
      seeds.push({
        path: row.source_file_path,
        weight: Math.max(4, 10 - depth * 2),
        reason: `touches ${table.name} via entity graph`,
        symbolName: row.source_qualified_name,
      });
    }
  }

  const directTestHints = new Map<string, string[]>();
  if (deps.repoPath) {
    const testMatches = findContentMatches(
      {
        repoId: deps.repoId,
        repoPath: deps.repoPath,
        fileRepo: deps.fileRepo!,
        symbolRepo: deps.symbolRepo,
      },
      {
        query: table.name,
        includeTests: true,
        limit: 200,
        lineMatcher: (line) => isLikelyTableMention(line, table.name),
      }
    ).filter((match) => match.isTest);

    for (const match of testMatches) {
      const reasons = directTestHints.get(match.filePath) ?? [];
      reasons.push(`mentions table ${table.name}`);
      directTestHints.set(match.filePath, reasons);
    }
  }

  return {
    seedFiles: dedupeSeedFiles(seeds),
    directTestHints,
  };
}

function rankTestFiles(
  testFiles: FileRecord[],
  seedFiles: SeedFile[],
  directTestHints: Map<string, string[]>
): CandidateScore[] {
  const ranked: CandidateScore[] = [];

  for (const testFile of testFiles) {
    let score = 0;
    const reasons: string[] = [];
    const testBase = normalizeTestBaseName(testFile.path);
    const testTokens = tokenizePath(testFile.path);

    const directHints = directTestHints.get(testFile.path) ?? [];
    if (directHints.length > 0) {
      score += 10;
      reasons.push(...directHints.slice(0, 2));
    }

    for (const seed of seedFiles) {
      const seedBase = normalizeProdBaseName(seed.path);
      const seedTokens = tokenizeSeed(seed);

      if (testBase === seedBase && seedBase !== '') {
        score += seed.weight + 8;
        reasons.push(`companion name for ${seed.path}`);
      }

      const overlap = countOverlap(testTokens, seedTokens);
      if (overlap > 0) {
        score += overlap * 2 + Math.min(seed.weight, 4);
        reasons.push(`shares ${overlap} name token${overlap === 1 ? '' : 's'} with ${seed.path}`);
      }

      const areaScore = sharedAreaScore(testFile.path, seed.path);
      if (areaScore > 0) {
        score += areaScore;
        reasons.push(`same area as ${seed.path}`);
      }
    }

    if (score < MIN_TEST_TARGET_SCORE) continue;
    ranked.push({
      path: testFile.path,
      score,
      reasons: uniqueReasons(reasons).slice(0, 3),
    });
  }

  return ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function dedupeSeedFiles(seeds: SeedFile[]): SeedFile[] {
  const deduped = new Map<string, SeedFile>();
  for (const seed of seeds) {
    const existing = deduped.get(seed.path);
    if (!existing || existing.weight < seed.weight) {
      deduped.set(seed.path, seed);
    }
  }
  return [...deduped.values()];
}

function basenameWithoutExtension(filePath: string): string {
  return basename(filePath, extname(filePath));
}

function normalizeProdBaseName(filePath: string): string {
  return normalizeNameStem(basenameWithoutExtension(filePath));
}

function normalizeTestBaseName(filePath: string): string {
  return normalizeNameStem(
    basenameWithoutExtension(filePath)
      .replace(/(?:Test|Tests|Spec|Specs|IntegrationTest|IT)$/i, '')
  );
}

function normalizeNameStem(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

function tokenizePath(filePath: string): Set<string> {
  return tokenizeValue(filePath);
}

function tokenizeSeed(seed: SeedFile): Set<string> {
  return tokenizeValue(`${seed.path} ${seed.symbolName ?? ''}`);
}

function tokenizeValue(value: string): Set<string> {
  const normalized = value
    .replace(/\\/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();

  return new Set(
    normalized
      .split(/[^a-z0-9]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3 && !['test', 'tests', 'spec', 'src', 'app'].includes(part))
  );
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let overlap = 0;
  for (const value of a) {
    if (b.has(value)) overlap++;
  }
  return overlap;
}

function sharedAreaScore(testPath: string, prodPath: string): number {
  const testDirs = dirname(testPath).toLowerCase().split(/[\\/]/).filter(Boolean);
  const prodDirs = dirname(prodPath).toLowerCase().split(/[\\/]/).filter(Boolean);
  const prodTail = prodDirs.slice(-2);
  const overlap = prodTail.filter((segment) => testDirs.includes(segment)).length;
  return overlap > 0 ? overlap * 2 : 0;
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons)];
}

function isLikelyTableMention(line: string, tableName: string): boolean {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i').test(line);
}
