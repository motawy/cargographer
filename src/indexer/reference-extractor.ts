import type Parser from 'tree-sitter';
import type { ParsedSymbol, ParsedReference, ReferenceKind } from '../types.js';
import type { NamespaceContext } from './parsers/php.js';

type SyntaxNode = Parser.SyntaxNode;

const BUILTIN_TYPES = new Set([
  'int', 'float', 'string', 'bool', 'array', 'object', 'callable',
  'iterable', 'void', 'never', 'null', 'mixed', 'true', 'false',
  'self', 'static', 'parent',
]);

export function extractReferences(
  tree: Parser.Tree,
  context: NamespaceContext,
  symbols: ParsedSymbol[]
): ParsedReference[] {
  const refs: ParsedReference[] = [];
  const root = tree.rootNode;

  const classSymbols = symbols.filter(s =>
    ['class', 'interface', 'trait', 'enum'].includes(s.kind)
  );

  for (const symbol of classSymbols) {
    const node = findClassNodeAtLine(root, symbol.lineStart);
    if (!node) continue;

    refs.push(...extractClassLevelRefs(node, symbol, context));
    refs.push(...extractMemberTypeHints(node, symbol, context));
    refs.push(...extractBodyReferences(node, symbol, context));
  }

  return refs;
}

// --- Class-level references (extends, implements, trait use) ---

function extractClassLevelRefs(
  node: SyntaxNode,
  symbol: ParsedSymbol,
  context: NamespaceContext
): ParsedReference[] {
  const refs: ParsedReference[] = [];

  // extends
  const baseClause = findChild(node, 'base_clause');
  if (baseClause) {
    const name = extractTypeName(baseClause);
    if (name) {
      refs.push({
        sourceQualifiedName: symbol.qualifiedName,
        targetQualifiedName: resolveTypeName(name, context),
        kind: 'inheritance',
        line: baseClause.startPosition.row + 1,
      });
    }
  }

  // implements
  const interfaceClause = findChild(node, 'class_interface_clause');
  if (interfaceClause) {
    for (let i = 0; i < interfaceClause.childCount; i++) {
      const child = interfaceClause.child(i)!;
      const name = extractNameFromNode(child);
      if (name) {
        refs.push({
          sourceQualifiedName: symbol.qualifiedName,
          targetQualifiedName: resolveTypeName(name, context),
          kind: 'implementation',
          line: interfaceClause.startPosition.row + 1,
        });
      }
    }
  }

  // trait use
  const body = findChild(node, 'declaration_list');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const member = body.child(i)!;
      if (member.type === 'use_declaration') {
        for (let j = 0; j < member.childCount; j++) {
          const traitChild = member.child(j)!;
          const name = extractNameFromNode(traitChild);
          if (name) {
            refs.push({
              sourceQualifiedName: symbol.qualifiedName,
              targetQualifiedName: resolveTypeName(name, context),
              kind: 'trait_use',
              line: member.startPosition.row + 1,
            });
          }
        }
      }
    }
  }

  return refs;
}

// --- Type hint extraction ---

function extractMemberTypeHints(
  classNode: SyntaxNode,
  classSymbol: ParsedSymbol,
  context: NamespaceContext
): ParsedReference[] {
  const refs: ParsedReference[] = [];
  const body = findChild(classNode, 'declaration_list');
  if (!body) return refs;

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i)!;

    if (member.type === 'method_declaration') {
      const methodName = findChild(member, 'name')?.text;
      if (!methodName) continue;
      const sourceQN = `${classSymbol.qualifiedName}::${methodName}`;
      refs.push(...extractMethodTypeHints(member, sourceQN, context));
    }

    if (member.type === 'property_declaration') {
      refs.push(...extractPropertyTypeHint(member, classSymbol.qualifiedName, context));
    }
  }

  return refs;
}

