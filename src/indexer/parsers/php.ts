import type Parser from 'tree-sitter';
import type {
  ParsedSymbol,
  ParseResult,
  SymbolKind,
  Visibility,
} from '../../types.js';

type SyntaxNode = Parser.SyntaxNode;

interface NamespaceContext {
  namespace: string | null;
  imports: Map<string, string>; // short name or alias → fully qualified name
}

export function parsePHP(source: string, parser: Parser): ParseResult {
  const tree = parser.parse(source);
  const root = tree.rootNode;

  const context: NamespaceContext = {
    namespace: null,
    imports: new Map(),
  };

  const symbols: ParsedSymbol[] = [];

  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    switch (child.type) {
      case 'namespace_definition':
        context.namespace = extractNamespaceName(child);
        break;

      case 'namespace_use_declaration':
        extractUseStatements(child, context);
        break;

      case 'class_declaration':
        symbols.push(extractClassLike(child, context, 'class'));
        break;

      case 'interface_declaration':
        symbols.push(extractClassLike(child, context, 'interface'));
        break;

      case 'trait_declaration':
        symbols.push(extractClassLike(child, context, 'trait'));
        break;

      case 'enum_declaration':
        symbols.push(extractClassLike(child, context, 'enum'));
        break;

      case 'function_definition':
        symbols.push(extractFunction(child, context));
        break;
    }
  }

  return {
    symbols,
    namespace: context.namespace,
    imports: context.imports,
  };
}

// --- Namespace handling ---

function extractNamespaceName(node: SyntaxNode): string {
  // namespace_definition → namespace_name → name nodes separated by \
  const nameNode = findChild(node, 'namespace_name');
  if (!nameNode) return '';
  return extractQualifiedText(nameNode);
}

function extractUseStatements(
  node: SyntaxNode,
  context: NamespaceContext
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;

    if (child.type === 'namespace_use_clause') {
      const qualifiedNode = findChild(child, 'qualified_name');
      if (!qualifiedNode) continue;

      const qualifiedName = extractQualifiedNameText(qualifiedNode);

      // Check for alias: `use Foo\Bar as Baz`
      const aliasNode = findChildAfterType(child, 'as', 'name');
      const shortName =
        aliasNode?.text || qualifiedName.split('\\').pop() || qualifiedName;

      context.imports.set(shortName, qualifiedName);
    }

    // Group use: use App\Contracts\{A, B}
    if (child.type === 'namespace_use_group') {
      const prefixNode = findChild(child, 'namespace_name');
      const prefix = prefixNode ? extractQualifiedText(prefixNode) : '';

      for (let j = 0; j < child.childCount; j++) {
        const clause = child.child(j)!;
        if (clause.type !== 'namespace_use_clause') continue;

        const nameNode =
          findChild(clause, 'qualified_name') || findChild(clause, 'name');
        if (!nameNode) continue;

        const name =
          nameNode.type === 'qualified_name'
            ? extractQualifiedNameText(nameNode)
            : nameNode.text;
        const fullName = prefix ? `${prefix}\\${name}` : name;
        const shortName = name.split('\\').pop() || name;
        context.imports.set(shortName, fullName);
      }
    }
  }
}

// --- Class-like extraction (class, interface, trait, enum) ---

function extractClassLike(
  node: SyntaxNode,
  context: NamespaceContext,
  kind: SymbolKind
): ParsedSymbol {
  const nameNode = findChild(node, 'name');
  const name = nameNode?.text || '';
  const qualifiedName = qualifyName(name, context);
  const docblock = extractDocblock(node);

  const metadata: Record<string, unknown> = {};

  // extends
  const baseClause = findChild(node, 'base_clause');
  if (baseClause) {
    const extendsName = findChild(baseClause, 'name');
    const extendsQualified = findChild(baseClause, 'qualified_name');
    if (extendsQualified) {
      metadata.extends = resolveTypeName(
        extractQualifiedNameText(extendsQualified),
        context
      );
    } else if (extendsName) {
      metadata.extends = resolveTypeName(extendsName.text, context);
    }
  }

  // implements
  const interfaceClause = findChild(node, 'class_interface_clause');
  if (interfaceClause) {
    const interfaces: string[] = [];
    for (let i = 0; i < interfaceClause.childCount; i++) {
      const child = interfaceClause.child(i)!;
      if (child.type === 'name') {
        interfaces.push(resolveTypeName(child.text, context));
      } else if (child.type === 'qualified_name') {
        interfaces.push(
          resolveTypeName(extractQualifiedNameText(child), context)
        );
      }
    }
    if (interfaces.length > 0) {
      metadata.implements = interfaces;
    }
  }

  // Extract members from declaration_list
  const children: ParsedSymbol[] = [];
  const body = findChild(node, 'declaration_list');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const member = body.child(i)!;
      switch (member.type) {
        case 'method_declaration':
          children.push(extractMethod(member, qualifiedName));
          break;
        case 'property_declaration':
          children.push(...extractProperties(member, qualifiedName));
          break;
        case 'const_declaration':
          children.push(...extractConstants(member, qualifiedName));
          break;
        case 'use_declaration': {
          // Trait usage: `use SomeTrait;`
          const traits: string[] = [];
          for (let j = 0; j < member.childCount; j++) {
            const traitChild = member.child(j)!;
            if (traitChild.type === 'name') {
              traits.push(resolveTypeName(traitChild.text, context));
            } else if (traitChild.type === 'qualified_name') {
              traits.push(
                resolveTypeName(
                  extractQualifiedNameText(traitChild),
                  context
                )
              );
            }
          }
          if (traits.length > 0) {
            metadata.traits = [
              ...((metadata.traits as string[]) || []),
              ...traits,
            ];
          }
          break;
        }
      }
    }
  }

  // Extract constructor promoted properties
  const constructorMethod = children.find(
    (c) => c.kind === 'method' && c.name === '__construct'
  );
  if (constructorMethod) {
    // Find the method_declaration node to get promoted params
    const methodNode = findChildByText(body!, 'method_declaration', '__construct');
    if (methodNode) {
      const promotedProps = extractPromotedProperties(
        methodNode,
        qualifiedName
      );
      children.push(...promotedProps);
    }
  }

  return {
    name,
    qualifiedName,
    kind,
    visibility: null,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    signature: null,
    returnType: null,
    docblock,
    children,
    metadata,
  };
}

