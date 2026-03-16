# Milestone 2.1: Static Reference Extraction — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract static cross-file references from PHP AST, resolve them against the symbol index, and expose `uses`, `impact`, and `trace` CLI commands.

**Architecture:** A separate `ReferenceExtractor` walks the same tree-sitter AST that the declaration parser already builds. References are stored in the existing `symbol_references` table, then resolved via a batch SQL step. Three new CLI commands query the reference graph.

**Tech Stack:** Tree-sitter (PHP), PostgreSQL recursive CTEs, Commander.js

**Spec:** `docs/superpowers/specs/2026-03-16-milestone-2-dependency-tracing-design.md`

---

## File Structure

**New files:**
- `src/indexer/reference-extractor.ts` — Extracts references from AST tree
- `src/db/repositories/reference-repository.ts` — DB operations for symbol_references
- `src/cli/uses.ts` — `cartograph uses <symbol>` command
- `src/cli/impact.ts` — `cartograph impact <file>` command
- `src/cli/trace.ts` — `cartograph trace <symbol>` command
- `tests/indexer/reference-extractor.test.ts` — Unit tests for extraction
- `tests/integration/references.test.ts` — Integration tests for resolution + queries

**Modified files:**
- `src/types.ts` — Add `ReferenceKind`, `ParsedReference`
- `src/indexer/ast-parser.ts` — Return tree + namespace context alongside symbols
- `src/indexer/parsers/php.ts` — Export `NamespaceContext` type, return tree from `parsePHP`
- `src/db/repositories/symbol-repository.ts` — Return qualified name → ID map from `replaceFileSymbols`
- `src/indexer/pipeline.ts` — Add reference extraction + resolution steps
- `src/cli/main.ts` — Register new commands

---

## Chunk 1: Types, Parser Changes, and Reference Extractor

### Task 1: Add reference types to types.ts

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add ReferenceKind and ParsedReference types**

Add to `src/types.ts`:

```typescript
export type ReferenceKind =
  | 'inheritance'
  | 'implementation'
  | 'trait_use'
  | 'instantiation'
  | 'static_call'
  | 'type_hint'
  | 'self_call'
  | 'static_access';

export interface ParsedReference {
  sourceQualifiedName: string;
  targetQualifiedName: string;
  kind: ReferenceKind;
  line: number;
}
```

