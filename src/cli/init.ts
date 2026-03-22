import { Command } from 'commander';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import type { PostgresSchemaSourceConfig } from '../types.js';
import {
  buildCartographConfig,
  detectLanguages,
  detectPostgresConfig,
  upsertMcpConfig,
  writeCartographConfig,
} from './setup-shared.js';
import { refreshRepo, type RefreshRepoResult } from './refresh.js';

interface InitCliOptions {
  yes?: boolean;
  overwriteConfig?: boolean;
  claudeMd?: string;
  mcpPath?: string;
  dbPath?: string;
  schemaSource?: 'migrations' | 'postgres';
  dbHost?: string;
  dbPort?: string;
  dbUser?: string;
  dbPassword?: string;
  dbName?: string;
}

interface InitChoices {
  databasePath: string;
  schemaSource: 'migrations' | 'postgres';
  postgres?: Partial<PostgresSchemaSourceConfig>;
}

export interface InitRepoResult {
  configPath: string;
  configWritten: boolean;
  mcpPath: string;
  mcpCreated: boolean;
  refresh: RefreshRepoResult;
}

export async function initializeRepo(
  repoPath: string,
  opts: InitCliOptions = {}
): Promise<InitRepoResult> {
  const absoluteRepoPath = resolve(repoPath);
  const configPath = resolve(absoluteRepoPath, '.cartograph.yml');
  const existingConfig = existsSync(configPath);

  if (!existingConfig || opts.overwriteConfig) {
    const languages = detectLanguages(absoluteRepoPath);
    const detectedPostgres = detectPostgresConfig(absoluteRepoPath);
    const choices = await resolveInitChoices(absoluteRepoPath, detectedPostgres, opts);
    const config = buildCartographConfig({
      languages,
      databasePath: choices.databasePath,
      schemaSource: choices.schemaSource,
      postgres: choices.postgres,
    });
    writeCartographConfig(absoluteRepoPath, config, { overwrite: true });
  }

  const mcpResult = upsertMcpConfig(absoluteRepoPath, opts.mcpPath);
  const refresh = await refreshRepo(absoluteRepoPath, {
    claudeMd: opts.claudeMd,
    dbHost: opts.dbHost,
    dbPort: opts.dbPort,
    dbUser: opts.dbUser,
    dbPassword: opts.dbPassword,
    dbName: opts.dbName,
  });

  return {
    configPath,
    configWritten: !existingConfig || !!opts.overwriteConfig,
    mcpPath: mcpResult.path,
    mcpCreated: mcpResult.created,
    refresh,
  };
}

