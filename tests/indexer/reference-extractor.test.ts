import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
// @ts-expect-error - tree-sitter-php types
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

    it('skips self:: and static:: calls', () => {
      const refs = parseAndExtract(`<?php
        namespace App;
        class Foo {
            public function bar(): void {
                self::baz();
                static::qux();
            }
            public static function baz(): void {}
            public static function qux(): void {}
        }
      `);

      const statics = refs.filter(r => r.kind === 'static_call');
      expect(statics).toHaveLength(0);
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
});