- [ ] **Step 2: Verify build passes**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "[feat]: add ReferenceKind and ParsedReference types"
```

---

### Task 2: Update AstParser to return tree and namespace context

The reference extractor needs to walk the same tree-sitter tree. Currently the tree is created inside `parsePHP()` and discarded. We need to surface it.

**Files:**
- Modify: `src/indexer/parsers/php.ts`
- Modify: `src/indexer/ast-parser.ts`

- [ ] **Step 1: Export NamespaceContext and update parsePHP return type**

In `src/indexer/parsers/php.ts`:

1. Add `export` to the `NamespaceContext` interface (line 11):
```typescript
export interface NamespaceContext {
```

2. Update `ParseResult` in `src/types.ts` to include the tree. Actually, `ParseResult` is already in types.ts and has `namespace` and `imports` but not the tree. We need to keep the tree-sitter tree out of the shared types (it's a parser-internal concern). Instead, `parsePHP` will accept an externally-created tree:

Change `parsePHP` signature from:
```typescript
export function parsePHP(source: string, parser: Parser): ParseResult {
  const tree = parser.parse(source);
  const root = tree.rootNode;
```

To:
```typescript
export function parsePHP(tree: Parser.Tree): ParseResult {
  const root = tree.rootNode;
```

The `parser.parse(source)` call moves to `AstParser.parse()` where the tree can be retained.

- [ ] **Step 2: Update AstParser to create the tree and pass it**

Update `src/indexer/ast-parser.ts`:

```typescript
import Parser from 'tree-sitter';
// @ts-expect-error - tree-sitter-php has no proper ESM types
import PHP from 'tree-sitter-php';
import { readFileSync } from 'fs';
import type { DiscoveredFile, ParsedSymbol, ParseResult } from '../types.js';
import { parsePHP, type NamespaceContext } from './parsers/php.js';
import { ParseError } from '../errors.js';

export interface AstParseResult {
  symbols: ParsedSymbol[];
  linesOfCode: number;
  tree: Parser.Tree;
  context: NamespaceContext;
}

export class AstParser {
  private phpParser: Parser;

  constructor() {
    this.phpParser = new Parser();
    this.phpParser.setLanguage(PHP.php);
  }

  parse(file: DiscoveredFile): AstParseResult {
    const source = readFileSync(file.absolutePath, 'utf-8');
    const linesOfCode = source.split('\n').length;

    switch (file.language) {
      case 'php': {
        const tree = this.phpParser.parse(source);
        const result = parsePHP(tree);
        return {
          symbols: result.symbols,
          linesOfCode,
          tree,
          context: { namespace: result.namespace, imports: result.imports },
        };
      }
      default:
        throw new ParseError(
          `Unsupported language: ${file.language}`,
          file.relativePath
        );
    }
  }
}
```

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `npm test`
Expected: All 40 tests pass (the `parsePHP` signature change needs all callers updated — tests call `parsePHP(source, parser)` directly)

- [ ] **Step 4: Update test callers of parsePHP**

In `tests/indexer/parsers/php.test.ts`, the tests call `parsePHP(source, parser)`. Update them to:
```typescript
const tree = parser.parse(source);
const result = parsePHP(tree);
```

Find and replace all occurrences of `parsePHP(source, parser)` with:
```typescript
const tree = parser.parse(source);
const result = parsePHP(tree);
```

For multiline patterns where `source` is defined inline, the `source` variable is still needed for the `parser.parse(source)` call. The tree is created first, then passed to `parsePHP`.

- [ ] **Step 5: Run tests again**

Run: `npm test`
Expected: All 40 tests pass

- [ ] **Step 6: Commit**

```bash
git add src/indexer/ast-parser.ts src/indexer/parsers/php.ts tests/indexer/parsers/php.test.ts
git commit -m "[refactor]: AstParser returns tree and namespace context for reference extraction"
```

---

### Task 3: Reference extractor — class-level references

Extract `inheritance`, `implementation`, and `trait_use` references from class declarations. These are the simplest because they're already partially handled in the parser's metadata.

**Files:**
- Create: `src/indexer/reference-extractor.ts`
- Create: `tests/indexer/reference-extractor.test.ts`

- [ ] **Step 1: Write failing tests for class-level references**

Create `tests/indexer/reference-extractor.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
// @ts-expect-error - tree-sitter-php has no proper ESM types
import PHP from 'tree-sitter-php';
import { extractReferences } from '../../src/indexer/reference-extractor.js';
import { parsePHP, type NamespaceContext } from '../../src/indexer/parsers/php.js';

let parser: Parser;

beforeAll(() => {
  parser = new Parser();
  parser.setLanguage(PHP.php);
});

function parseAndExtract(source: string) {
  const tree = parser.parse(source);
  const parseResult = parsePHP(tree);
  const context: NamespaceContext = {
    namespace: parseResult.namespace,
    imports: parseResult.imports,
  };
  return extractReferences(tree, context, parseResult.symbols);
}

describe('ReferenceExtractor', () => {
  describe('inheritance', () => {
    it('extracts extends reference', () => {
      const refs = parseAndExtract(`<?php
        namespace App\\Models;
        use Illuminate\\Database\\Eloquent\\Model;
        class User extends Model {}
      `);

      const inheritance = refs.filter(r => r.kind === 'inheritance');
      expect(inheritance).toHaveLength(1);
      expect(inheritance[0].sourceQualifiedName).toBe('App\\Models\\User');
      expect(inheritance[0].targetQualifiedName).toBe('Illuminate\\Database\\Eloquent\\Model');
    });

    it('extracts implements references', () => {
      const refs = parseAndExtract(`<?php
        namespace App\\Services;
        use App\\Contracts\\UserServiceInterface;
        class UserService implements UserServiceInterface {}
      `);

      const impls = refs.filter(r => r.kind === 'implementation');
      expect(impls).toHaveLength(1);
      expect(impls[0].targetQualifiedName).toBe('App\\Contracts\\UserServiceInterface');
    });

    it('extracts trait use references', () => {
      const refs = parseAndExtract(`<?php
        namespace App\\Models;
        use App\\Traits\\HasTimestamps;
        class User {
            use HasTimestamps;
        }
      `);

      const traits = refs.filter(r => r.kind === 'trait_use');
      expect(traits).toHaveLength(1);
      expect(traits[0].targetQualifiedName).toBe('App\\Traits\\HasTimestamps');
      expect(traits[0].sourceQualifiedName).toBe('App\\Models\\User');
    });

    it('extracts multiple implements', () => {
      const refs = parseAndExtract(`<?php
        namespace App;
        use App\\Contracts\\Loggable;
        use App\\Contracts\\Cacheable;
        class Foo implements Loggable, Cacheable {}
      `);

      const impls = refs.filter(r => r.kind === 'implementation');
      expect(impls).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run tests/indexer/reference-extractor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement class-level reference extraction**

Create `src/indexer/reference-extractor.ts`:

```typescript
import type Parser from 'tree-sitter';
import type { ParsedSymbol, ParsedReference, ReferenceKind } from '../types.js';
import type { NamespaceContext } from './parsers/php.js';

type SyntaxNode = Parser.SyntaxNode;

export function extractReferences(
  tree: Parser.Tree,
  context: NamespaceContext,
  symbols: ParsedSymbol[]
): ParsedReference[] {
  const refs: ParsedReference[] = [];
  const root = tree.rootNode;

  // Build a flat list of class-like symbols for lookup
  const classSymbols = symbols.filter(s =>
    ['class', 'interface', 'trait', 'enum'].includes(s.kind)
  );

  for (const symbol of classSymbols) {
    // Find the corresponding AST node by line number
    const node = findClassNodeAtLine(root, symbol.lineStart);
    if (!node) continue;

    refs.push(...extractClassLevelRefs(node, symbol, context));
  }

  return refs;
}

function extractClassLevelRefs(
  node: SyntaxNode,
  symbol: ParsedSymbol,
  context: NamespaceContext
): ParsedReference[] {
  const refs: ParsedReference[] = [];

  // extends
  const baseClause = findChild(node, 'base_clause');
  if (baseClause) {
    const name = extractTypeName(baseClause);
    if (name) {
      refs.push({
        sourceQualifiedName: symbol.qualifiedName,
        targetQualifiedName: resolveTypeName(name, context),
        kind: 'inheritance',
        line: baseClause.startPosition.row + 1,
      });
    }
  }

  // implements
  const interfaceClause = findChild(node, 'class_interface_clause');
  if (interfaceClause) {
    for (let i = 0; i < interfaceClause.childCount; i++) {
      const child = interfaceClause.child(i)!;
      const name = extractNameFromNode(child);
      if (name) {
        refs.push({
          sourceQualifiedName: symbol.qualifiedName,
          targetQualifiedName: resolveTypeName(name, context),
          kind: 'implementation',
          line: interfaceClause.startPosition.row + 1,
        });
      }
    }
  }

  // trait use
  const body = findChild(node, 'declaration_list');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const member = body.child(i)!;
      if (member.type === 'use_declaration') {
        for (let j = 0; j < member.childCount; j++) {
          const traitChild = member.child(j)!;
          const name = extractNameFromNode(traitChild);
          if (name) {
            refs.push({
              sourceQualifiedName: symbol.qualifiedName,
              targetQualifiedName: resolveTypeName(name, context),
              kind: 'trait_use',
              line: member.startPosition.row + 1,
            });
          }
        }
      }
    }
  }

  return refs;
}

// --- Name resolution (mirrors php.ts logic) ---

function resolveTypeName(name: string, context: NamespaceContext): string {
  if (name.startsWith('\\')) return name.substring(1);

  const firstPart = name.split('\\')[0];
  if (context.imports.has(firstPart)) {
    const resolved = context.imports.get(firstPart)!;
    const rest = name.substring(firstPart.length);
    return resolved + rest;
  }

  if (context.namespace) {
    return `${context.namespace}\\${name}`;
  }

  return name;
}

function extractNameFromNode(node: SyntaxNode): string | null {
  if (node.type === 'name') return node.text;
  if (node.type === 'qualified_name') return extractQualifiedNameText(node);
  return null;
}

function extractTypeName(node: SyntaxNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    const name = extractNameFromNode(child);
    if (name) return name;
  }
  return null;
}

function extractQualifiedNameText(node: SyntaxNode): string {
  const parts: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'namespace_name') {
      parts.push(extractNamespaceText(child));
    } else if (child.type === 'name') {
      parts.push(child.text);
    }
  }
  return parts.join('\\');
}

function extractNamespaceText(node: SyntaxNode): string {
  const parts: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'name') parts.push(child.text);
  }
  return parts.join('\\');
}

function findChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)!.type === type) return node.child(i)!;
  }
  return null;
}

// Find the 'name' node that appears after a '::' operator
function findNameAfterOperator(node: SyntaxNode, operator: string): SyntaxNode | null {
  let foundOp = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.text === operator) {
      foundOp = true;
      continue;
    }
    if (foundOp && child.type === 'name') return child;
  }
  return null;
}

// PHP self/static/parent are case-insensitive
function isSelfReference(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'self' || lower === 'static' || lower === 'parent';
}

function findClassNodeAtLine(root: SyntaxNode, line: number): SyntaxNode | null {
  const classTypes = new Set([
    'class_declaration', 'interface_declaration',
    'trait_declaration', 'enum_declaration',
  ]);

  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (classTypes.has(child.type) && child.startPosition.row + 1 === line) {
      return child;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `./node_modules/.bin/vitest run tests/indexer/reference-extractor.test.ts`
Expected: All 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/indexer/reference-extractor.ts tests/indexer/reference-extractor.test.ts
git commit -m "[feat]: reference extractor — class-level refs (extends, implements, trait use)"
```

---

### Task 4: Reference extractor — type hints

Extract type hint references from method parameters, return types, and property types.

**Files:**
- Modify: `src/indexer/reference-extractor.ts`
- Modify: `tests/indexer/reference-extractor.test.ts`

- [ ] **Step 1: Add failing tests for type hint extraction**

Add to `tests/indexer/reference-extractor.test.ts`:

```typescript
describe('type hints', () => {
  it('extracts parameter type hints', () => {
    const refs = parseAndExtract(`<?php
      namespace App\\Repositories;
      use App\\Models\\User;
      class UserRepository {
          public function update(User $user, array $data): User {
              return $user;
          }
      }
    `);

    const hints = refs.filter(r => r.kind === 'type_hint');
    // 'User' param + 'User' return = 2 (array is builtin, skipped)
    expect(hints).toHaveLength(2);
    expect(hints.every(h => h.targetQualifiedName === 'App\\Models\\User')).toBe(true);
    expect(hints[0].sourceQualifiedName).toBe('App\\Repositories\\UserRepository::update');
  });

  it('extracts property type hints', () => {
    const refs = parseAndExtract(`<?php
      namespace App\\Services;
      use App\\Repositories\\UserRepository;
      class UserService {
          private UserRepository $userRepo;
      }
    `);

    const hints = refs.filter(r => r.kind === 'type_hint');
    expect(hints).toHaveLength(1);
    expect(hints[0].sourceQualifiedName).toBe('App\\Services\\UserService');
    expect(hints[0].targetQualifiedName).toBe('App\\Repositories\\UserRepository');
  });

  it('extracts promoted property type hints', () => {
    const refs = parseAndExtract(`<?php
      namespace App\\Http\\Controllers;
      use App\\Services\\UserService;
      class UserController {
          public function __construct(
              private readonly UserService $userService
          ) {}
      }
    `);

    const hints = refs.filter(r => r.kind === 'type_hint');
    expect(hints).toHaveLength(1);
    expect(hints[0].targetQualifiedName).toBe('App\\Services\\UserService');
  });

  it('skips builtin types', () => {
    const refs = parseAndExtract(`<?php
      namespace App;
      class Foo {
          public function bar(int $id, string $name, bool $active): void {}
      }
    `);

    const hints = refs.filter(r => r.kind === 'type_hint');
    expect(hints).toHaveLength(0);
  });

  it('extracts nullable type hints', () => {
    const refs = parseAndExtract(`<?php
      namespace App\\Services;
      use App\\Models\\User;
      class UserService {
          public function find(int $id): ?User {
              return null;
          }
      }
    `);

    const hints = refs.filter(r => r.kind === 'type_hint');
    expect(hints).toHaveLength(1);
    expect(hints[0].targetQualifiedName).toBe('App\\Models\\User');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/indexer/reference-extractor.test.ts`
Expected: New tests FAIL

- [ ] **Step 3: Implement type hint extraction**

Add to `src/indexer/reference-extractor.ts`:

1. A `BUILTIN_TYPES` set:
```typescript
const BUILTIN_TYPES = new Set([
  'int', 'float', 'string', 'bool', 'array', 'object', 'callable',
  'iterable', 'void', 'never', 'null', 'mixed', 'true', 'false',
  'self', 'static', 'parent',
]);
```

2. Update `extractReferences` to also extract type hints from methods and properties within each class symbol:

After the class-level refs loop, add method body traversal:
```typescript
for (const symbol of classSymbols) {
  const node = findClassNodeAtLine(root, symbol.lineStart);
  if (!node) continue;

  refs.push(...extractClassLevelRefs(node, symbol, context));
  refs.push(...extractMemberTypeHints(node, symbol, context));
}
```

3. Implement `extractMemberTypeHints`:
```typescript
function extractMemberTypeHints(
  classNode: SyntaxNode,
  classSymbol: ParsedSymbol,
  context: NamespaceContext
): ParsedReference[] {
  const refs: ParsedReference[] = [];
  const body = findChild(classNode, 'declaration_list');
  if (!body) return refs;

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i)!;

    if (member.type === 'method_declaration') {
      const methodName = findChild(member, 'name')?.text;
      if (!methodName) continue;
      const sourceQN = `${classSymbol.qualifiedName}::${methodName}`;
      refs.push(...extractMethodTypeHints(member, sourceQN, context));
    }

    if (member.type === 'property_declaration') {
      refs.push(...extractPropertyTypeHint(member, classSymbol.qualifiedName, context));
    }
  }

  return refs;
}
```

4. Implement `extractMethodTypeHints` — walks `formal_parameters` for param types, finds return type after `:`:
```typescript
function extractMethodTypeHints(
  methodNode: SyntaxNode,
  sourceQualifiedName: string,
  context: NamespaceContext
): ParsedReference[] {
  const refs: ParsedReference[] = [];

  // Parameter types
  const params = findChild(methodNode, 'formal_parameters');
  if (params) {
    for (let i = 0; i < params.childCount; i++) {
      const param = params.child(i)!;
      if (param.type === 'simple_parameter' || param.type === 'property_promotion_parameter') {
        refs.push(...extractTypeRefFromNode(param, sourceQualifiedName, context));
      }
    }
  }

  // Return type
  let foundColon = false;
  for (let i = 0; i < methodNode.childCount; i++) {
    const child = methodNode.child(i)!;
    if (child.text === ':') { foundColon = true; continue; }
    if (foundColon && isTypeNode(child)) {
      refs.push(...typeNodeToRefs(child, sourceQualifiedName, context));
      break;
    }
  }

  return refs;
}
```

5. Helper functions:
```typescript
function extractPropertyTypeHint(
  propNode: SyntaxNode,
  classQualifiedName: string,
  context: NamespaceContext
): ParsedReference[] {
  return extractTypeRefFromNode(propNode, classQualifiedName, context);
}

function extractTypeRefFromNode(
  node: SyntaxNode,
  sourceQualifiedName: string,
  context: NamespaceContext
): ParsedReference[] {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (isTypeNode(child)) {
      return typeNodeToRefs(child, sourceQualifiedName, context);
    }
  }
  return [];
}

function typeNodeToRefs(
  typeNode: SyntaxNode,
  sourceQualifiedName: string,
  context: NamespaceContext
): ParsedReference[] {
  const refs: ParsedReference[] = [];

  // For union/intersection types, recurse into children
  if (typeNode.type === 'union_type' || typeNode.type === 'intersection_type') {
    for (let i = 0; i < typeNode.childCount; i++) {
      refs.push(...typeNodeToRefs(typeNode.child(i)!, sourceQualifiedName, context));
    }
    return refs;
  }

  // For nullable types like ?User, unwrap
  if (typeNode.type === 'nullable_type') {
    for (let i = 0; i < typeNode.childCount; i++) {
      refs.push(...typeNodeToRefs(typeNode.child(i)!, sourceQualifiedName, context));
    }
    return refs;
  }

  // named_type contains name or qualified_name
  if (typeNode.type === 'named_type') {
    const name = extractNameFromNode(typeNode.child(0)!);
    if (name && !BUILTIN_TYPES.has(name.toLowerCase())) {
      refs.push({
        sourceQualifiedName,
        targetQualifiedName: resolveTypeName(name, context),
        kind: 'type_hint',
        line: typeNode.startPosition.row + 1,
      });
    }
    return refs;
  }

  // For optional_type (also nullable)
  if (typeNode.type === 'optional_type') {
    for (let i = 0; i < typeNode.childCount; i++) {
      refs.push(...typeNodeToRefs(typeNode.child(i)!, sourceQualifiedName, context));
    }
    return refs;
  }

  return refs;
}

const TYPE_NODE_TYPES = new Set([
  'named_type', 'optional_type', 'union_type',
  'intersection_type', 'primitive_type', 'nullable_type',
]);

function isTypeNode(node: SyntaxNode): boolean {
  return TYPE_NODE_TYPES.has(node.type);
}
```

- [ ] **Step 4: Run tests**

Run: `./node_modules/.bin/vitest run tests/indexer/reference-extractor.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/indexer/reference-extractor.ts tests/indexer/reference-extractor.test.ts
git commit -m "[feat]: reference extractor — type hint extraction (params, returns, properties)"
```

---

### Task 5: Reference extractor — instantiation, static calls, self calls

Extract `new ClassName()`, `ClassName::method()`, `ClassName::CONST`, and `$this->method()`.

**Files:**
- Modify: `src/indexer/reference-extractor.ts`
- Modify: `tests/indexer/reference-extractor.test.ts`

- [ ] **Step 1: Add failing tests**

Add to `tests/indexer/reference-extractor.test.ts`:

```typescript
describe('instantiation', () => {
  it('extracts new ClassName()', () => {
    const refs = parseAndExtract(`<?php
      namespace App\\Services;
      use App\\Repositories\\UserRepository;
      class UserService {
          public function init(): void {
              $repo = new UserRepository();
          }
      }
    `);

    const insts = refs.filter(r => r.kind === 'instantiation');
    expect(insts).toHaveLength(1);
    expect(insts[0].sourceQualifiedName).toBe('App\\Services\\UserService::init');
    expect(insts[0].targetQualifiedName).toBe('App\\Repositories\\UserRepository');
  });
});

describe('static calls', () => {
  it('extracts ClassName::method()', () => {
    const refs = parseAndExtract(`<?php
      namespace App\\Repositories;
      use App\\Models\\User;
      class UserRepository {
          public function find(int $id): ?User {
              return User::find($id);
          }
      }
    `);

    const statics = refs.filter(r => r.kind === 'static_call');
    expect(statics).toHaveLength(1);
    expect(statics[0].sourceQualifiedName).toBe('App\\Repositories\\UserRepository::find');
    expect(statics[0].targetQualifiedName).toBe('App\\Models\\User::find');
  });
});

describe('static access', () => {
  it('extracts ClassName::CONST', () => {
    const refs = parseAndExtract(`<?php
      namespace App\\Services;
      use App\\Models\\User;
      class StatusService {
          public function getDefault(): string {
              return User::STATUS_ACTIVE;
          }
      }
    `);

    const access = refs.filter(r => r.kind === 'static_access');
    expect(access).toHaveLength(1);
    expect(access[0].targetQualifiedName).toBe('App\\Models\\User::STATUS_ACTIVE');
  });
});

describe('self calls', () => {
  it('extracts $this->method()', () => {
    const refs = parseAndExtract(`<?php
      namespace App\\Services;
      class UserService {
          public function update(int $id): void {
              $user = $this->findById($id);
          }
          public function findById(int $id): void {}
      }
    `);

    const selfCalls = refs.filter(r => r.kind === 'self_call');
    expect(selfCalls).toHaveLength(1);
    expect(selfCalls[0].sourceQualifiedName).toBe('App\\Services\\UserService::update');
    expect(selfCalls[0].targetQualifiedName).toBe('App\\Services\\UserService::findById');
  });

  it('does not extract $this->property access as self_call', () => {
    const refs = parseAndExtract(`<?php
      namespace App;
      class Foo {
          private int $count;
          public function bar(): int {
              return $this->count;
          }
      }
    `);

    const selfCalls = refs.filter(r => r.kind === 'self_call');
    expect(selfCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/indexer/reference-extractor.test.ts`
Expected: New tests FAIL

- [ ] **Step 3: Implement body reference extraction**

Update `extractReferences` to walk method bodies:

```typescript
export function extractReferences(
  tree: Parser.Tree,
  context: NamespaceContext,
  symbols: ParsedSymbol[]
): ParsedReference[] {
  const refs: ParsedReference[] = [];
  const root = tree.rootNode;

  const classSymbols = symbols.filter(s =>
    ['class', 'interface', 'trait', 'enum'].includes(s.kind)
  );

  for (const symbol of classSymbols) {
    const node = findClassNodeAtLine(root, symbol.lineStart);
    if (!node) continue;

    refs.push(...extractClassLevelRefs(node, symbol, context));
    refs.push(...extractMemberTypeHints(node, symbol, context));
    refs.push(...extractBodyReferences(node, symbol, context));
  }

  return refs;
}
```

Add `extractBodyReferences`:

```typescript
function extractBodyReferences(
  classNode: SyntaxNode,
  classSymbol: ParsedSymbol,
  context: NamespaceContext
): ParsedReference[] {
  const refs: ParsedReference[] = [];
  const body = findChild(classNode, 'declaration_list');
  if (!body) return refs;

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i)!;
    if (member.type !== 'method_declaration') continue;

    const methodName = findChild(member, 'name')?.text;
    if (!methodName) continue;
    const sourceQN = `${classSymbol.qualifiedName}::${methodName}`;

    // Walk the compound_statement (method body)
    const methodBody = findChild(member, 'compound_statement');
    if (methodBody) {
      walkForReferences(methodBody, sourceQN, classSymbol.qualifiedName, context, refs);
    }
  }

  return refs;
}

function walkForReferences(
  node: SyntaxNode,
  sourceQN: string,
  classQN: string,
  context: NamespaceContext,
  refs: ParsedReference[]
): void {
  // new ClassName()
  if (node.type === 'object_creation_expression') {
    // Walk children to find the class name (skip 'new' keyword)
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      const name = extractNameFromNode(child);
      if (name && name !== 'new') {
        refs.push({
          sourceQualifiedName: sourceQN,
          targetQualifiedName: resolveTypeName(name, context),
          kind: 'instantiation',
          line: node.startPosition.row + 1,
        });
        break;
      }
    }
  }

  // ClassName::method() — scoped_call_expression
  // Structure: [name/qualified_name, "::", name, arguments]
  // The class name is child(0), the method name appears AFTER "::"
  if (node.type === 'scoped_call_expression') {
    const scopeNode = node.child(0);
    const memberNode = findNameAfterOperator(node, '::');
    if (scopeNode && memberNode) {
      const className = extractNameFromNode(scopeNode);
      if (className && !isSelfReference(className)) {
        refs.push({
          sourceQualifiedName: sourceQN,
          targetQualifiedName: `${resolveTypeName(className, context)}::${memberNode.text}`,
          kind: 'static_call',
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  // ClassName::CONST or ClassName::$prop — class_constant_access_expression
  // Same structure: [name/qualified_name, "::", name]
  if (node.type === 'class_constant_access_expression') {
    const scopeNode = node.child(0);
    const memberNode = findNameAfterOperator(node, '::');
    if (scopeNode && memberNode) {
      const className = extractNameFromNode(scopeNode);
      if (className && !isSelfReference(className)) {
        refs.push({
          sourceQualifiedName: sourceQN,
          targetQualifiedName: `${resolveTypeName(className, context)}::${memberNode.text}`,
          kind: 'static_access',
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  // $this->method() — member_call_expression where object is $this
  if (node.type === 'member_call_expression') {
    const objectNode = node.child(0);
    const memberName = findChild(node, 'name');
    if (objectNode?.type === 'variable_name' && objectNode.text === '$this' && memberName) {
      refs.push({
        sourceQualifiedName: sourceQN,
        targetQualifiedName: `${classQN}::${memberName.text}`,
        kind: 'self_call',
        line: node.startPosition.row + 1,
      });
    }
  }

  // Recurse into children (but not into nested class declarations)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'class_declaration') continue; // skip anonymous classes
    walkForReferences(child, sourceQN, classQN, context, refs);
  }
}
```

- [ ] **Step 4: Run all reference extractor tests**

Run: `./node_modules/.bin/vitest run tests/indexer/reference-extractor.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full test suite for regressions**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/indexer/reference-extractor.ts tests/indexer/reference-extractor.test.ts
git commit -m "[feat]: reference extractor — instantiation, static calls, self calls"
```

---

## Chunk 2: Database Layer and Pipeline Integration

### Task 6: Reference repository

**Files:**
- Create: `src/db/repositories/reference-repository.ts`

- [ ] **Step 1: Create reference repository**

```typescript
import type pg from 'pg';

export interface ReferenceRecord {
  id: number;
  sourceSymbolId: number;
  targetQualifiedName: string;
  targetSymbolId: number | null;
  referenceKind: string;
  lineNumber: number | null;
}

export class ReferenceRepository {
  constructor(private pool: pg.Pool) {}

  async replaceFileReferences(
    fileId: number,
    symbolIdMap: Map<string, number>,
    references: { sourceQualifiedName: string; targetQualifiedName: string; kind: string; line: number }[]
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Delete existing references for symbols in this file
      await client.query(
        `DELETE FROM symbol_references
         WHERE source_symbol_id IN (
           SELECT id FROM symbols WHERE file_id = $1
         )`,
        [fileId]
      );

      // Insert new references
      for (const ref of references) {
        const sourceId = symbolIdMap.get(ref.sourceQualifiedName);
        if (!sourceId) continue; // skip if source symbol not found

        await client.query(
          `INSERT INTO symbol_references
             (source_symbol_id, target_qualified_name, reference_kind, line_number)
           VALUES ($1, $2, $3, $4)`,
          [sourceId, ref.targetQualifiedName, ref.kind, ref.line]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async resolveTargets(repoId: number): Promise<{ resolved: number; unresolved: number }> {
    // Match target_qualified_name → symbols.qualified_name within this repo
    const { rowCount: resolved } = await this.pool.query(
      `UPDATE symbol_references sr
       SET target_symbol_id = s.id
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = $1
         AND sr.target_qualified_name = s.qualified_name
         AND sr.target_symbol_id IS NULL
         AND sr.source_symbol_id IN (
           SELECT id FROM symbols WHERE file_id IN (
             SELECT id FROM files WHERE repo_id = $1
           )
         )`,
      [repoId]
    );

    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = $1 AND sr.target_symbol_id IS NULL`,
      [repoId]
    );

    return {
      resolved: resolved || 0,
      unresolved: rows[0].count as number,
    };
  }

  async findDependents(
    symbolId: number,
    depth: number = 1
  ): Promise<ReferenceRecord[]> {
    if (depth <= 1) {
      const { rows } = await this.pool.query(
        `SELECT sr.*, s.qualified_name AS source_qualified_name,
                f.path AS source_file_path
         FROM symbol_references sr
         JOIN symbols s ON sr.source_symbol_id = s.id
         JOIN files f ON s.file_id = f.id
         WHERE sr.target_symbol_id = $1
         ORDER BY f.path, sr.line_number`,
        [symbolId]
      );
      return rows.map((r: Record<string, unknown>) => this.toRecord(r));
    }

    // Recursive CTE for transitive dependents
    const { rows } = await this.pool.query(
      `WITH RECURSIVE deps AS (
         SELECT sr.*, 1 AS depth
         FROM symbol_references sr
         WHERE sr.target_symbol_id = $1
         UNION ALL
         SELECT sr.*, d.depth + 1
         FROM symbol_references sr
         JOIN deps d ON sr.target_symbol_id = d.source_symbol_id
         WHERE d.depth < $2
       )
       SELECT DISTINCT ON (deps.source_symbol_id) deps.*,
              s.qualified_name AS source_qualified_name,
              f.path AS source_file_path
       FROM deps
       JOIN symbols s ON deps.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       ORDER BY deps.source_symbol_id, deps.depth`,
      [symbolId, depth]
    );
    return rows.map((r: Record<string, unknown>) => this.toRecord(r));
  }

  async findDependencies(symbolId: number): Promise<ReferenceRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT sr.* FROM symbol_references sr
       WHERE sr.source_symbol_id = $1
       ORDER BY sr.line_number`,
      [symbolId]
    );
    return rows.map((r: Record<string, unknown>) => this.toRecord(r));
  }

  async countByRepo(repoId: number): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE f.repo_id = $1`,
      [repoId]
    );
    return rows[0].count as number;
  }

  private toRecord(row: Record<string, unknown>): ReferenceRecord {
    return {
      id: row.id as number,
      sourceSymbolId: row.source_symbol_id as number,
      targetQualifiedName: row.target_qualified_name as string,
      targetSymbolId: (row.target_symbol_id as number) || null,
      referenceKind: row.reference_kind as string,
      lineNumber: (row.line_number as number) || null,
    };
  }
}
```

- [ ] **Step 2: Verify build passes**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/reference-repository.ts
git commit -m "[feat]: reference repository with resolution and recursive CTE queries"
```

---

### Task 7: Update SymbolRepository to return ID map

The pipeline needs to map qualified names to symbol IDs for reference insertion.

**Files:**
- Modify: `src/db/repositories/symbol-repository.ts`

- [ ] **Step 1: Update replaceFileSymbols to return a symbol ID map**

Change return type from `Promise<void>` to `Promise<Map<string, number>>`:

```typescript
async replaceFileSymbols(
  fileId: number,
  symbols: ParsedSymbol[]
): Promise<Map<string, number>> {
  const idMap = new Map<string, number>();
  const client = await this.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM symbols WHERE file_id = $1', [fileId]);

    for (const symbol of symbols) {
      await this.insertSymbol(client, fileId, symbol, null, idMap);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return idMap;
}
```

Update `insertSymbol` to populate the map:

```typescript
private async insertSymbol(
  client: pg.PoolClient,
  fileId: number,
  symbol: ParsedSymbol,
  parentId: number | null,
  idMap: Map<string, number>
): Promise<number> {
  const { rows } = await client.query(
    `INSERT INTO symbols
       (file_id, kind, name, qualified_name, visibility, parent_symbol_id,
        line_start, line_end, signature, return_type, docblock, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      fileId, symbol.kind, symbol.name, symbol.qualifiedName,
      symbol.visibility, parentId, symbol.lineStart, symbol.lineEnd,
      symbol.signature, symbol.returnType, symbol.docblock,
      JSON.stringify(symbol.metadata),
    ]
  );

  const symbolId = rows[0].id as number;
  if (symbol.qualifiedName) {
    idMap.set(symbol.qualifiedName, symbolId);
  }

  for (const child of symbol.children) {
    await this.insertSymbol(client, fileId, child, symbolId, idMap);
  }

  return symbolId;
}
```

- [ ] **Step 2: Run existing tests**

Run: `npm test`
Expected: All tests pass (return value was previously ignored)

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/symbol-repository.ts
git commit -m "[refactor]: symbol repository returns qualified name → ID map"
```

---

### Task 8: Pipeline integration

Wire reference extraction and resolution into the index pipeline.

**Files:**
- Modify: `src/indexer/pipeline.ts`

- [ ] **Step 1: Update pipeline to extract and store references**

Add imports:
```typescript
import { extractReferences } from './reference-extractor.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';
```

Add `referenceRepo` to constructor:
```typescript
private referenceRepo: ReferenceRepository;

constructor(pool: pg.Pool) {
  this.repoRepo = new RepoRepository(pool);
  this.fileRepo = new FileRepository(pool);
  this.symbolRepo = new SymbolRepository(pool);
  this.referenceRepo = new ReferenceRepository(pool);
}
```

Update the parse loop in `run()`. Change the existing step 5 from:
```typescript
const { symbols, linesOfCode } = parser.parse(file);
```

To use the new return type and extract references:
```typescript
const { symbols, linesOfCode, tree, context } = parser.parse(file);
const fileRecord = await this.fileRepo.upsert(
  repo.id, file.relativePath, file.language, file.hash, linesOfCode
);
const symbolIdMap = await this.symbolRepo.replaceFileSymbols(fileRecord.id, symbols);

// Extract and store references
try {
  const references = extractReferences(tree, context, symbols);
  await this.referenceRepo.replaceFileReferences(fileRecord.id, symbolIdMap, references);
} catch (refErr) {
  // Reference extraction is best-effort — don't fail the file
  if (opts.verbose) {
    log(`  Warning: reference extraction failed for ${file.relativePath}: ${refErr}`);
  }
}
```

After the parse loop, before updating repo timestamp, add resolution:
```typescript
// 6. Cross-file reference resolution
const resolution = await this.referenceRepo.resolveTargets(repo.id);
log(`References: ${resolution.resolved} resolved, ${resolution.unresolved} unresolved`);
```

Update the report line to include reference count:
```typescript
const totalRefs = await this.referenceRepo.countByRepo(repo.id);
log(
  `Done. Processed ${toProcess.length - errors} files (${errors} errors). ` +
  `${totalSymbols} symbols, ${totalRefs} references indexed. Total time: ${this.elapsed(runStart)}`
);
```

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All tests pass (integration tests will now also create references)

- [ ] **Step 3: Test with fixtures**

Run: `./node_modules/.bin/tsx src/cli/main.ts index tests/fixtures/laravel-sample --verbose`
Expected output includes references line, e.g.:
```
References: X resolved, Y unresolved
Done. Processed 6 files (0 errors). 34 symbols, N references indexed.
```

- [ ] **Step 4: Commit**

```bash
git add src/indexer/pipeline.ts
git commit -m "[feat]: pipeline extracts and resolves references during indexing"
```

---

### Task 9: Integration tests for reference resolution

**Files:**
- Create: `tests/integration/references.test.ts`

- [ ] **Step 1: Write integration tests**

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { join } from 'path';
import type { CartographConfig } from '../../src/types.js';

const TEST_DB = {
  host: 'localhost',
  port: 5433,
  database: 'cartograph_test',
  user: 'cartograph',
  password: 'localdev',
};

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'laravel-sample');

function testConfig(): CartographConfig {
  return {
    languages: ['php'],
    exclude: ['vendor/'],
    database: {
      host: TEST_DB.host,
      port: TEST_DB.port,
      name: TEST_DB.database,
      user: TEST_DB.user,
      password: TEST_DB.password,
    },
  };
}

describe('Reference Resolution (Integration)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool(TEST_DB);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM symbol_references');
    await pool.query('DELETE FROM symbols');
    await pool.query('DELETE FROM files');
    await pool.query('DELETE FROM repos');
  });

  it('creates references during indexing', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM symbol_references'
    );
    expect(rows[0].count).toBeGreaterThan(0);
  });

  it('resolves cross-file references', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    // UserService implements UserServiceInterface — should be resolved
    const { rows } = await pool.query(
      `SELECT sr.* FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       WHERE s.qualified_name = $1
         AND sr.reference_kind = 'implementation'`,
      ['App\\Services\\UserService']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].target_qualified_name).toBe('App\\Contracts\\UserServiceInterface');
    expect(rows[0].target_symbol_id).not.toBeNull();
  });

  it('resolves inheritance references', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows } = await pool.query(
      `SELECT sr.* FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       WHERE s.qualified_name = $1
         AND sr.reference_kind = 'inheritance'`,
      ['App\\Models\\User']
    );
    // extends Model — Model is external (Illuminate), so target_symbol_id is NULL
    expect(rows).toHaveLength(1);
    expect(rows[0].target_symbol_id).toBeNull();
  });

  it('resolves trait use references', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows } = await pool.query(
      `SELECT sr.* FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       WHERE s.qualified_name = $1
         AND sr.reference_kind = 'trait_use'`,
      ['App\\Models\\User']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].target_qualified_name).toBe('App\\Traits\\HasTimestamps');
    expect(rows[0].target_symbol_id).not.toBeNull();
  });

  it('stores type hint references', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    // UserService::findById has return type ?User
    const { rows } = await pool.query(
      `SELECT sr.* FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       WHERE s.qualified_name = $1
         AND sr.reference_kind = 'type_hint'`,
      ['App\\Services\\UserService::findById']
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r: Record<string, unknown>) =>
      r.target_qualified_name === 'App\\Models\\User'
    )).toBe(true);
  });

  it('stores static call references', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    // UserRepository::find calls User::find
    const { rows } = await pool.query(
      `SELECT sr.* FROM symbol_references sr
       JOIN symbols s ON sr.source_symbol_id = s.id
       WHERE s.qualified_name = $1
         AND sr.reference_kind = 'static_call'`,
      ['App\\Repositories\\UserRepository::find']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].target_qualified_name).toBe('App\\Models\\User::find');
  });

  it('reference count is reasonable for fixture project', async () => {
    const pipeline = new IndexPipeline(pool);
    await pipeline.run(FIXTURES, testConfig());

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM symbol_references'
    );
    // Expect roughly 20-30 references for the 6 fixture files
    expect(rows[0].count).toBeGreaterThanOrEqual(15);
    expect(rows[0].count).toBeLessThan(50);
  });

  it('is idempotent — re-indexing produces same reference count', async () => {
    const pipeline = new IndexPipeline(pool);
    const config = testConfig();

    await pipeline.run(FIXTURES, config);
    const { rows: first } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM symbol_references'
    );

    // Clear hashes to force re-parse
    await pool.query("UPDATE files SET hash = 'stale'");
    await pipeline.run(FIXTURES, config);
    const { rows: second } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM symbol_references'
    );

    expect(first[0].count).toBe(second[0].count);
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/integration/references.test.ts
git commit -m "[test]: integration tests for reference extraction and cross-file resolution"
```

---

## Chunk 3: CLI Commands

### Task 10: `cartograph uses` command

**Files:**
- Create: `src/cli/uses.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: Create the uses command**

