import Parser from 'tree-sitter';
// @ts-expect-error - tree-sitter-php has no proper ESM types
import PHP from 'tree-sitter-php';
import { readFileSync } from 'fs';
import type { DiscoveredFile, ParsedSymbol } from '../types.js';
import { parsePHP } from './parsers/php.js';
import { ParseError } from '../errors.js';

export interface AstParseResult {
  symbols: ParsedSymbol[];
  linesOfCode: number;
}

export class AstParser {
  private phpParser: Parser;

  constructor() {
    this.phpParser = new Parser();
    this.phpParser.setLanguage(PHP.php);
  }

  parse(file: DiscoveredFile): AstParseResult {
    const source = readFileSync(file.absolutePath, 'utf-8');
    const linesOfCode = source.split('\n').length;

    switch (file.language) {
      case 'php': {
        const result = parsePHP(source, this.phpParser);
        return { symbols: result.symbols, linesOfCode };
      }
      default:
        throw new ParseError(
          `Unsupported language: ${file.language}`,
          file.relativePath
        );
    }
  }
}
