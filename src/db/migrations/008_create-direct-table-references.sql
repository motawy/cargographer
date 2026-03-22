CREATE TABLE IF NOT EXISTS direct_table_references (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    source_symbol_id      INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
    table_name            TEXT NOT NULL,
    normalized_table_name TEXT NOT NULL,
    reference_kind        TEXT NOT NULL,
    line_number           INTEGER NOT NULL,
    preview               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_direct_table_references_table_name
    ON direct_table_references(normalized_table_name);
CREATE INDEX IF NOT EXISTS idx_direct_table_references_file_id
    ON direct_table_references(source_file_id);
CREATE INDEX IF NOT EXISTS idx_direct_table_references_symbol_id
    ON direct_table_references(source_symbol_id);
