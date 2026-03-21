export type SymbolKind =
  | 'class'
  | 'interface'
  | 'trait'
  | 'method'
  | 'function'
  | 'property'
  | 'constant'
  | 'enum';

export type Visibility = 'public' | 'protected' | 'private';

export interface DiscoveredFile {
  relativePath: string;
  absolutePath: string;
  language: string;
  hash: string;
  sourceLabel: string;
}

export interface ParsedSymbol {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  visibility: Visibility | null;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  returnType: string | null;
  docblock: string | null;
  children: ParsedSymbol[];
  metadata: Record<string, unknown>;
}

export interface ParseResult {
  symbols: ParsedSymbol[];
  namespace: string | null;
  imports: Map<string, string>;
}

export type ReferenceKind =
  | 'inheritance'
  | 'implementation'
  | 'trait_use'
  | 'instantiation'
  | 'static_call'
  | 'type_hint'
  | 'self_call'
  | 'static_access'
  | 'class_reference';

export interface ParsedReference {
  sourceQualifiedName: string;
  targetQualifiedName: string;
  kind: ReferenceKind;
  line: number;
}

export interface ParsedDbTable {
  name: string;
  normalizedName: string;
  lineStart: number;
  lineEnd: number;
  columns: ParsedDbColumn[];
  foreignKeys: ParsedDbForeignKey[];
}

export interface ParsedDbColumn {
  name: string;
  normalizedName: string;
  dataType: string | null;
  isNullable: boolean;
  defaultValue: string | null;
  ordinalPosition: number;
  lineNumber: number | null;
}

export interface ParsedDbForeignKey {
  constraintName: string | null;
  sourceColumns: string[];
  targetTable: string;
  normalizedTargetTable: string;
  targetColumns: string[];
  lineNumber: number | null;
}

export interface CartographConfig {
  languages: string[];
  exclude: string[];
  additionalSources: AdditionalSourceConfig[];
  database: DatabaseConfig;
}

export interface AdditionalSourceConfig {
  path: string;
  label: string;
}

export interface DatabaseConfig {
  path: string;
}
