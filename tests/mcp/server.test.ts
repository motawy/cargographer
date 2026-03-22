import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RepoRepository } from '../../src/db/repositories/repo-repository.js';
import { FileRepository } from '../../src/db/repositories/file-repository.js';
import { SymbolRepository } from '../../src/db/repositories/symbol-repository.js';
import { DbSchemaRepository } from '../../src/db/repositories/db-schema-repository.js';
import { SymbolSchemaRepository } from '../../src/db/repositories/symbol-schema-repository.js';
import { createServer } from '../../src/mcp/server.js';
import type { ParsedSymbol } from '../../src/types.js';

describe('MCP Server Integration', () => {
  let db: Database.Database;
  let client: Client;
  let repoId: number;

  beforeAll(async () => {
    db = openDatabase({ path: ':memory:' });
    runMigrations(db);

    const repoRepo = new RepoRepository(db);
    const fileRepo = new FileRepository(db);
    const symbolRepo = new SymbolRepository(db);
    const schemaRepo = new DbSchemaRepository(db);
    const symbolSchemaRepo = new SymbolSchemaRepository(db);

    const repo = repoRepo.findOrCreate('/test/repo', 'test');
    repoId = repo.id;

    const f1 = fileRepo.upsert(repoId, 'app/Foo.php', 'php', 'h1', 10);
    fileRepo.upsert(repoId, 'tests/FooTest.php', 'php', 'h2', 10);
    const sym: ParsedSymbol = {
      name: 'Foo', qualifiedName: 'App\\Foo',
      kind: 'class', visibility: null, lineStart: 1, lineEnd: 10,
      signature: null, returnType: null, docblock: null, children: [], metadata: {},
    };
    const symbolMap = symbolRepo.replaceFileSymbols(f1.id, [sym]);
    symbolSchemaRepo.replaceFileLinks(f1.id, symbolMap, [
      {
        sourceQualifiedName: 'App\\Foo',
        tableName: 'quotes',
        normalizedTableName: 'quotes',
        linkKind: 'entity_table',
      },
    ], []);
    schemaRepo.replaceCurrentSchemaFromImport(repo.id, [
      {
        name: 'quotes',
        normalizedName: 'quotes',
        sourcePath: null,
        lineStart: null,
        lineEnd: null,
        columns: [
          {
            name: 'id',
            normalizedName: 'id',
            dataType: 'integer',
            isNullable: false,
            defaultValue: null,
            ordinalPosition: 1,
            sourcePath: null,
            lineNumber: null,
          },
        ],
        foreignKeys: [],
      },
    ]);

    // Create server + in-memory transport for testing
    const server = createServer({ db, repoId });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'test-client', version: '0.1.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    db.close();
  });

  it('lists all 16 tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'cartograph_blast_radius',
      'cartograph_compare',
      'cartograph_compare_many',
      'cartograph_dependents',
      'cartograph_deps',
      'cartograph_find',
      'cartograph_flow',
      'cartograph_scaffold_plan',
      'cartograph_schema',
      'cartograph_search_content',
      'cartograph_status',
      'cartograph_symbol',
      'cartograph_table',
      'cartograph_table_graph',
      'cartograph_table_usage',
      'cartograph_test_targets',
    ]);
  });

  it('handles cartograph_find tool call', async () => {
    const result = await client.callTool({ name: 'cartograph_find', arguments: { query: 'Foo' } });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('App\\Foo');
    expect(text).toContain('class');
  });

  it('handles tool call with not-found result', async () => {
    const result = await client.callTool({ name: 'cartograph_symbol', arguments: { name: 'Nonexistent' } });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('not found');
  });

  it('handles cartograph_schema tool call', async () => {
    const result = await client.callTool({ name: 'cartograph_schema', arguments: { query: 'quote' } });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('## Schema');
    expect(text).toContain('quotes');
  });

  it('handles cartograph_table_usage tool call', async () => {
    const result = await client.callTool({ name: 'cartograph_table_usage', arguments: { name: 'quotes' } });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('## Table Usage: quotes');
    expect(text).toContain('App\\Foo');
  });

  it('handles cartograph_test_targets tool call', async () => {
    const result = await client.callTool({ name: 'cartograph_test_targets', arguments: { symbol: 'App\\Foo' } });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('## Test Targets');
    expect(text).toContain('tests/FooTest.php');
  });

  it('handles cartograph_scaffold_plan tool call', async () => {
    const result = await client.callTool({ name: 'cartograph_scaffold_plan', arguments: { reference: 'App\\Foo', target: 'Bar' } });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('## Scaffold Plan: App\\Foo');
    expect(text).toContain('app/Bar.php');
  });

  it('prepends a stale-index warning to non-status tool calls', async () => {
    db.prepare(
      "UPDATE repos SET last_indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days') WHERE id = ?"
    ).run(repoId);

    const result = await client.callTool({ name: 'cartograph_find', arguments: { query: 'Foo' } });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('Warning: index is');
    expect(text).toContain('Run `cartograph refresh`');

    const statusResult = await client.callTool({ name: 'cartograph_status', arguments: {} });
    const statusText = (statusResult.content as { type: string; text: string }[])[0].text;
    expect(statusText.match(/index is .* old/ig)?.length ?? 0).toBe(1);
  });
});