Create `src/cli/uses.ts`:

```typescript
import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createPool } from '../db/connection.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';

export function createUsesCommand(): Command {
  return new Command('uses')
    .description('Find what uses a given symbol')
    .argument('<symbol>', 'Fully qualified symbol name (e.g. App\\\\Services\\\\UserService::findById)')
    .option('--depth <n>', 'Depth of transitive search (default: 1)', '1')
    .option('--repo-path <path>', 'Repository path (for config loading)', '.')
    .action(async (symbol: string, opts: { depth: string; repoPath: string }) => {
      const config = loadConfig(opts.repoPath);
      const pool = createPool(config.database);

      try {
        // Find the symbol ID
        const { rows: symbolRows } = await pool.query(
          'SELECT id, qualified_name, kind FROM symbols WHERE qualified_name = $1',
          [symbol]
        );

        if (symbolRows.length === 0) {
          console.error(`Symbol not found: ${symbol}`);
          console.error('Hint: Use fully qualified names, e.g. App\\\\Services\\\\UserService::findById');
          process.exit(1);
        }

        const refRepo = new ReferenceRepository(pool);
        const depth = parseInt(opts.depth, 10);
        const dependents = await refRepo.findDependents(symbolRows[0].id, depth);

        if (dependents.length === 0) {
          console.log(`No references found for ${symbol}`);
          return;
        }

        console.log(`\nSymbol: ${symbol} (${symbolRows[0].kind})`);
        console.log(`Found ${dependents.length} reference(s):\n`);

        for (const dep of dependents) {
          const row = dep as unknown as Record<string, unknown>;
          const sourceQN = row.source_qualified_name || 'unknown';
          const filePath = row.source_file_path || 'unknown';
          const line = dep.lineNumber || '?';
          console.log(`  ${sourceQN} (${dep.referenceKind}, line ${line})`);
          console.log(`    ${filePath}`);
        }
      } finally {
        await pool.end();
      }
    });
}
```

