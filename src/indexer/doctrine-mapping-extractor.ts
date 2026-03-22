import type Parser from 'tree-sitter';
import type { ParsedSymbol } from '../types.js';
import type { NamespaceContext } from './parsers/php.js';
import {
  normalizeSchemaName,
} from '../db/repositories/db-schema-repository.js';
import type {
  ParsedSymbolColumnLink,
  ParsedSymbolTableLink,
} from '../db/repositories/symbol-schema-repository.js';

type SyntaxNode = Parser.SyntaxNode;

export interface DoctrineMappingExtractionResult {
  tableLinks: ParsedSymbolTableLink[];
  columnLinks: ParsedSymbolColumnLink[];
}

interface AttributeDescriptor {
  resolvedName: string;
  leafName: string;
  namedArgs: Map<string, string>;
  positionalArgs: string[];
}

export function extractDoctrineMappings(
  tree: Parser.Tree,
  context: NamespaceContext,
  symbols: ParsedSymbol[]
): DoctrineMappingExtractionResult {
  const root = tree.rootNode;
  const tableLinks: ParsedSymbolTableLink[] = [];
  const columnLinks: ParsedSymbolColumnLink[] = [];

  const classSymbols = symbols.filter((symbol) => symbol.kind === 'class');
  for (const classSymbol of classSymbols) {
    const classNode = findClassNodeAtLine(root, classSymbol.lineStart);
    if (!classNode) continue;

    const explicitTableName =
      extractTableNameFromAttributes(classNode, context)
      ?? extractTableNameFromDocblock(classSymbol.docblock);

    if (!explicitTableName) {
      continue;
    }

    const normalizedTableName = normalizeSchemaName(explicitTableName);
    tableLinks.push({
      sourceQualifiedName: classSymbol.qualifiedName,
      tableName: explicitTableName,
      normalizedTableName,
      linkKind: 'entity_table',
    });

    const body = findChild(classNode, 'declaration_list');
    if (!body) continue;

    for (let i = 0; i < body.childCount; i++) {
      const member = body.child(i)!;
      if (member.type === 'property_declaration') {
        const propertySymbols = classSymbol.children.filter(
          (child) =>
            child.kind === 'property'
            && child.lineStart === member.startPosition.row + 1
        );
        if (propertySymbols.length === 0) continue;

        const mapping =
          extractPropertyMappingFromAttributes(member, context)
          ?? extractPropertyMappingFromDocblock(propertySymbols[0]?.docblock ?? null);
        if (!mapping) continue;

        pushColumnLinks(columnLinks, propertySymbols, explicitTableName, normalizedTableName, mapping);
        continue;
      }

      if (member.type === 'method_declaration' && findChild(member, 'name')?.text === '__construct') {
        const promotedMappings = extractPromotedPropertyMappings(member, classSymbol, context);
        for (const promoted of promotedMappings) {
          pushColumnLinks(
            columnLinks,
            [promoted.propertySymbol],
            explicitTableName,
            normalizedTableName,
            promoted.mapping
          );
        }
      }
    }
  }

  return { tableLinks, columnLinks };
}

function pushColumnLinks(
  columnLinks: ParsedSymbolColumnLink[],
  propertySymbols: ParsedSymbol[],
  tableName: string,
  normalizedTableName: string,
  mapping: { columnName: string; referencedColumnName?: string; kind: 'entity_column' | 'entity_join_column' }
): void {
  for (const propertySymbol of propertySymbols) {
    columnLinks.push({
      sourceQualifiedName: propertySymbol.qualifiedName,
      tableName,
      normalizedTableName,
      columnName: mapping.columnName,
      normalizedColumnName: normalizeSchemaName(mapping.columnName),
      referencedColumnName: mapping.referencedColumnName ?? null,
      normalizedReferencedColumnName: mapping.referencedColumnName
        ? normalizeSchemaName(mapping.referencedColumnName)
        : null,
      linkKind: mapping.kind,
    });
  }
}

