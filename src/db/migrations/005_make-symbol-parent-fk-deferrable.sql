ALTER TABLE symbols
  DROP CONSTRAINT IF EXISTS symbols_parent_symbol_id_fkey;

ALTER TABLE symbols
  ADD CONSTRAINT symbols_parent_symbol_id_fkey
  FOREIGN KEY (parent_symbol_id) REFERENCES symbols(id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;