- [ ] **Step 2: Create the impact command**

Create `src/cli/impact.ts`:

```typescript
import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createPool } from '../db/connection.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';

export function createImpactCommand(): Command {
  return new Command('impact')
    .description('Show what is affected by changes to a file')
    .argument('<file>', 'File path relative to repo root')
    .option('--depth <n>', 'Depth of transitive impact (default: 3)', '3')
    .option('--repo-path <path>', 'Repository path (for config loading)', '.')
    .action(async (file: string, opts: { depth: string; repoPath: string }) => {
      const config = loadConfig(opts.repoPath);
      const pool = createPool(config.database);

      try {
        // Find all symbols in this file
        const { rows: fileSymbols } = await pool.query(
          `SELECT s.id, s.qualified_name, s.kind
           FROM symbols s
           JOIN files f ON s.file_id = f.id
           WHERE f.path = $1`,
          [file]
        );

        if (fileSymbols.length === 0) {
          console.error(`No symbols found in file: ${file}`);
          console.error('Hint: Use the path relative to the repo root, e.g. app/Services/UserService.php');
          process.exit(1);
        }

        const refRepo = new ReferenceRepository(pool);
        const depth = parseInt(opts.depth, 10);

        // Collect all dependents across all symbols in the file
        const allDependents = new Map<string, { qualifiedName: string; filePath: string; kind: string; depth: number }>();

        for (const sym of fileSymbols) {
          const deps = await refRepo.findDependents(sym.id, depth);
          for (const dep of deps) {
            const row = dep as unknown as Record<string, unknown>;
            const sourceQN = row.source_qualified_name as string;
            const filePath = row.source_file_path as string;
            if (sourceQN && !allDependents.has(sourceQN)) {
              allDependents.set(sourceQN, {
                qualifiedName: sourceQN,
                filePath: filePath || 'unknown',
                kind: dep.referenceKind,
                depth: (row.depth as number) || 1,
              });
            }
          }
        }

        if (allDependents.size === 0) {
          console.log(`No dependents found for ${file}`);
          return;
        }

        // Group by file
        const byFile = new Map<string, string[]>();
        for (const dep of allDependents.values()) {
          const list = byFile.get(dep.filePath) || [];
          list.push(dep.qualifiedName);
          byFile.set(dep.filePath, list);
        }

        console.log(`\nImpact analysis: ${file}`);
        console.log(`Symbols in file: ${fileSymbols.length}`);
        console.log(`Affected files: ${byFile.size}\n`);

        for (const [filePath, symbols] of byFile) {
          console.log(`  ${filePath}`);
          for (const sym of symbols) {
            console.log(`    → ${sym}`);
          }
        }
      } finally {
        await pool.end();
      }
    });
}
```

