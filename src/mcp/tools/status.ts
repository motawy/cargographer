import type Database from 'better-sqlite3';

interface StatusDeps {
  db: Database.Database;
  repoId: number;
}

export function handleStatus(deps: StatusDeps): string {
  const { db, repoId } = deps;

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
  lines.push(`- Symbols: ${symbolCounts.total} (${symbolCounts.classes} classes, ${symbolCounts.methods} methods, ${symbolCounts.interfaces} interfaces, ${symbolCounts.traits} traits, ${symbolCounts.functions} functions)`);
  lines.push(`- References: ${refCounts.total} (${refCounts.resolved} resolved, ${refCounts.unresolved} unresolved)`);

  if (refCounts.total > 0) {
    const pct = Math.round((refCounts.resolved / refCounts.total) * 100);
    lines.push(`- Resolution rate: ${pct}%`);
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
