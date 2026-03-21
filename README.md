# Cartograph

**Map your codebase so AI can navigate it.**

Cartograph is a TypeScript CLI and MCP server that indexes a PHP codebase into a local SQLite database, generates AI-readable context files, and exposes code-navigation tools over MCP. It is built to make codebase exploration repeatable for AI tools by precomputing symbols, references, and module-level summaries instead of rediscovering them every session.

## Current Scope

- PHP symbol/reference indexing
- SQL DDL schema indexing for `.sql` files when `sql` is enabled in config
- Local SQLite database via `better-sqlite3`
- No Docker required for normal use
- No embeddings, LLM summarization, Redis, or pgvector in the current implementation
- Generated outputs:
  - `.cartograph/CLAUDE.md`
  - `.cartograph/modules.md`
  - `.cartograph/dependencies.md`
  - `.cartograph/conventions.md`
- `cartograph generate` also injects or updates a Cartograph section in `CLAUDE.md`

## What It Does

- Discovers source files using `git ls-files` when available, with `.cartograph.yml` excludes applied
- Can index explicit additional source roots outside the repo via `.cartograph.yml` `additional_sources`
- Parses PHP with Tree-sitter and indexes classes, interfaces, traits, enums, functions, methods, properties, and constants
- Parses SQL DDL and indexes tables, columns, and foreign keys
- Extracts Doctrine-style entity→table and property→column mappings from PHP attributes/docblocks when present
- Extracts references such as inheritance, implementations, trait use, instantiation, static calls, self calls, type hints, and class references
- Stores the index locally so CLI commands and MCP tools can answer structural questions without rescanning the repo

## Quick Start

Requires Node.js 22+.

### Install

```bash
npm install -g cartograph
```

### First-Time Index

Run migrations on the first index:

```bash
cartograph index /path/to/repo --run-migrations
```

Subsequent runs can omit `--run-migrations`.

### Generate Context Files

```bash
cartograph generate /path/to/repo
```

### Start the MCP Server

```bash
cartograph serve --repo-path /path/to/repo
```

`serve` uses stdio transport by default. There is no separate `--stdio` flag.

## Generated Files

After `cartograph generate`, the indexed repo will contain:

```text
your-repo/
└── .cartograph/
    ├── CLAUDE.md
    ├── modules.md
    ├── dependencies.md
    └── conventions.md
```

Generation behavior:

- Cartograph also injects or updates a managed section in the repo's main CLAUDE file.
- If `CLAUDE.md` exists at the repo root, Cartograph injects there.
- Otherwise, if `.claude/CLAUDE.md` exists, Cartograph injects there.
- Otherwise, Cartograph creates `CLAUDE.md` at the repo root.

## CLI Commands

### `cartograph index <repo-path>`

Build or update the codebase index.

Useful options:

- `--run-migrations` to create or update the SQLite schema before indexing
- `--verbose` to log each processed file
- `--log <path>` to write a full index log to a file

### `cartograph generate <repo-path>`

Generate `.cartograph` markdown files and inject the Cartograph guidance block into `CLAUDE.md`.

Useful options:

- `--claude-md <path>` to override the target `CLAUDE.md`

### `cartograph status [repo-path]`

Show index freshness, coverage, and unresolved-reference trust breakdown for an already indexed repo.

### `cartograph schema [query] --repo-path <path>`

List or search current indexed database tables with column counts and inbound/outbound foreign-key counts.

Useful options:

- `--limit <n>` to control how many tables are shown

### `cartograph table <table> --repo-path <path>`

Inspect the current indexed SQL table state: columns, outbound foreign keys, and inbound references from other tables.

### `cartograph table-graph <table> --repo-path <path>`

Traverse the foreign-key neighborhood around a table to see connected tables by depth.

Useful options:

- `--depth <n>` for foreign-key traversal depth

### `cartograph schema-import <repo-path>`

Import current schema directly from PostgreSQL into Cartograph's canonical schema layer.

### `cartograph table-usage <table> --repo-path <path>`

Bridge schema to code by showing mapped entities, mapped columns, and code references for a table.

Useful options:

- `--depth <n>` for transitive code-reference depth
- `--limit <n>` to control how many code touchpoints are shown

### `cartograph search-content <query> --repo-path <path>`

Search indexed source content by literal substring and map matches back to enclosing symbols.

Useful options:

- `--path <fragment>` to restrict the search to matching file paths
- `--limit <n>` to control how many matches are shown

### `cartograph compare-many <baseline> <others...> --repo-path <path>`

Compare one baseline symbol against several peers to spot missing methods, extra methods, and shared behavioral deltas.

### `cartograph serve --repo-path <path>`

Start the MCP server for an indexed repo using stdio transport.

### `cartograph uses <symbol> --repo-path <path>`

Find what uses a fully qualified symbol. This is reverse dependency lookup.

Useful options:

- `--depth <n>` for transitive lookup depth

### `cartograph impact <file> --repo-path <path>`