function extractMethodTypeHints(
  methodNode: SyntaxNode,
  sourceQualifiedName: string,
  context: NamespaceContext
): ParsedReference[] {
  const refs: ParsedReference[] = [];

  // Parameter types
  const params = findChild(methodNode, 'formal_parameters');
  if (params) {
    for (let i = 0; i < params.childCount; i++) {
      const param = params.child(i)!;
      if (param.type === 'simple_parameter' || param.type === 'property_promotion_parameter') {
        refs.push(...extractTypeRefFromNode(param, sourceQualifiedName, context));
      }
    }
  }

  // Return type (after ':')
  let foundColon = false;
  for (let i = 0; i < methodNode.childCount; i++) {
    const child = methodNode.child(i)!;
    if (child.text === ':') { foundColon = true; continue; }
    if (foundColon && isTypeNode(child)) {
      refs.push(...typeNodeToRefs(child, sourceQualifiedName, context));
      break;
    }
  }

  return refs;
}

function extractPropertyTypeHint(
  propNode: SyntaxNode,
  classQualifiedName: string,
  context: NamespaceContext
): ParsedReference[] {
  return extractTypeRefFromNode(propNode, classQualifiedName, context);
}

function extractTypeRefFromNode(
  node: SyntaxNode,
  sourceQualifiedName: string,
  context: NamespaceContext
): ParsedReference[] {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (isTypeNode(child)) {
      return typeNodeToRefs(child, sourceQualifiedName, context);
    }
  }
  return [];
}

function typeNodeToRefs(
  typeNode: SyntaxNode,
  sourceQualifiedName: string,
  context: NamespaceContext
): ParsedReference[] {
  const refs: ParsedReference[] = [];

  // union/intersection — recurse into children
  if (typeNode.type === 'union_type' || typeNode.type === 'intersection_type') {
    for (let i = 0; i < typeNode.childCount; i++) {
      refs.push(...typeNodeToRefs(typeNode.child(i)!, sourceQualifiedName, context));
    }
    return refs;
  }

  // nullable — unwrap
  if (typeNode.type === 'nullable_type' || typeNode.type === 'optional_type') {
    for (let i = 0; i < typeNode.childCount; i++) {
      refs.push(...typeNodeToRefs(typeNode.child(i)!, sourceQualifiedName, context));
    }
    return refs;
  }

  // named_type → contains name or qualified_name
  if (typeNode.type === 'named_type') {
    for (let i = 0; i < typeNode.childCount; i++) {
      const name = extractNameFromNode(typeNode.child(i)!);
      if (name && !BUILTIN_TYPES.has(name.toLowerCase())) {
        refs.push({
          sourceQualifiedName,
          targetQualifiedName: resolveTypeName(name, context),
          kind: 'type_hint',
          line: typeNode.startPosition.row + 1,
        });
      }
    }
    return refs;
  }

  return refs;
}

// --- Body references (instantiation, static calls, self calls) ---

function extractBodyReferences(
  classNode: SyntaxNode,
  classSymbol: ParsedSymbol,
  context: NamespaceContext
): ParsedReference[] {
  const refs: ParsedReference[] = [];
  const body = findChild(classNode, 'declaration_list');
  if (!body) return refs;

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i)!;
    if (member.type !== 'method_declaration') continue;

    const methodName = findChild(member, 'name')?.text;
    if (!methodName) continue;
    const sourceQN = `${classSymbol.qualifiedName}::${methodName}`;

    const methodBody = findChild(member, 'compound_statement');
    if (methodBody) {
      walkForReferences(methodBody, sourceQN, classSymbol.qualifiedName, context, refs);
    }
  }

  return refs;
}

