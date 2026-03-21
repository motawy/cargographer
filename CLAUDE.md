# CLAUDE.md - Cartograph

## What This Repo Is

Cartograph is a TypeScript CLI and MCP server that indexes PHP codebases into a local SQLite database and generates AI-readable context files. The current implementation is PHP-only, SQLite-only, and uses stdio for MCP.

## Current Product Scope

- Supported language: PHP
- Database: `better-sqlite3`, default path `~/.cartograph/cartograph.db`
- No Redis, Postgres, pgvector, embeddings, LLM pipeline, or watch mode in the current code
- `generate` writes:
  - `.cartograph/CLAUDE.md`
  - `.cartograph/modules.md`
  - `.cartograph/dependencies.md`
  - `.cartograph/conventions.md`
- `generate` also injects or updates a Cartograph block in repo `CLAUDE.md` or `.claude/CLAUDE.md`

## Repo Structure

```text
src/cli/              CLI commands
src/indexer/          File discovery, AST parsing, reference extraction, indexing pipeline
src/indexer/parsers/  PHP Tree-sitter parser
src/output/           Markdown generators and CLAUDE.md injection helpers
src/mcp/              MCP server and tool handlers
src/db/               SQLite connection, migrations, repositories
tests/fixtures/       Sample Laravel project used by tests
tests/                Unit and integration tests
```

## CLI Commands

```bash
cartograph index <repo-path> [--run-migrations] [--verbose] [--log <path>]
cartograph generate <repo-path> [--claude-md <path>]
cartograph serve [--repo-path <path>]
cartograph uses <symbol> [--repo-path <path>] [--depth N]
cartograph impact <file> [--repo-path <path>] [--depth N]
cartograph trace <symbol> [--repo-path <path>] [--depth N]
cartograph reset [repo-path] [--yes]
```

Notes:

- `index --run-migrations` is required on first use unless migrations were already run separately.
- `serve` uses stdio transport by default. There is no `--stdio` flag.
- `uses` and `trace` expect fully qualified PHP symbol names.
- `impact` expects a file path relative to the indexed repo root.

## MCP Tools

Current MCP tools:

- `cartograph_status`
- `cartograph_find`
- `cartograph_symbol`
- `cartograph_deps`
- `cartograph_dependents`
- `cartograph_blast_radius`
- `cartograph_compare`
- `cartograph_flow`

## Implementation Notes

- File discovery prefers `git ls-files --cached --others --exclude-standard`, with a `fast-glob` fallback.
- The indexer is incremental and uses file content hashes to detect changed files.
- The parser only supports PHP even though the file walker knows about some other extensions.
- Output generators read indexed data from SQLite and do not rescan the codebase.
- `cartograph_compare` may read source files from the repo to inline short method bodies in responses.
- `serve`, `uses`, `impact`, `trace`, and `generate` all require the target repo to have already been indexed.

## Configuration

Supported `.cartograph.yml` keys today:

```yaml
languages:
  - php

exclude:
  - vendor/
  - node_modules/
  - .git/

database:
  path: /Users/you/.cartograph/cartograph.db
```

Notes:

- Keep `languages` set to `php` for now.
- Extra excludes are merged with the defaults.
- `CARTOGRAPH_DB_PATH` can override the default database location.

## Testing

- Tests use SQLite, usually `:memory:`.
- `tests/setup.ts` exports `createTestDb()` for a migrated in-memory database.
- If `better-sqlite3` fails with a `NODE_MODULE_VERSION` mismatch after switching Node versions, run `npm rebuild better-sqlite3`.

## Development Notes

- `docker-compose.yml` exists for optional future PostgreSQL experiments; it is not required by the current application flow.
- Keep docs aligned with the current implementation. Do not document embeddings, LLM summarization, Redis caching, subdirectory `CLAUDE.md` generation, or non-PHP parsing unless the code actually supports them.