Show the blast radius of changing a file relative to the repo root.

Useful options:

- `--depth <n>` for transitive impact depth

### `cartograph trace <symbol> --repo-path <path>`

Trace execution flow forward from a fully qualified symbol.

Useful options:

- `--depth <n>` for traversal depth

### `cartograph reset [repo-path] --yes`

Drop all indexed data and recreate the schema from migrations.

## MCP Tools

The MCP server currently exposes these tools:

- `cartograph_status` - show index freshness, coverage, and unresolved-reference trust breakdown
- `cartograph_schema` - list or search current database tables
- `cartograph_table` - inspect current SQL table state, its columns, and foreign key relationships
- `cartograph_table_graph` - traverse the foreign-key neighborhood around a table
- `cartograph_table_usage` - bridge a table to mapped entities and code references
- `cartograph_find` - search symbols by name, kind, and optional path filter
- `cartograph_search_content` - search method bodies and other indexed source text by literal substring
- `cartograph_symbol` - inspect a symbol and its relationships
- `cartograph_deps` - trace forward dependencies
- `cartograph_dependents` - trace reverse dependencies
- `cartograph_blast_radius` - show file-level impact
- `cartograph_compare` - compare two symbols structurally
- `cartograph_compare_many` - compare one baseline symbol against multiple peers
- `cartograph_flow` - follow execution flow from an entry symbol

### Example MCP Config

```json
{
  "mcpServers": {
    "cartograph": {
      "command": "cartograph",
      "args": ["serve", "--repo-path", "/absolute/path/to/repo"]
    }
  }
}
```

MCP clients such as Claude Code launch `cartograph serve` for you. You do not need to start the server manually when it is configured in `.mcp.json`.

## Configuration

Cartograph reads `.cartograph.yml` from the repo root.

Supported keys today:

```yaml
languages:
  - php
  - sql

exclude:
  - vendor/
  - node_modules/
  - storage/

additional_sources:
  - path: ../../objects
    label: simpro-base

schema_source:
  type: postgres
  host: localhost
  port: 5434
  user: pgsql
  password: example
  database: two

database:
  path: /Users/you/.cartograph/cartograph.db
```

Notes:

- `languages` supports `php` and `sql`. PHP powers symbol/reference indexing; SQL powers raw schema extraction plus optional migration replay for current schema.
- Default excludes are `vendor/`, `node_modules/`, and `.git/`.
- `additional_sources` paths may be relative to the repo root or absolute. Indexed files from those roots are stored with an `@label/` path prefix such as `@simpro-base/SystemConfig.php`.
- `schema_source.type` defaults to `migrations`. Set it to `postgres` to import live schema after indexing instead of replaying SQL migrations into `db_current_*`.
- The database path defaults to `~/.cartograph/cartograph.db` and can also be overridden with `CARTOGRAPH_DB_PATH`.

## How It Works

1. File discovery builds a candidate set from tracked and untracked files.
2. Content hashing detects added, changed, and deleted files.
3. PHP parsing extracts symbols into the SQLite index.
4. Reference extraction records symbol relationships.
5. Doctrine-style entity/table mappings are extracted from PHP attributes and docblocks when present.
6. Cross-file resolution links references to concrete indexed symbols.
7. Current schema is materialized either from SQL migrations or a live PostgreSQL import.
8. Output generators and MCP tools read from the prebuilt index and canonical schema layer.

## Project Structure

```text
src/
  cli/          CLI commands
  indexer/      File discovery, parsing, reference extraction, indexing pipeline
  db/           SQLite connection, migrations, repositories
  output/       Markdown generators and CLAUDE.md section injection
  mcp/          MCP server and tool handlers
tests/
  fixtures/     Sample Laravel project
  indexer/      Indexing tests
  db/           Repository tests
  output/       Output-generator tests
  mcp/          MCP tool tests
  integration/  End-to-end indexing and generation tests
```

## Local Development

```bash
npm install
npm run build
npm run dev -- index /path/to/repo --run-migrations
npm run dev -- status /path/to/repo
npm run dev -- schema --repo-path /path/to/repo
npm run dev -- table <table-name> --repo-path /path/to/repo
npm run dev -- table-graph <table-name> --repo-path /path/to/repo --depth 2
npm run dev -- schema-import /path/to/repo
npm run dev -- generate /path/to/repo
npm run dev -- serve --repo-path /path/to/repo
npm test
```

There is a `docker-compose.yml` in the repo, but it is not required by the current application flow.

## Troubleshooting

### `better-sqlite3` Node ABI mismatch

If you change Node versions and see an error mentioning `NODE_MODULE_VERSION`, rebuild the native dependency:

```bash
npm rebuild better-sqlite3
```

If that is not enough, remove `node_modules` and reinstall.

### "No index found"

`generate`, `serve`, `uses`, `impact`, and `trace` all require the repo to have been indexed first.

### Unsupported language

If you configure languages other than `php`, file discovery may find those files, but parsing will fail because only PHP parsing is implemented today.
