import { describe, expect, it } from 'vitest';
import { parseSqliteTimestamp } from '../../src/utils/sqlite-time.js';

describe('parseSqliteTimestamp', () => {
  it('treats bare sqlite timestamps as UTC', () => {
    expect(parseSqliteTimestamp('2026-03-21 10:00:00').toISOString())
      .toBe('2026-03-21T10:00:00.000Z');
  });

  it('preserves ISO timestamps with timezone information', () => {
    expect(parseSqliteTimestamp('2026-03-21T10:00:00.000Z').toISOString())
      .toBe('2026-03-21T10:00:00.000Z');
  });
});
