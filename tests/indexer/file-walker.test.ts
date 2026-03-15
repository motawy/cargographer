import { describe, it, expect } from 'vitest';
import { discoverFiles } from '../../src/indexer/file-walker.js';
import { join } from 'path';
import type { CartographConfig } from '../../src/types.js';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'laravel-sample');

function makeConfig(overrides: Partial<CartographConfig> = {}): CartographConfig {
  return {
    languages: ['php'],
    exclude: ['vendor/'],
    database: { host: '', port: 0, name: '', user: '', password: '' },
    ...overrides,
  };
}

describe('File Walker', () => {
  it('discovers all PHP files in fixture project', async () => {
    const files = await discoverFiles(FIXTURES_DIR, makeConfig());

    expect(files).toHaveLength(6);
    const paths = files.map((f) => f.relativePath).sort();
    expect(paths).toEqual([
      'app/Contracts/UserServiceInterface.php',
      'app/Http/Controllers/UserController.php',
      'app/Models/User.php',
      'app/Repositories/UserRepository.php',
      'app/Services/UserService.php',
      'app/Traits/HasTimestamps.php',
    ]);
  });

  it('computes SHA-256 hashes (64-char hex)', async () => {
    const files = await discoverFiles(FIXTURES_DIR, makeConfig());

    for (const file of files) {
      expect(file.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('sets language to php for .php files', async () => {
    const files = await discoverFiles(FIXTURES_DIR, makeConfig());
    expect(files.every((f) => f.language === 'php')).toBe(true);
  });

  it('respects exclude patterns', async () => {
    const files = await discoverFiles(
      FIXTURES_DIR,
      makeConfig({ exclude: ['vendor/', 'app/Models/'] })
    );

    const paths = files.map((f) => f.relativePath);
    expect(paths.every((p) => !p.startsWith('app/Models/'))).toBe(true);
    expect(paths).not.toContain('app/Models/User.php');
  });

  it('returns both relative and absolute paths', async () => {
    const files = await discoverFiles(FIXTURES_DIR, makeConfig());

    for (const file of files) {
      expect(file.absolutePath.startsWith(FIXTURES_DIR)).toBe(true);
      expect(file.relativePath).not.toContain(FIXTURES_DIR);
      expect(file.absolutePath.endsWith(file.relativePath)).toBe(true);
    }
  });

  it('filters by configured languages', async () => {
    const files = await discoverFiles(
      FIXTURES_DIR,
      makeConfig({ languages: ['typescript'] })
    );
    expect(files).toHaveLength(0);
  });

  it('produces stable hashes for unchanged files', async () => {
    const first = await discoverFiles(FIXTURES_DIR, makeConfig());
    const second = await discoverFiles(FIXTURES_DIR, makeConfig());

    for (let i = 0; i < first.length; i++) {
      expect(first[i].hash).toBe(second[i].hash);
    }
  });
});
