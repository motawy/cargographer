CREATE TABLE IF NOT EXISTS db_tables (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    normalized_name  TEXT NOT NULL,
    line_start       INTEGER NOT NULL,
    line_end         INTEGER NOT NULL,
    UNIQUE(file_id, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_db_tables_file_id ON db_tables(file_id);
CREATE INDEX IF NOT EXISTS idx_db_tables_normalized_name ON db_tables(normalized_name);

CREATE TABLE IF NOT EXISTS db_columns (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id          INTEGER NOT NULL REFERENCES db_tables(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    normalized_name   TEXT NOT NULL,
    data_type         TEXT,
    is_nullable       INTEGER NOT NULL DEFAULT 1,
    default_value     TEXT,
    ordinal_position  INTEGER NOT NULL,
    line_number       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_db_columns_table_id ON db_columns(table_id);
CREATE INDEX IF NOT EXISTS idx_db_columns_normalized_name ON db_columns(normalized_name);

CREATE TABLE IF NOT EXISTS db_foreign_keys (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id                INTEGER NOT NULL REFERENCES db_tables(id) ON DELETE CASCADE,
    constraint_name         TEXT,
    source_columns_json     TEXT NOT NULL,
    target_table            TEXT NOT NULL,
    normalized_target_table TEXT NOT NULL,
    target_columns_json     TEXT NOT NULL,
    line_number             INTEGER
);

CREATE INDEX IF NOT EXISTS idx_db_foreign_keys_table_id ON db_foreign_keys(table_id);
CREATE INDEX IF NOT EXISTS idx_db_foreign_keys_target_table ON db_foreign_keys(normalized_target_table);
