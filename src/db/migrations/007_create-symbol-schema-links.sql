CREATE TABLE IF NOT EXISTS symbol_table_links (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    source_symbol_id      INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    table_name            TEXT NOT NULL,
    normalized_table_name TEXT NOT NULL,
    link_kind             TEXT NOT NULL,
    UNIQUE(source_symbol_id, normalized_table_name, link_kind)
);

CREATE INDEX IF NOT EXISTS idx_symbol_table_links_symbol_id ON symbol_table_links(source_symbol_id);
CREATE INDEX IF NOT EXISTS idx_symbol_table_links_table_name ON symbol_table_links(normalized_table_name);

CREATE TABLE IF NOT EXISTS symbol_column_links (
    id                                INTEGER PRIMARY KEY AUTOINCREMENT,
    source_symbol_id                  INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    table_name                        TEXT NOT NULL,
    normalized_table_name             TEXT NOT NULL,
    column_name                       TEXT NOT NULL,
    normalized_column_name            TEXT NOT NULL,
    referenced_column_name            TEXT,
    normalized_referenced_column_name TEXT,
    link_kind                         TEXT NOT NULL,
    UNIQUE(source_symbol_id, normalized_table_name, normalized_column_name, link_kind)
);

CREATE INDEX IF NOT EXISTS idx_symbol_column_links_symbol_id ON symbol_column_links(source_symbol_id);
CREATE INDEX IF NOT EXISTS idx_symbol_column_links_table_name ON symbol_column_links(normalized_table_name);