function extractPromotedPropertyMappings(
  constructorNode: SyntaxNode,
  classSymbol: ParsedSymbol,
  context: NamespaceContext
): Array<{
  propertySymbol: ParsedSymbol;
  mapping: { columnName: string; referencedColumnName?: string; kind: 'entity_column' | 'entity_join_column' };
}> {
  const paramsNode = findChild(constructorNode, 'formal_parameters');
  if (!paramsNode) return [];

  const mappings: Array<{
    propertySymbol: ParsedSymbol;
    mapping: { columnName: string; referencedColumnName?: string; kind: 'entity_column' | 'entity_join_column' };
  }> = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const param = paramsNode.child(i)!;
    if (param.type !== 'property_promotion_parameter') continue;

    const propertyName = extractPromotedPropertyName(param);
    if (!propertyName) continue;

    const propertySymbol = classSymbol.children.find(
      (child) =>
        child.kind === 'property'
        && child.name === propertyName
        && child.metadata?.promoted === true
    );
    if (!propertySymbol) continue;

    const mapping = extractPropertyMappingFromAttributes(param, context);
    if (!mapping) continue;

    mappings.push({ propertySymbol, mapping });
  }

  return mappings;
}

function extractPromotedPropertyName(param: SyntaxNode): string | null {
  const varNode = findChild(param, 'variable_name');
  if (!varNode) return null;

  const nameNode = findChild(varNode, 'name');
  return nameNode?.text ?? varNode.text.replace('$', '') ?? null;
}

function extractTableNameFromAttributes(
  classNode: SyntaxNode,
  context: NamespaceContext
): string | null {
  const attributes = getAttributes(classNode, context);
  for (const attribute of attributes) {
    if (!isDoctrineLikeAttribute(attribute, 'table')) continue;
    return attribute.namedArgs.get('name') ?? attribute.positionalArgs[0] ?? null;
  }
  return null;
}

function extractPropertyMappingFromAttributes(
  propertyNode: SyntaxNode,
  context: NamespaceContext
): { columnName: string; referencedColumnName?: string; kind: 'entity_column' | 'entity_join_column' } | null {
  const attributes = getAttributes(propertyNode, context);
  for (const attribute of attributes) {
    if (isDoctrineLikeAttribute(attribute, 'column')) {
      const columnName = attribute.namedArgs.get('name') ?? attribute.positionalArgs[0];
      if (!columnName) continue;
      return {
        columnName,
        kind: 'entity_column',
      };
    }

    if (isDoctrineLikeAttribute(attribute, 'joincolumn')) {
      const columnName = attribute.namedArgs.get('name') ?? attribute.positionalArgs[0];
      if (!columnName) continue;
      return {
        columnName,
        referencedColumnName: attribute.namedArgs.get('referencedcolumnname')
          ?? attribute.namedArgs.get('referenced_column_name')
          ?? undefined,
        kind: 'entity_join_column',
      };
    }
  }

  return null;
}

function extractTableNameFromDocblock(docblock: string | null): string | null {
  if (!docblock) return null;
  const args = extractAnnotationArgs(docblock, 'table');
  return args?.get('name') ?? null;
}

function extractPropertyMappingFromDocblock(
  docblock: string | null
): { columnName: string; referencedColumnName?: string; kind: 'entity_column' | 'entity_join_column' } | null {
  if (!docblock) return null;

  const joinColumnArgs = extractAnnotationArgs(docblock, 'joincolumn');
  if (joinColumnArgs?.get('name')) {
    return {
      columnName: joinColumnArgs.get('name')!,
      referencedColumnName: joinColumnArgs.get('referencedcolumnname') ?? undefined,
      kind: 'entity_join_column',
    };
  }

  const columnArgs = extractAnnotationArgs(docblock, 'column');
  if (columnArgs?.get('name')) {
    return {
      columnName: columnArgs.get('name')!,
      kind: 'entity_column',
    };
  }

  return null;
}