// --- Method extraction ---

function extractMethod(
  node: SyntaxNode,
  parentQualifiedName: string
): ParsedSymbol {
  const nameNode = findChild(node, 'name');
  const name = nameNode?.text || '';
  const visibility = extractVisibility(node);
  const returnType = extractReturnType(node);
  const signature = extractSignature(node);
  const docblock = extractDocblock(node);

  const metadata: Record<string, unknown> = {};
  if (hasChildType(node, 'static_modifier')) {
    metadata.static = true;
  }
  if (hasChildType(node, 'abstract_modifier')) {
    metadata.abstract = true;
  }
  if (name.startsWith('__')) {
    metadata.magic = true;
  }

  return {
    name,
    qualifiedName: `${parentQualifiedName}::${name}`,
    kind: 'method',
    visibility,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    signature,
    returnType,
    docblock,
    children: [],
    metadata,
  };
}

// --- Function extraction ---

function extractFunction(
  node: SyntaxNode,
  context: NamespaceContext
): ParsedSymbol {
  const nameNode = findChild(node, 'name');
  const name = nameNode?.text || '';
  const qualifiedName = qualifyName(name, context);
  const returnType = extractReturnType(node);
  const signature = extractSignature(node);
  const docblock = extractDocblock(node);

  return {
    name,
    qualifiedName,
    kind: 'function',
    visibility: null,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    signature,
    returnType,
    docblock,
    children: [],
    metadata: {},
  };
}

// --- Property extraction ---

function extractProperties(
  node: SyntaxNode,
  parentQualifiedName: string
): ParsedSymbol[] {
  const visibility = extractVisibility(node);
  const docblock = extractDocblock(node);
  const symbols: ParsedSymbol[] = [];

  // Extract type from the property_declaration level
  const typeNode = findTypeNode(node);

  const metadata: Record<string, unknown> = {};
  if (hasChildType(node, 'static_modifier')) {
    metadata.static = true;
  }
  if (hasChildType(node, 'readonly_modifier')) {
    metadata.readonly = true;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'property_element') {
      const varNode = findDescendant(child, 'variable_name');
      if (!varNode) continue;

      // variable_name contains $ + name children
      const nameChild = findChild(varNode, 'name');
      const propName = nameChild?.text || varNode.text.replace('$', '');

      symbols.push({
        name: propName,
        qualifiedName: `${parentQualifiedName}::$${propName}`,
        kind: 'property',
        visibility,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        signature: null,
        returnType: typeNode?.text || null,
        docblock,
        children: [],
        metadata: { ...metadata },
      });
    }
  }

  return symbols;
}

// --- Constructor promoted property extraction ---

function extractPromotedProperties(
  methodNode: SyntaxNode,
  parentQualifiedName: string
): ParsedSymbol[] {
  const params = findChild(methodNode, 'formal_parameters');
  if (!params) return [];

  const symbols: ParsedSymbol[] = [];

  for (let i = 0; i < params.childCount; i++) {
    const param = params.child(i)!;
    if (param.type !== 'property_promotion_parameter') continue;

    const visibility = extractVisibility(param);
    const varNode = findChild(param, 'variable_name');
    const nameChild = varNode ? findChild(varNode, 'name') : null;
    const propName = nameChild?.text || varNode?.text.replace('$', '') || '';

    const typeNode = findTypeNode(param);

    const metadata: Record<string, unknown> = { promoted: true };
    if (hasChildType(param, 'readonly_modifier')) {
      metadata.readonly = true;
    }

    symbols.push({
      name: propName,
      qualifiedName: `${parentQualifiedName}::$${propName}`,
      kind: 'property',
      visibility,
      lineStart: param.startPosition.row + 1,
      lineEnd: param.endPosition.row + 1,
      signature: null,
      returnType: typeNode?.text || null,
      docblock: null,
      children: [],
      metadata,
    });
  }

  return symbols;
}