export function createInitCommand(): Command {
  return new Command('init')
    .description('Interactive first-time setup: create .cartograph.yml, register .mcp.json, run the first index, and inject CLAUDE.md guidance')
    .argument('[repo-path]', 'Path to the repository', '.')
    .option('--yes', 'Use detected defaults without prompts')
    .option('--overwrite-config', 'Overwrite an existing .cartograph.yml')
    .option('--claude-md <path>', 'Path to CLAUDE.md to inject into (default: auto-detect)')
    .option('--mcp-path <path>', 'Path to .mcp.json to create or update (default: <repo>/.mcp.json)')
    .option('--db-path <path>', 'SQLite database path to write into .cartograph.yml')
    .option('--schema-source <type>', 'Schema source to write into .cartograph.yml (migrations or postgres)')
    .option('--db-host <host>', 'PostgreSQL host for schema_source.type=postgres')
    .option('--db-port <port>', 'PostgreSQL port for schema_source.type=postgres')
    .option('--db-user <user>', 'PostgreSQL user for schema_source.type=postgres')
    .option('--db-password <password>', 'PostgreSQL password for schema_source.type=postgres')
    .option('--db-name <name>', 'PostgreSQL database for schema_source.type=postgres')
    .action(async (repoPath: string, opts: InitCliOptions) => {
      try {
        console.log('Running Cartograph init...');
        const result = await initializeRepo(repoPath, opts);
        if (result.configWritten) {
          console.log(`Wrote ${result.configPath}`);
        } else {
          console.log(`Using existing config at ${result.configPath}`);
        }
        console.log(`${result.mcpCreated ? 'Created' : 'Updated'} MCP config at ${result.mcpPath}`);
        console.log(`${result.refresh.claudeMdVerb} Cartograph section in ${result.refresh.claudeMdPath}`);
        if (result.refresh.removedLegacyFiles.length > 0) {
          console.log(`Removed legacy generated files: ${result.refresh.removedLegacyFiles.join(', ')}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exitCode = 1;
      }
    });
}

async function resolveInitChoices(
  repoPath: string,
  detectedPostgres: Partial<PostgresSchemaSourceConfig> | null,
  opts: InitCliOptions
): Promise<InitChoices> {
  if (opts.yes || !input.isTTY || !output.isTTY) {
    return buildChoicesFromDefaults(detectedPostgres, opts);
  }

  const defaults = buildChoicesFromDefaults(detectedPostgres, opts);
  const rl = createInterface({ input, output });

  try {
    const schemaSource = await promptSchemaSource(rl, defaults.schemaSource);
    const databasePath = await prompt(
      rl,
      `SQLite index path [${defaults.databasePath}]: `,
      defaults.databasePath
    );

    if (schemaSource !== 'postgres') {
      return { databasePath, schemaSource };
    }

    const postgresDefaults = defaults.postgres || {};
    const host = await prompt(rl, `PostgreSQL host [${postgresDefaults.host || 'localhost'}]: `, postgresDefaults.host || 'localhost');
    const port = await prompt(rl, `PostgreSQL port [${postgresDefaults.port || 5432}]: `, String(postgresDefaults.port || 5432));
    const user = await prompt(rl, `PostgreSQL user [${postgresDefaults.user || 'postgres'}]: `, postgresDefaults.user || 'postgres');
    const password = await prompt(rl, `PostgreSQL password [${postgresDefaults.password || ''}]: `, postgresDefaults.password || '');
    const database = await prompt(rl, `PostgreSQL database [${postgresDefaults.database || 'postgres'}]: `, postgresDefaults.database || 'postgres');

    return {
      databasePath,
      schemaSource,
      postgres: {
        type: 'postgres',
        host,
        port: Number.parseInt(port, 10) || 5432,
        user,
        password,
        database,
      },
    };
  } finally {
    rl.close();
  }
}

function buildChoicesFromDefaults(
  detectedPostgres: Partial<PostgresSchemaSourceConfig> | null,
  opts: InitCliOptions
): InitChoices {
  const schemaSource = opts.schemaSource
    || (detectedPostgres ? 'postgres' : 'migrations');

  if (schemaSource !== 'postgres') {
    return {
      databasePath: opts.dbPath || resolveDefaultDbPath(),
      schemaSource,
    };
  }

  return {
    databasePath: opts.dbPath || resolveDefaultDbPath(),
    schemaSource,
    postgres: {
      type: 'postgres',
      host: opts.dbHost || detectedPostgres?.host || 'localhost',
      port: parseOptionalPort(opts.dbPort) || detectedPostgres?.port || 5432,
      user: opts.dbUser || detectedPostgres?.user || 'postgres',
      password: opts.dbPassword || detectedPostgres?.password || '',
      database: opts.dbName || detectedPostgres?.database || 'postgres',
    },
  };
}

async function promptSchemaSource(
  rl: ReturnType<typeof createInterface>,
  defaultValue: 'migrations' | 'postgres'
): Promise<'migrations' | 'postgres'> {
  while (true) {
    const answer = (await prompt(
      rl,
      `Schema source [${defaultValue}] (migrations/postgres): `,
      defaultValue
    )).toLowerCase();
    if (answer === 'migrations' || answer === 'postgres') {
      return answer;
    }
  }
}

async function prompt(
  rl: ReturnType<typeof createInterface>,
  question: string,
  fallback: string
): Promise<string> {
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
}

function parseOptionalPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveDefaultDbPath(): string {
  return resolve(process.env.CARTOGRAPH_DB_PATH || `${homedir()}/.cartograph/cartograph.db`);
}