- [ ] **Step 3: Create the trace command**

Create `src/cli/trace.ts`:

```typescript
import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createPool } from '../db/connection.js';
import { ReferenceRepository } from '../db/repositories/reference-repository.js';

export function createTraceCommand(): Command {
  return new Command('trace')
    .description('Trace execution flow forward from a symbol')
    .argument('<symbol>', 'Fully qualified symbol name to trace from')
    .option('--depth <n>', 'Maximum trace depth (default: 5)', '5')
    .option('--repo-path <path>', 'Repository path (for config loading)', '.')
    .action(async (symbol: string, opts: { depth: string; repoPath: string }) => {
      const config = loadConfig(opts.repoPath);
      const pool = createPool(config.database);

      try {
        const { rows: symbolRows } = await pool.query(
          'SELECT id, qualified_name, kind FROM symbols WHERE qualified_name = $1',
          [symbol]
        );

        if (symbolRows.length === 0) {
          console.error(`Symbol not found: ${symbol}`);
          process.exit(1);
        }

        const refRepo = new ReferenceRepository(pool);
        const maxDepth = parseInt(opts.depth, 10);

        console.log(`\nTrace: ${symbol}\n`);

        // Iterative BFS trace
        const visited = new Set<number>();
        const queue: { symbolId: number; qualifiedName: string; depth: number }[] = [
          { symbolId: symbolRows[0].id, qualifiedName: symbol, depth: 0 },
        ];

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (visited.has(current.symbolId)) continue;
          if (current.depth > maxDepth) continue;
          visited.add(current.symbolId);

          const indent = '  '.repeat(current.depth);
          const arrow = current.depth > 0 ? '→ ' : '';
          console.log(`${indent}${current.depth + 1}. ${arrow}${current.qualifiedName}`);

          // Get forward dependencies (what this symbol calls)
          const deps = await refRepo.findDependencies(current.symbolId);
          const callDeps = deps.filter(d =>
            ['static_call', 'self_call', 'instantiation'].includes(d.referenceKind)
          );

          for (const dep of callDeps) {
            if (dep.targetSymbolId && !visited.has(dep.targetSymbolId)) {
              // Look up the target's qualified name
              const { rows } = await pool.query(
                'SELECT qualified_name FROM symbols WHERE id = $1',
                [dep.targetSymbolId]
              );
              if (rows.length > 0) {
                queue.push({
                  symbolId: dep.targetSymbolId,
                  qualifiedName: rows[0].qualified_name,
                  depth: current.depth + 1,
                });
              }
            }
          }
        }
      } finally {
        await pool.end();
      }
    });
}
```