// --- Constant extraction ---

function extractConstants(
  node: SyntaxNode,
  parentQualifiedName: string
): ParsedSymbol[] {
  const visibility = extractVisibility(node);
  const docblock = extractDocblock(node);
  const symbols: ParsedSymbol[] = [];

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'const_element') {
      const nameNode = findChild(child, 'name');
      const name = nameNode?.text || '';

      symbols.push({
        name,
        qualifiedName: `${parentQualifiedName}::${name}`,
        kind: 'constant',
        visibility,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        signature: null,
        returnType: null,
        docblock,
        children: [],
        metadata: {},
      });
    }
  }

  return symbols;
}

// --- Helper functions ---

function qualifyName(name: string, context: NamespaceContext): string {
  if (context.namespace) {
    return `${context.namespace}\\${name}`;
  }
  return name;
}

function resolveTypeName(name: string, context: NamespaceContext): string {
  // Already fully qualified
  if (name.startsWith('\\')) return name.substring(1);

  // Check imports
  const firstPart = name.split('\\')[0];
  if (context.imports.has(firstPart)) {
    const resolved = context.imports.get(firstPart)!;
    const rest = name.substring(firstPart.length);
    return resolved + rest;
  }

  // Qualify with current namespace
  if (context.namespace) {
    return `${context.namespace}\\${name}`;
  }

  return name;
}

function extractVisibility(node: SyntaxNode): Visibility | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'visibility_modifier') {
      return child.text as Visibility;
    }
  }
  return null;
}

function extractReturnType(node: SyntaxNode): string | null {
  // Return type appears after `:` which follows formal_parameters
  let foundColon = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.text === ':') {
      foundColon = true;
      continue;
    }
    if (foundColon && isTypeNode(child)) {
      return child.text;
    }
  }
  return null;
}

function extractSignature(node: SyntaxNode): string | null {
  const nameNode = findChild(node, 'name');
  const params = findChild(node, 'formal_parameters');

  if (!nameNode || !params) return null;

  const returnType = extractReturnType(node);
  let sig = `${nameNode.text}${params.text}`;
  if (returnType) sig += `: ${returnType}`;

  return sig;
}

function extractDocblock(node: SyntaxNode): string | null {
  const prev = node.previousNamedSibling;
  if (prev?.type === 'comment' && prev.text.startsWith('/**')) {
    return prev.text;
  }
  return null;
}

function extractQualifiedText(namespaceNameNode: SyntaxNode): string {
  // namespace_name contains name nodes and \ separators
  const parts: string[] = [];
  for (let i = 0; i < namespaceNameNode.childCount; i++) {
    const child = namespaceNameNode.child(i)!;
    if (child.type === 'name') {
      parts.push(child.text);
    }
  }
  return parts.join('\\');
}

function extractQualifiedNameText(qualifiedNameNode: SyntaxNode): string {
  // qualified_name contains namespace_name + \ + name
  const parts: string[] = [];
  for (let i = 0; i < qualifiedNameNode.childCount; i++) {
    const child = qualifiedNameNode.child(i)!;
    if (child.type === 'namespace_name') {
      parts.push(extractQualifiedText(child));
    } else if (child.type === 'name') {
      parts.push(child.text);
    }
  }
  return parts.join('\\');
}

function findChild(
  node: SyntaxNode,
  type: string
): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === type) return child;
  }
  return null;
}

function findChildAfterType(
  node: SyntaxNode,
  afterType: string,
  targetType: string
): SyntaxNode | null {
  let found = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.text === afterType) {
      found = true;
      continue;
    }
    if (found && child.type === targetType) return child;
  }
  return null;
}

function findDescendant(
  node: SyntaxNode,
  type: string
): SyntaxNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.childCount; i++) {
    const result = findDescendant(node.child(i)!, type);
    if (result) return result;
  }
  return null;
}

function findChildByText(
  node: SyntaxNode,
  type: string,
  nameText: string
): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type !== type) continue;
    const nameNode = findChild(child, 'name');
    if (nameNode?.text === nameText) return child;
  }
  return null;
}

function hasChildType(node: SyntaxNode, type: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)!.type === type) return true;
  }
  return false;
}

const TYPE_NODE_TYPES = new Set([
  'named_type',
  'optional_type',
  'union_type',
  'intersection_type',
  'primitive_type',
  'nullable_type',
]);

function isTypeNode(node: SyntaxNode): boolean {
  return TYPE_NODE_TYPES.has(node.type);
}

function findTypeNode(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (isTypeNode(child)) return child;
  }
  return null;
}
