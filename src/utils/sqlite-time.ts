const SQLITE_UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

export function parseSqliteTimestamp(value: string): Date {
  const trimmed = value.trim();
  const match = trimmed.match(SQLITE_UTC_TIMESTAMP);
  if (match) {
    return new Date(`${match[1]}T${match[2]}Z`);
  }

  return new Date(trimmed);
}
