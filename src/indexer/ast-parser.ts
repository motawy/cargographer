import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
import { readFileSync } from 'fs';
import type { DiscoveredFile, ParsedSymbol } from '../types.js';
import { parsePHP, type NamespaceContext } from './parsers/php.js';
import { ParseError } from '../errors.js';

export interface AstParseResult {
  symbols: ParsedSymbol[];
  linesOfCode: number;
  tree: Parser.Tree;
  context: NamespaceContext;
}

export class AstParser {
  private phpParser: Parser;

  constructor() {
    this.phpParser = new Parser();
    // @ts-expect-error - tree-sitter-php has no type declarations
    this.phpParser.setLanguage(PHP.php);
  }

  parse(file: DiscoveredFile): AstParseResult {
    const source = readFileSync(file.absolutePath, 'utf-8');
    const linesOfCode = source.split('\n').length;

    switch (file.language) {
      case 'php': {
        const tree = this.phpParser.parse(source);
        const result = parsePHP(tree);
        return {
          symbols: result.symbols,
          linesOfCode,
          tree,
          context: { namespace: result.namespace, imports: result.imports },
        };
      }
      default:
        throw new ParseError(
          `Unsupported language: ${file.language}`,
          file.relativePath
        );
    }
  }
}
