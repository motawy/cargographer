import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
import { parsePHP } from '../../src/indexer/parsers/php.js';
import { extractDoctrineMappings } from '../../src/indexer/doctrine-mapping-extractor.js';

function parseSource(source: string) {
  const parser = new Parser();
  parser.setLanguage(PHP.php);
  const tree = parser.parse(source);
  const result = parsePHP(tree);
  return {
    tree,
    context: { namespace: result.namespace, imports: result.imports },
    symbols: result.symbols,
  };
}

describe('extractDoctrineMappings', () => {
  it('extracts entity table and property mappings from attributes', () => {
    const { tree, context, symbols } = parseSource(`<?php
namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\Table(name: 'quotes')]
class Quote
{
    #[ORM\\Column(name: 'quote_id')]
    private int $id;

    #[ORM\\JoinColumn(name: 'customer_id', referencedColumnName: 'id')]
    private Customer $customer;
}
`);

    const result = extractDoctrineMappings(tree, context, symbols);

    expect(result.tableLinks).toEqual([
      {
        sourceQualifiedName: 'App\\Entity\\Quote',
        tableName: 'quotes',
        normalizedTableName: 'quotes',
        linkKind: 'entity_table',
      },
    ]);
    expect(result.columnLinks).toEqual([
      {
        sourceQualifiedName: 'App\\Entity\\Quote::$id',
        tableName: 'quotes',
        normalizedTableName: 'quotes',
        columnName: 'quote_id',
        normalizedColumnName: 'quote_id',
        referencedColumnName: null,
        normalizedReferencedColumnName: null,
        linkKind: 'entity_column',
      },
      {
        sourceQualifiedName: 'App\\Entity\\Quote::$customer',
        tableName: 'quotes',
        normalizedTableName: 'quotes',
        columnName: 'customer_id',
        normalizedColumnName: 'customer_id',
        referencedColumnName: 'id',
        normalizedReferencedColumnName: 'id',
        linkKind: 'entity_join_column',
      },
    ]);
  });

  it('falls back to doctrine docblocks', () => {
    const { tree, context, symbols } = parseSource(`<?php
namespace App\\Entity;

/**
 * @ORM\\Table(name="recurring_quotes")
 */
class RecurringQuote
{
    /**
     * @ORM\\Column(name="quote_id")
     */
    private int $id;
}
`);

    const result = extractDoctrineMappings(tree, context, symbols);

    expect(result.tableLinks[0]?.tableName).toBe('recurring_quotes');
    expect(result.columnLinks[0]?.columnName).toBe('quote_id');
  });
});
