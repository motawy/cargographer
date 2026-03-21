import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import type { CartographConfig, PostgresSchemaSourceConfig, SchemaSourceConfig } from './types.js';

const DEFAULT_EXCLUDES = ['vendor/', 'node_modules/', '.git/'];
const DEFAULT_SCHEMA_SOURCE: SchemaSourceConfig = { type: 'migrations' };

export function loadConfig(repoPath: string): CartographConfig {
  const configPath = join(repoPath, '.cartograph.yml');

  const defaults: CartographConfig = {
    languages: ['php'],
    exclude: DEFAULT_EXCLUDES,
    additionalSources: [],
    schemaSource: DEFAULT_SCHEMA_SOURCE,
    database: {
      path: process.env.CARTOGRAPH_DB_PATH
        || join(homedir(), '.cartograph', 'cartograph.db'),
    },
  };

  if (!existsSync(configPath)) {
    return defaults;
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  const additionalSources = parsed?.additional_sources
    || parsed?.additionalSources
    || defaults.additionalSources;
  const schemaSource = parsed?.schema_source
    || parsed?.schemaSource
    || defaults.schemaSource;

  return {
    languages: parsed?.languages || defaults.languages,
    exclude: parsed?.exclude
      ? [...DEFAULT_EXCLUDES, ...parsed.exclude]
      : defaults.exclude,
    additionalSources,
    schemaSource,
    database: { ...defaults.database, ...(parsed?.database || {}) },
  };
}

export function resolvePostgresSchemaSource(
  source: PostgresSchemaSourceConfig | undefined,
  overrides: Partial<PostgresSchemaSourceConfig> = {}
): Required<Omit<PostgresSchemaSourceConfig, 'type'>> & { type: 'postgres' } {
  return {
    type: 'postgres',
    host: overrides.host ?? source?.host ?? process.env.CARTOGRAPH_DB_HOST ?? 'localhost',
    port: overrides.port ?? source?.port ?? parsePort(process.env.CARTOGRAPH_DB_PORT) ?? 5434,
    user: overrides.user ?? source?.user ?? process.env.CARTOGRAPH_DB_USER ?? 'pgsql',
    password: overrides.password ?? source?.password ?? process.env.CARTOGRAPH_DB_PASSWORD ?? 'example',
    database: overrides.database ?? source?.database ?? process.env.CARTOGRAPH_DB_NAME ?? 'two',
  };
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
