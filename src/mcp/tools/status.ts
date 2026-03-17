import type pg from 'pg';

interface StatusDeps {
  pool: pg.Pool;
  repoId: number;
}

export async function handleStatus(deps: StatusDeps): Promise<string> {
  const { pool, repoId } = deps;

  const { rows: [repo] } = await pool.query(
    'SELECT name, path, last_indexed_at FROM repos WHERE id = $1',
    [repoId]
  );

  const { rows: [fileCounts] } = await pool.query(
    `SELECT COUNT(*)::int AS total_files FROM files WHERE repo_id = $1`,
    [repoId]
  );

  const { rows: [symbolCounts] } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE s.kind = 'class')::int AS classes,
       COUNT(*) FILTER (WHERE s.kind = 'method')::int AS methods,
       COUNT(*) FILTER (WHERE s.kind = 'interface')::int AS interfaces,
       COUNT(*) FILTER (WHERE s.kind = 'trait')::int AS traits,
       COUNT(*) FILTER (WHERE s.kind = 'function')::int AS functions
     FROM symbols s
     JOIN files f ON s.file_id = f.id
     WHERE f.repo_id = $1`,
    [repoId]
  );

  const { rows: [refCounts] } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE sr.target_symbol_id IS NOT NULL)::int AS resolved,
       COUNT(*) FILTER (WHERE sr.target_symbol_id IS NULL)::int AS unresolved
     FROM symbol_references sr
     JOIN symbols s ON sr.source_symbol_id = s.id
     JOIN files f ON s.file_id = f.id
     WHERE f.repo_id = $1`,
    [repoId]
  );

  const lastIndexed = repo.last_indexed_at
    ? new Date(repo.last_indexed_at)
    : null;

  const lines: string[] = [];
  lines.push(`## Cartograph Index Status\n`);
  lines.push(`Repository: ${repo.name} (${repo.path})`);

  if (lastIndexed) {
    const ago = timeSince(lastIndexed);
    lines.push(`Last indexed: ${lastIndexed.toISOString()} (${ago})`);
    const hoursAgo = (Date.now() - lastIndexed.getTime()) / (1000 * 60 * 60);
    if (hoursAgo > 24) {
      lines.push(`⚠️  Index is ${Math.floor(hoursAgo / 24)} day(s) old. Consider re-running \`cartograph index\`.`);
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
