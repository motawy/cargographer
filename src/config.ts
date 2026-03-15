import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { CartographConfig } from './types.js';

const DEFAULT_EXCLUDES = ['vendor/', 'node_modules/', '.git/'];

export function loadConfig(repoPath: string): CartographConfig {
  const configPath = join(repoPath, '.cartograph.yml');

  const defaults: CartographConfig = {
    languages: ['php'],
    exclude: DEFAULT_EXCLUDES,
    database: {
      host: process.env.CARTOGRAPH_DB_HOST || 'localhost',
      port: parseInt(process.env.CARTOGRAPH_DB_PORT || '5433'),
      name: process.env.CARTOGRAPH_DB_NAME || 'cartograph',
      user: process.env.CARTOGRAPH_DB_USER || 'cartograph',
      password: process.env.CARTOGRAPH_DB_PASSWORD || 'localdev',
    },
  };

  if (!existsSync(configPath)) {
    return defaults;
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);

  return {
    languages: parsed?.languages || defaults.languages,
    exclude: parsed?.exclude
      ? [...DEFAULT_EXCLUDES, ...parsed.exclude]
      : defaults.exclude,
    database: { ...defaults.database, ...(parsed?.database || {}) },
  };
}
