import Parser from 'tree-sitter';
// @ts-expect-error - tree-sitter-php types may not match exactly
import PHP from 'tree-sitter-php';

const parser = new Parser();

// Discover the correct grammar export
const language = (PHP as Record<string, unknown>).php || PHP;
console.log('PHP grammar keys:', Object.keys(PHP));
console.log('Using language:', typeof language);

parser.setLanguage(language as Parser.Language);

const source = `<?php

namespace App\\Services;

use App\\Models\\User;
use App\\Repositories\\UserRepository;
use App\\Contracts\\{UserInterface, Loggable};

/**
 * Service for user operations.
 */
class UserService extends BaseService implements UserInterface
{
    use SomeTrait;

    const MAX_RESULTS = 100;

    private UserRepository $userRepo;
    protected static int $instanceCount = 0;

    public function __construct(
        private readonly UserRepository $repo
    ) {
        $this->userRepo = $repo;
    }

    public function findById(int $id): ?User
    {
        return $this->userRepo->find($id);
    }

    public static function getInstanceCount(): int
    {
        return static::$instanceCount;
    }

    abstract protected function validate(array $data): bool;
}

interface Loggable
{
    public function log(string $message): void;
}

trait Auditable
{
    public function audit(): void {}
}

function standalone_helper(string $input): string
{
    return trim($input);
}
`;

const tree = parser.parse(source);

function printTree(node: Parser.SyntaxNode, indent = 0): void {
  const prefix = '  '.repeat(indent);
  const text = node.childCount === 0 ? ` "${node.text}"` : '';
  const named = node.isNamed ? '' : ' (anonymous)';
  console.log(
    `${prefix}${node.type}${named} [${node.startPosition.row}:${node.startPosition.column}..${node.endPosition.row}:${node.endPosition.column}]${text}`
  );
  for (let i = 0; i < node.childCount; i++) {
    printTree(node.child(i)!, indent + 1);
  }
}

printTree(tree.rootNode);