- [ ] **Step 4: Register commands in main.ts**

Update `src/cli/main.ts`:

```typescript
import { Command } from 'commander';
import { createIndexCommand } from './index.js';
import { createUsesCommand } from './uses.js';
import { createImpactCommand } from './impact.js';
import { createTraceCommand } from './trace.js';

const program = new Command();

program
  .name('cartograph')
  .description('Map your codebase so AI can navigate it')
  .version('0.1.0');

program.addCommand(createIndexCommand());
program.addCommand(createUsesCommand());
program.addCommand(createImpactCommand());
program.addCommand(createTraceCommand());

program.parse();
```

- [ ] **Step 5: Verify build**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Smoke test commands**

First clear and re-index to populate references:
```bash
docker compose exec -T postgres psql -U cartograph -d cartograph \
  -c "DELETE FROM symbol_references; DELETE FROM symbols; DELETE FROM files; DELETE FROM repos;"
./node_modules/.bin/tsx src/cli/main.ts index tests/fixtures/laravel-sample --verbose
```

Then test each command:
```bash
# uses
./node_modules/.bin/tsx src/cli/main.ts uses 'App\Models\User'

# impact
./node_modules/.bin/tsx src/cli/main.ts impact app/Models/User.php

# trace
./node_modules/.bin/tsx src/cli/main.ts trace 'App\Http\Controllers\UserController::show'
```

Expected: Each command produces meaningful output (not empty, no errors)

- [ ] **Step 7: Commit**

```bash
git add src/cli/uses.ts src/cli/impact.ts src/cli/trace.ts src/cli/main.ts
git commit -m "[feat]: CLI commands — uses, impact, and trace for dependency queries"
```

---

### Task 11: Full test suite verification and cleanup

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass (original 40 + new reference extractor + integration tests)

- [ ] **Step 2: Type check**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Smoke test on fixtures**

Run the full pipeline and each query command as in Task 10 Step 6. Verify output is correct.

- [ ] **Step 4: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "[chore]: milestone 2.1 cleanup and final verification"
```
