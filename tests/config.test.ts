import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, resolvePostgresSchemaSource } from '../src/config.js';

describe('config', () => {
  afterEach(() => {
    delete process.env.CARTOGRAPH_DB_HOST;
    delete process.env.CARTOGRAPH_DB_PORT;
    delete process.env.CARTOGRAPH_DB_USER;
    delete process.env.CARTOGRAPH_DB_PASSWORD;
    delete process.env.CARTOGRAPH_DB_NAME;
  });

  it('loads schema_source from .cartograph.yml', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'cartograph-config-'));

    try {
      writeFileSync(
        join(repoDir, '.cartograph.yml'),
        `languages:
  - php
schema_source:
  type: postgres
  host: db
  port: 5544
  user: app
  password: secret
  database: live
`
      );

      const config = loadConfig(repoDir);
      expect(config.schemaSource).toEqual({
        type: 'postgres',
        host: 'db',
        port: 5544,
        user: 'app',
        password: 'secret',
        database: 'live',
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('resolves postgres schema source from env defaults and overrides', () => {
    process.env.CARTOGRAPH_DB_HOST = 'env-host';
    process.env.CARTOGRAPH_DB_PORT = '6000';
    process.env.CARTOGRAPH_DB_USER = 'env-user';
    process.env.CARTOGRAPH_DB_PASSWORD = 'env-pass';
    process.env.CARTOGRAPH_DB_NAME = 'env-db';

    expect(resolvePostgresSchemaSource(undefined)).toEqual({
      type: 'postgres',
      host: 'env-host',
      port: 6000,
      user: 'env-user',
      password: 'env-pass',
      database: 'env-db',
    });

    expect(
      resolvePostgresSchemaSource(
        {
          type: 'postgres',
          host: 'config-host',
          port: 5432,
          user: 'config-user',
          password: 'config-pass',
          database: 'config-db',
        },
        { host: 'flag-host', database: 'flag-db' }
      )
    ).toEqual({
      type: 'postgres',
      host: 'flag-host',
      port: 5432,
      user: 'config-user',
      password: 'config-pass',
      database: 'flag-db',
    });
  });
});
