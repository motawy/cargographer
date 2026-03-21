import type { SymbolRepository } from '../db/repositories/symbol-repository.js';
import type { ReferenceRepository } from '../db/repositories/reference-repository.js';
import type { DbSchemaRepository } from '../db/repositories/db-schema-repository.js';

export type ToolDeps = {
  repoId: number;
  repoPath?: string;
  symbolRepo: SymbolRepository;
  refRepo: ReferenceRepository;
  schemaRepo?: DbSchemaRepository;
};

/** Repo-wide stats cached once at server startup for conventions context. */
export interface RepoStats {
  totalClasses: number;
  classesWithInterface: number;
  classesWithBaseClass: number;
  classesWithTraits: number;
}

/**
 * Typed shape for rows returned by ReferenceRepository.findDependents().
 * The repo returns Record<string, unknown>[] — cast through this interface
 * in tool handlers to avoid strict-mode index errors.
 */
export interface DependentRow {
  source_symbol_id: number;
  source_qualified_name: string;
  source_file_path: string;
  reference_kind: string;
  line_number: number | null;
  target_symbol_id: number;
  target_qualified_name: string;
  depth?: number;
}