function walkForReferences(
  node: SyntaxNode,
  sourceQN: string,
  classQN: string,
  context: NamespaceContext,
  refs: ParsedReference[]
): void {
  // new ClassName()
  if (node.type === 'object_creation_expression') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      const name = extractNameFromNode(child);
      if (name && name !== 'new') {
        refs.push({
          sourceQualifiedName: sourceQN,
          targetQualifiedName: resolveTypeName(name, context),
          kind: 'instantiation',
          line: node.startPosition.row + 1,
        });
        break;
      }
    }
  }

  // ClassName::method() — scoped_call_expression
  if (node.type === 'scoped_call_expression') {
    const scopeNode = node.child(0);
    const memberNode = findNameAfterOperator(node, '::');
    if (scopeNode && memberNode) {
      const className = extractNameFromNode(scopeNode);
      if (className && !isSelfReference(className)) {
        refs.push({
          sourceQualifiedName: sourceQN,
          targetQualifiedName: `${resolveTypeName(className, context)}::${memberNode.text.toLowerCase()}`,
          kind: 'static_call',
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  // ClassName::CONST — class_constant_access_expression
  if (node.type === 'class_constant_access_expression') {
    const scopeNode = node.child(0);
    const memberNode = findNameAfterOperator(node, '::');
    if (scopeNode && memberNode) {
      const className = extractNameFromNode(scopeNode);
      if (className && !isSelfReference(className)) {
        refs.push({
          sourceQualifiedName: sourceQN,
          targetQualifiedName: `${resolveTypeName(className, context)}::${memberNode.text.toLowerCase()}`,
          kind: 'static_access',
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  // $this->method() — member_call_expression where object is $this
  if (node.type === 'member_call_expression') {
    const objectNode = node.child(0);
    const memberName = findChild(node, 'name');
    if (objectNode?.type === 'variable_name' && objectNode.text === '$this' && memberName) {
      refs.push({
        sourceQualifiedName: sourceQN,
        targetQualifiedName: `${classQN}::${memberName.text}`.toLowerCase(),
        kind: 'self_call',
        line: node.startPosition.row + 1,
      });
    }
  }

  // Recurse into children (skip nested class declarations)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'class_declaration') continue;
    walkForReferences(child, sourceQN, classQN, context, refs);
  }
}

// --- Helpers ---

function resolveTypeName(name: string, context: NamespaceContext): string {
  if (name.startsWith('\\')) return name.substring(1).toLowerCase();

  const firstPart = name.split('\\')[0];
  if (context.imports.has(firstPart)) {
    const resolved = context.imports.get(firstPart)!;
    const rest = name.substring(firstPart.length);
    return (resolved + rest).toLowerCase();
  }

  if (context.namespace) {
    return `${context.namespace}\\${name}`.toLowerCase();
  }

  return name.toLowerCase();
}

function extractNameFromNode(node: SyntaxNode): string | null {
  if (node.type === 'name') return node.text;
  if (node.type === 'qualified_name') return extractQualifiedNameText(node);
  return null;
}

function extractTypeName(node: SyntaxNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const name = extractNameFromNode(node.child(i)!);
    if (name) return name;
  }
  return null;
}

function extractQualifiedNameText(node: SyntaxNode): string {
  const parts: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'namespace_name') {
      const subParts: string[] = [];
      for (let j = 0; j < child.childCount; j++) {
        if (child.child(j)!.type === 'name') subParts.push(child.child(j)!.text);
      }
      parts.push(subParts.join('\\'));
    } else if (child.type === 'name') {
      parts.push(child.text);
    }
  }
  return parts.join('\\');
}

function findChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)!.type === type) return node.child(i)!;
  }
  return null;
}

function findNameAfterOperator(node: SyntaxNode, operator: string): SyntaxNode | null {
  let foundOp = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.text === operator) {
      foundOp = true;
      continue;
    }
    if (foundOp && child.type === 'name') return child;
  }
  return null;
}

function isSelfReference(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'self' || lower === 'static' || lower === 'parent';
}

function findClassNodeAtLine(root: SyntaxNode, line: number): SyntaxNode | null {
  const classTypes = new Set([
    'class_declaration', 'interface_declaration',
    'trait_declaration', 'enum_declaration',
  ]);

  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (classTypes.has(child.type) && child.startPosition.row + 1 === line) {
      return child;
    }
  }
  return null;
}

const TYPE_NODE_TYPES = new Set([
  'named_type', 'optional_type', 'union_type',
  'intersection_type', 'primitive_type', 'nullable_type',
]);

function isTypeNode(node: SyntaxNode): boolean {
  return TYPE_NODE_TYPES.has(node.type);
}