function getAttributes(node: SyntaxNode, context: NamespaceContext): AttributeDescriptor[] {
  const attributeList = findChild(node, 'attribute_list');
  if (!attributeList) return [];

  const descriptors: AttributeDescriptor[] = [];
  for (let i = 0; i < attributeList.childCount; i++) {
    const group = attributeList.child(i)!;
    if (group.type !== 'attribute_group') continue;

    for (let j = 0; j < group.childCount; j++) {
      const attributeNode = group.child(j)!;
      if (attributeNode.type !== 'attribute') continue;

      const nameNode = findChild(attributeNode, 'qualified_name') ?? findChild(attributeNode, 'name');
      if (!nameNode) continue;

      const rawName = nameNode.type === 'qualified_name'
        ? extractQualifiedNameText(nameNode)
        : nameNode.text;
      const resolvedName = resolveTypeName(rawName, context);
      const leafName = resolvedName.split('\\').pop()?.toLowerCase() ?? resolvedName.toLowerCase();
      const namedArgs = new Map<string, string>();
      const positionalArgs: string[] = [];
      const argsNode = findChild(attributeNode, 'arguments');
      if (argsNode) {
        for (let k = 0; k < argsNode.childCount; k++) {
          const argNode = argsNode.child(k)!;
          if (argNode.type !== 'argument') continue;

          const namedArgNode = findChild(argNode, 'name');
          const value = extractArgumentValue(argNode);
          if (!value) continue;

          if (namedArgNode) {
            namedArgs.set(namedArgNode.text.toLowerCase(), value);
          } else {
            positionalArgs.push(value);
          }
        }
      }

      descriptors.push({
        resolvedName,
        leafName,
        namedArgs,
        positionalArgs,
      });
    }
  }

  return descriptors;
}

function isDoctrineLikeAttribute(attribute: AttributeDescriptor, targetLeaf: string): boolean {
  if (attribute.leafName !== targetLeaf.toLowerCase()) return false;
  const resolved = attribute.resolvedName.toLowerCase();
  return resolved === targetLeaf.toLowerCase()
    || resolved.includes('\\orm\\')
    || resolved.includes('\\mapping\\')
    || resolved.endsWith(`\\${targetLeaf.toLowerCase()}`);
}

function extractAnnotationArgs(docblock: string, annotationLeaf: string): Map<string, string> | null {
  const pattern = new RegExp(`@(?:[A-Za-z0-9_\\\\]+\\\\)?${annotationLeaf}\\s*\\(([^)]*)\\)`, 'i');
  const match = docblock.match(pattern);
  if (!match) return null;

  const args = new Map<string, string>();
  const body = match[1] ?? '';
  const argPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']([^"']+)["']/g;
  let argMatch;
  while ((argMatch = argPattern.exec(body)) !== null) {
    args.set(argMatch[1]!.toLowerCase(), argMatch[2]!);
  }

  return args;
}

function extractArgumentValue(argNode: SyntaxNode): string | null {
  const stringNode = findDescendant(argNode, 'string');
  if (stringNode) {
    const content = findDescendant(stringNode, 'string_content');
    return content?.text ?? stringNode.text.replace(/^['"]|['"]$/g, '');
  }

  const nameNode = findChild(argNode, 'name');
  if (nameNode && argNode.childCount === 1) {
    return nameNode.text;
  }

  const fallback = argNode.text.split(':').pop()?.trim() ?? null;
  if (!fallback) return null;
  return fallback.replace(/^['"]|['"]$/g, '');
}

function findClassNodeAtLine(root: SyntaxNode, line: number): SyntaxNode | null {
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === 'class_declaration' && child.startPosition.row + 1 === line) {
      return child;
    }
  }
  return null;
}

function resolveTypeName(name: string, context: NamespaceContext): string {
  if (name.startsWith('\\')) return name.substring(1);

  const firstPart = name.split('\\')[0]!;
  if (context.imports.has(firstPart)) {
    const resolved = context.imports.get(firstPart)!;
    const rest = name.substring(firstPart.length);
    return resolved + rest;
  }

  if (context.namespace) {
    return `${context.namespace}\\${name}`;
  }

  return name;
}

function findChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === type) return child;
  }
  return null;
}

function findDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.childCount; i++) {
    const found = findDescendant(node.child(i)!, type);
    if (found) return found;
  }
  return null;
}

function extractQualifiedNameText(qualifiedNameNode: SyntaxNode): string {
  const parts: string[] = [];
  for (let i = 0; i < qualifiedNameNode.childCount; i++) {
    const child = qualifiedNameNode.child(i)!;
    if (child.type === 'namespace_name') {
      parts.push(extractNamespaceText(child));
    } else if (child.type === 'name') {
      parts.push(child.text);
    }
  }
  return parts.join('\\');
}

function extractNamespaceText(namespaceNode: SyntaxNode): string {
  const parts: string[] = [];
  for (let i = 0; i < namespaceNode.childCount; i++) {
    const child = namespaceNode.child(i)!;
    if (child.type === 'name') {
      parts.push(child.text);
    }
  }
  return parts.join('\\');
}
