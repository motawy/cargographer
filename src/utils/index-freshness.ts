export const STALE_INDEX_HOURS = 24;

export function describeAge(date: Date, now = Date.now()): string {
  const seconds = Math.floor((now - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function getIndexStalenessWarning(
  lastIndexedAt: Date | null,
  now = Date.now()
): string | null {
  if (!lastIndexedAt) {
    return 'Warning: index timestamp is unknown. Run `cartograph refresh` if results look stale.';
  }

  const hoursAgo = (now - lastIndexedAt.getTime()) / (1000 * 60 * 60);
  if (hoursAgo <= STALE_INDEX_HOURS) {
    return null;
  }

  return `Warning: index is ${describeAge(lastIndexedAt, now)} old. Run \`cartograph refresh\` if you need fresh results.`;
}
