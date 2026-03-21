import { describe, expect, it } from 'vitest';
import { extractSqlSchemaFromSource } from '../../src/indexer/sql-schema-extractor.js';

describe('SQL schema extractor', () => {
  it('extracts tables, columns, and foreign keys from create table statements', () => {
    const tables = extractSqlSchemaFromSource(`
CREATE TABLE users (
  id INTEGER NOT NULL,
  account_id INTEGER REFERENCES accounts(id),
  email VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);
`);

    expect(tables).toHaveLength(2);
    expect(tables[0]).toEqual(
      expect.objectContaining({
        name: 'users',
        normalizedName: 'users',
      })
    );
    expect(tables[0]?.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'account_id',
          dataType: 'INTEGER',
          isNullable: true,
        }),
        expect.objectContaining({
          name: 'email',
          dataType: 'VARCHAR(255)',
          isNullable: false,
        }),
      ])
    );
    expect(tables[0]?.foreignKeys).toEqual([
      expect.objectContaining({
        sourceColumns: ['account_id'],
        targetTable: 'accounts',
        targetColumns: ['id'],
      }),
    ]);

    expect(tables[1]?.foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          constraintName: 'fk_order_items_order',
          sourceColumns: ['order_id'],
          targetTable: 'orders',
          targetColumns: ['id'],
        }),
        expect.objectContaining({
          sourceColumns: ['product_id'],
          targetTable: 'products',
          targetColumns: ['id'],
        }),
      ])
    );
  });

  it('ignores sql comments while preserving line numbers', () => {
    const tables = extractSqlSchemaFromSource(`
-- users table
CREATE TABLE public.users (
  id INTEGER NOT NULL,
  /* inline note */
  role_id INTEGER REFERENCES roles(id)
);
`);

    expect(tables).toHaveLength(1);
    expect(tables[0]?.name).toBe('public.users');
    expect(tables[0]?.lineStart).toBe(3);
    expect(tables[0]?.foreignKeys[0]?.lineNumber).toBe(6);
  });
});
