import type Database from 'better-sqlite3';
import { DbSchemaRepository } from '../../db/repositories/db-schema-repository.js';
import {
  analyzeUnresolvedReferences,
  formatUnresolvedCategory,
  type UnresolvedReferenceRow,
} from './status-classifier.js';

interface StatusDeps {
  db: Database.Database;
  repoId: number;
}

export function handleStatus(deps: StatusDeps): string {
  const { db, repoId } = deps;
  const schemaRepo = new DbSchemaRepository(db);

  const repo = db.prepare(
    'SELECT name, path, last_indexed_at FROM repos WHERE id = ?'
  ).get(repoId) as Record<string, unknown>;

  const fileCounts = db.prepare(
    'SELECT COUNT(*) AS total_files FROM files WHERE repo_id = ?'
  ).get(repoId) as Record<string, number>;

  const symbolCounts = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN s.kind = 'class' THEN 1 ELSE 0 END) AS classes,
       SUM(CASE WHEN s.kind = 'method' THEN 1 ELSE 0 END) AS methods,
       SUM(CASE WHEN s.kind = 'interface' THEN 1 ELSE 0 END) AS interfaces,
       SUM(CASE WHEN s.kind = 'trait' THEN 1 ELSE 0 END) AS traits,
       SUM(CASE WHEN s.kind = 'function' THEN 1 ELSE 0 END) AS functions
     FROM symbols s
     JOIN files f ON s.file_id = f.id
     WHERE f.repo_id = ?`
  ).get(repoId) as Record<string, number>;

  const refCounts = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN sr.target_symbol_id IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
       SUM(CASE WHEN sr.target_symbol_id IS NULL THEN 1 ELSE 0 END) AS unresolved
     FROM symbol_references sr
     JOIN symbols s ON sr.source_symbol_id = s.id
     JOIN files f ON s.file_id = f.id
     WHERE f.repo_id = ?`
  ).get(repoId) as Record<string, number>;

  const additionalSources = db.prepare(
    `SELECT substr(path, 2, instr(path, '/') - 2) AS label, COUNT(*) AS file_count
     FROM files
     WHERE repo_id = ? AND path LIKE '@%/%'
     GROUP BY label
     ORDER BY label`
  ).all(repoId) as { label: string; file_count: number }[];

  const unresolvedRows = db.prepare(
    `SELECT f.path AS source_path, sr.target_qualified_name, sr.reference_kind
     FROM symbol_references sr
     JOIN symbols s ON sr.source_symbol_id = s.id
     JOIN files f ON s.file_id = f.id
     WHERE f.repo_id = ? AND sr.target_symbol_id IS NULL`
  ).all(repoId) as {
    source_path: string;
    target_qualified_name: string;
    reference_kind: string;
  }[];

  const internalPrefixes = new Set(
    (db.prepare(
      `SELECT DISTINCT lower(
         CASE
           WHEN instr(s.qualified_name, '\\') > 0
             THEN substr(s.qualified_name, 1, instr(s.qualified_name, '\\') - 1)
           ELSE s.qualified_name
         END
       ) AS prefix
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = ?
         AND s.qualified_name IS NOT NULL
         AND s.parent_symbol_id IS NULL`
    ).all(repoId) as { prefix: string }[]).map((row) => row.prefix)
  );

  const unresolvedAnalysis = analyzeUnresolvedReferences(
    unresolvedRows.map((row): UnresolvedReferenceRow => ({
      sourcePath: row.source_path,
      targetQualifiedName: row.target_qualified_name,
      referenceKind: row.reference_kind,
    })),
    internalPrefixes
  );

  const productionRefs = db.prepare(
    `SELECT COUNT(*) AS total
     FROM symbol_references sr
     JOIN symbols s ON sr.source_symbol_id = s.id
     JOIN files f ON s.file_id = f.id
     WHERE f.repo_id = ?
       AND f.path NOT LIKE 'tests/%'
       AND f.path NOT LIKE 'cache/%'`
  ).get(repoId) as { total: number };
  const schemaCounts = schemaRepo.countByRepo(repoId);

  const lastIndexed = repo.last_indexed_at
    ? new Date(repo.last_indexed_at as string)
    : null;

  const lines: string[] = [];
  lines.push(`## Cartograph Index Status\n`);
  lines.push(`Repository: ${repo.name} (${repo.path})`);

  if (lastIndexed) {
    const ago = timeSince(lastIndexed);
    lines.push(`Last indexed: ${lastIndexed.toISOString()} (${ago})`);
    const hoursAgo = (Date.now() - lastIndexed.getTime()) / (1000 * 60 * 60);
    if (hoursAgo > 24) {
      lines.push(`\u26a0\ufe0f  Index is ${Math.floor(hoursAgo / 24)} day(s) old. Consider re-running \`cartograph index\`.`);
    }
  } else {
    lines.push(`Last indexed: unknown`);
  }

  lines.push('');
  lines.push(`### Coverage`);
  lines.push(`- Files: ${fileCounts.total_files}`);
  if (additionalSources.length > 0) {
    const sourceSummary = additionalSources
      .map((source) => `${source.label} (${source.file_count} files)`)
      .join(', ');
    lines.push(`- Additional sources: ${sourceSummary}`);
  }
  lines.push(`- Symbols: ${symbolCounts.total} (${symbolCounts.classes} classes, ${symbolCounts.methods} methods, ${symbolCounts.interfaces} interfaces, ${symbolCounts.traits} traits, ${symbolCounts.functions} functions)`);
  lines.push(`- References: ${refCounts.total} (${refCounts.resolved} resolved, ${refCounts.unresolved} unresolved)`);
  if (schemaCounts.tables > 0) {
    lines.push(
      `- DB schema: ${schemaCounts.tables} tables, ${schemaCounts.columns} columns, ` +
      `${schemaCounts.foreignKeys} foreign keys (${schemaCounts.files} SQL files)`
    );
  }

  if (refCounts.total > 0) {
    const pct = formatRate(refCounts.resolved, refCounts.total);
    lines.push(`- Raw resolution rate: ${pct}%`);
  }

  if (productionRefs.total > 0) {
    const trustPct = formatRate(
      productionRefs.total - unresolvedAnalysis.productionPotentialInternalCount,
      productionRefs.total
    );
    lines.push(
      `- Production trust rate: ${trustPct}% ` +
      `(potential internal/cross-repo gaps: ${unresolvedAnalysis.productionPotentialInternalCount})`
    );
  }

  if (refCounts.unresolved > 0) {
    lines.push('');
    lines.push('### Unresolved Breakdown');

    const orderedBreakdown = [...unresolvedAnalysis.counts.entries()]
      .sort((a, b) => b[1] - a[1]);

    for (const [category, count] of orderedBreakdown) {
      const pct = Math.round((count / refCounts.unresolved) * 100);
      lines.push(`- ${formatUnresolvedCategory(category)}: ${count} (${pct}%)`);
    }
  }

  return lines.join('\n');
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatRate(numerator: number, denominator: number): string {
  if (denominator <= 0) return '0';

  if (numerator >= denominator) {
    return '100';
  }

  const rounded = Math.round((numerator / denominator) * 1000) / 10;
  const capped = Math.min(99.9, rounded);

  if (Number.isInteger(capped)) {
    return capped.toFixed(0);
  }

  return capped.toFixed(1);
}
