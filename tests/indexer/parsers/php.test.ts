import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
import { parsePHP } from '../../../src/indexer/parsers/php.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'laravel-sample');

describe('PHP Parser', () => {
  let parser: Parser;

  beforeAll(() => {
    parser = new Parser();
    parser.setLanguage(PHP.php);
  });

  describe('class extraction', () => {
    it('extracts class with correct qualified name', () => {
      const source = readFileSync(join(FIXTURES, 'app/Models/User.php'), 'utf-8');
      const result = parsePHP(parser.parse(source));

      expect(result.namespace).toBe('App\\Models');
      const classes = result.symbols.filter((s) => s.kind === 'class');
      expect(classes).toHaveLength(1);

      const user = classes[0];
      expect(user.name).toBe('User');
      expect(user.qualifiedName).toBe('App\\Models\\User');
    });

    it('extracts extends and implements from class', () => {
      const source = readFileSync(join(FIXTURES, 'app/Models/User.php'), 'utf-8');
      const result = parsePHP(parser.parse(source));
      const user = result.symbols[0];

      expect(user.metadata.extends).toBe(
        'Illuminate\\Database\\Eloquent\\Model'
      );
      expect(user.metadata.implements).toContain(
        'Illuminate\\Contracts\\Auth\\Authenticatable'
      );
    });

    it('extracts line range for class', () => {
      const source = readFileSync(join(FIXTURES, 'app/Models/User.php'), 'utf-8');
      const result = parsePHP(parser.parse(source));
      const user = result.symbols[0];

      expect(user.lineStart).toBeGreaterThan(0);
      expect(user.lineEnd).toBeGreaterThan(user.lineStart);
    });

    it('detects trait usage in class metadata', () => {
      const source = readFileSync(join(FIXTURES, 'app/Models/User.php'), 'utf-8');
      const result = parsePHP(parser.parse(source));
      const user = result.symbols[0];

      expect(user.metadata.traits).toBeDefined();
      expect(user.metadata.traits).toContain('App\\Traits\\HasTimestamps');
    });
  });

  describe('interface extraction', () => {
    it('extracts interface with methods', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Contracts/UserServiceInterface.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));

      expect(result.symbols).toHaveLength(1);
      const iface = result.symbols[0];
      expect(iface.kind).toBe('interface');
      expect(iface.name).toBe('UserServiceInterface');
      expect(iface.qualifiedName).toBe('App\\Contracts\\UserServiceInterface');

      const methods = iface.children.filter((c) => c.kind === 'method');
      expect(methods.length).toBeGreaterThanOrEqual(3);
      expect(methods.map((m) => m.name)).toContain('findById');
    });
  });

  describe('trait extraction', () => {
    it('extracts trait with methods and properties', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Traits/HasTimestamps.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));

      expect(result.symbols).toHaveLength(1);
      const trait = result.symbols[0];
      expect(trait.kind).toBe('trait');
      expect(trait.name).toBe('HasTimestamps');
      expect(trait.qualifiedName).toBe('App\\Traits\\HasTimestamps');

      const methods = trait.children.filter((c) => c.kind === 'method');
      expect(methods.map((m) => m.name)).toContain('getCreatedAt');
      expect(methods.map((m) => m.name)).toContain('touchTimestamps');

      const props = trait.children.filter((c) => c.kind === 'property');
      expect(props.map((p) => p.name)).toContain('createdAtColumn');
    });
  });

  describe('method extraction', () => {
    it('extracts methods as children of class', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Services/UserService.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));
      const service = result.symbols[0];

      const methods = service.children.filter((c) => c.kind === 'method');
      const methodNames = methods.map((m) => m.name);
      expect(methodNames).toContain('__construct');
      expect(methodNames).toContain('findById');
      expect(methodNames).toContain('create');
      expect(methodNames).toContain('update');
    });

    it('extracts method qualified names', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Services/UserService.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));
      const service = result.symbols[0];

      const findById = service.children.find((c) => c.name === 'findById');
      expect(findById?.qualifiedName).toBe(
        'App\\Services\\UserService::findById'
      );
    });

    it('extracts method visibility', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Services/UserService.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));
      const service = result.symbols[0];

      const findById = service.children.find((c) => c.name === 'findById');
      expect(findById?.visibility).toBe('public');
    });

    it('extracts return types', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Services/UserService.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));
      const service = result.symbols[0];

      const findById = service.children.find((c) => c.name === 'findById');
      expect(findById?.returnType).toBeTruthy();

      const create = service.children.find((c) => c.name === 'create');
      expect(create?.returnType).toBeTruthy();
    });

    it('flags magic methods in metadata', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Services/UserService.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));
      const service = result.symbols[0];

      const constructor = service.children.find(
        (c) => c.name === '__construct'
      );
      expect(constructor?.metadata.magic).toBe(true);
    });

    it('extracts method signature', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Services/UserService.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));
      const service = result.symbols[0];

      const findById = service.children.find((c) => c.name === 'findById');
      expect(findById?.signature).toContain('findById');
      expect(findById?.signature).toContain('int');
    });
  });

  describe('property extraction', () => {
    it('extracts properties with visibility and type', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Services/UserService.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));
      const service = result.symbols[0];

      const props = service.children.filter((c) => c.kind === 'property');
      const userRepo = props.find((p) => p.name === 'userRepo');
      expect(userRepo).toBeDefined();
      expect(userRepo?.visibility).toBe('private');
      expect(userRepo?.qualifiedName).toBe(
        'App\\Services\\UserService::$userRepo'
      );
    });

    it('extracts constructor promoted properties', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Http/Controllers/UserController.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));
      const controller = result.symbols[0];

      const props = controller.children.filter((c) => c.kind === 'property');
      const userService = props.find((p) => p.name === 'userService');
      expect(userService).toBeDefined();
      expect(userService?.visibility).toBe('private');
      expect(userService?.metadata.readonly).toBe(true);
      expect(userService?.metadata.promoted).toBe(true);
    });
  });

  describe('constant extraction', () => {
    it('extracts class constants', () => {
      const source = readFileSync(join(FIXTURES, 'app/Models/User.php'), 'utf-8');
      const result = parsePHP(parser.parse(source));
      const user = result.symbols[0];

      const constants = user.children.filter((c) => c.kind === 'constant');
      expect(constants.length).toBeGreaterThanOrEqual(2);
      expect(constants.map((c) => c.name)).toContain('STATUS_ACTIVE');
      expect(constants.map((c) => c.name)).toContain('STATUS_INACTIVE');
    });
  });

  describe('namespace resolution', () => {
    it('tracks use statement imports', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Services/UserService.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));

      expect(result.imports.get('User')).toBe('App\\Models\\User');
      expect(result.imports.get('UserRepository')).toBe(
        'App\\Repositories\\UserRepository'
      );
    });

    it('resolves aliased imports', () => {
      const source = `<?php
namespace App\\Tests;

use App\\Models\\User as UserModel;

class UserTest {}
`;
      const result = parsePHP(parser.parse(source));
      expect(result.imports.get('UserModel')).toBe('App\\Models\\User');
    });

    it('tracks single-segment global imports', () => {
      const source = `<?php
namespace Simpro\\Core\\Controller\\ContractorJob;

use F;
use Console;
use DateTime;

class Example {}
`;
      const result = parsePHP(parser.parse(source));

      expect(result.imports.get('F')).toBe('F');
      expect(result.imports.get('Console')).toBe('Console');
      expect(result.imports.get('DateTime')).toBe('DateTime');
    });

    it('resolves type names in extends/implements via imports', () => {
      const source = readFileSync(join(FIXTURES, 'app/Models/User.php'), 'utf-8');
      const result = parsePHP(parser.parse(source));
      const user = result.symbols[0];

      expect(user.metadata.extends).toBe(
        'Illuminate\\Database\\Eloquent\\Model'
      );
    });
  });

  describe('docblock extraction', () => {
    it('extracts docblock from class', () => {
      const source = readFileSync(join(FIXTURES, 'app/Models/User.php'), 'utf-8');
      const result = parsePHP(parser.parse(source));
      const user = result.symbols[0];

      expect(user.docblock).toContain('User model');
    });

    it('extracts docblock from method', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Services/UserService.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));
      const service = result.symbols[0];

      const findById = service.children.find((c) => c.name === 'findById');
      expect(findById?.docblock).toContain('Find a user');
    });

    it('extracts docblock from interface', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Contracts/UserServiceInterface.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));
      const iface = result.symbols[0];

      expect(iface.docblock).toContain('Contract for user service');
    });
  });

  describe('context access extraction ($this->args / $this->params)', () => {
    it('extracts $this->args keys from method body', () => {
      const source = `<?php
namespace App\\Builders;

class JobNotesBuilder {
    protected function getReferenceID()
    {
        return (int) $this->args['jobID'];
    }

    protected function getSecondaryID()
    {
        $primary = $this->args['jobID'];
        $secondary = $this->args['sectionID'];
        return [$primary, $secondary];
    }
}
`;
      const result = parsePHP(parser.parse(source));
      const cls = result.symbols[0];
      const getRef = cls.children.find(c => c.name === 'getReferenceID');
      const getSec = cls.children.find(c => c.name === 'getSecondaryID');

      expect(getRef?.metadata.contextArgs).toEqual(['jobID']);
      expect(getSec?.metadata.contextArgs).toEqual(expect.arrayContaining(['jobID', 'sectionID']));
      expect(getSec?.metadata.contextArgs).toHaveLength(2);
    });

    it('extracts $this->params keys from method body', () => {
      const source = `<?php
namespace App\\Builders;

class SearchBuilder {
    protected function getFilters()
    {
        $page = $this->params['page'];
        $limit = $this->params['limit'];
        return [$page, $limit];
    }
}
`;
      const result = parsePHP(parser.parse(source));
      const cls = result.symbols[0];
      const getFilters = cls.children.find(c => c.name === 'getFilters');

      expect(getFilters?.metadata.contextParams).toEqual(expect.arrayContaining(['page', 'limit']));
      expect(getFilters?.metadata.contextParams).toHaveLength(2);
    });

    it('extracts both args and params from same method', () => {
      const source = `<?php
namespace App\\Builders;

class MixedBuilder {
    protected function getData()
    {
        $id = $this->args['jobID'];
        $filter = $this->params['status'];
        return [$id, $filter];
    }
}
`;
      const result = parsePHP(parser.parse(source));
      const cls = result.symbols[0];
      const getData = cls.children.find(c => c.name === 'getData');

      expect(getData?.metadata.contextArgs).toEqual(['jobID']);
      expect(getData?.metadata.contextParams).toEqual(['status']);
    });

    it('does not set metadata when no context access exists', () => {
      const source = `<?php
namespace App\\Builders;

class SimpleBuilder {
    protected function getName(): string
    {
        return 'simple';
    }
}
`;
      const result = parsePHP(parser.parse(source));
      const cls = result.symbols[0];
      const getName = cls.children.find(c => c.name === 'getName');

      expect(getName?.metadata.contextArgs).toBeUndefined();
      expect(getName?.metadata.contextParams).toBeUndefined();
    });

    it('deduplicates repeated access to same key', () => {
      const source = `<?php
namespace App\\Builders;

class RepeatBuilder {
    protected function process()
    {
        $a = $this->args['jobID'];
        $b = $this->args['jobID'];
        return $a + $b;
    }
}
`;
      const result = parsePHP(parser.parse(source));
      const cls = result.symbols[0];
      const process = cls.children.find(c => c.name === 'process');

      expect(process?.metadata.contextArgs).toEqual(['jobID']);
    });

    it('handles double-quoted string keys', () => {
      const source = `<?php
namespace App\\Builders;

class DoubleQuoteBuilder {
    protected function getID()
    {
        return $this->args["recurringJobID"];
    }
}
`;
      const result = parsePHP(parser.parse(source));
      const cls = result.symbols[0];
      const getID = cls.children.find(c => c.name === 'getID');

      expect(getID?.metadata.contextArgs).toEqual(['recurringJobID']);
    });
  });

  describe('exception metadata extraction', () => {
    it('extracts thrown exceptions from method bodies', () => {
      const source = readFileSync(
        join(FIXTURES, 'app/Services/UserService.php'),
        'utf-8'
      );
      const result = parsePHP(parser.parse(source));
      const service = result.symbols[0];
      const update = service.children.find((c) => c.name === 'update');

      expect(update?.metadata.thrownExceptions).toEqual(['RuntimeException']);
    });

    it('extracts caught and documented exceptions', () => {
      const source = `<?php
namespace App\\Builders;

use RuntimeException;
use Throwable;

class ImportBuilder {
    /**
     * @throws \\DomainException
     */
    protected function import(): void
    {
        try {
            throw new RuntimeException('boom');
        } catch (Throwable | RuntimeException $e) {
            throw new \\LogicException('wrapped');
        }
    }
}
`;
      const result = parsePHP(parser.parse(source));
      const cls = result.symbols[0];
      const method = cls.children.find((c) => c.name === 'import');

      expect(method?.metadata.thrownExceptions).toEqual([
        'LogicException',
        'RuntimeException',
      ]);
      expect(method?.metadata.caughtExceptions).toEqual([
        'RuntimeException',
        'Throwable',
      ]);
      expect(method?.metadata.documentedThrows).toEqual(['DomainException']);
    });
  });

  describe('standalone functions', () => {
    it('extracts top-level function definitions', () => {
      const source = `<?php
namespace App\\Helpers;

function format_name(string $first, string $last): string
{
    return trim("$first $last");
}

function calculate_age(int $birthYear): int
{
    return date('Y') - $birthYear;
}
`;
      const result = parsePHP(parser.parse(source));

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0].kind).toBe('function');
      expect(result.symbols[0].name).toBe('format_name');
      expect(result.symbols[0].qualifiedName).toBe(
        'App\\Helpers\\format_name'
      );
      expect(result.symbols[1].name).toBe('calculate_age');
    });
  });
});
