export class CartographError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'CartographError';
  }
}

export class IndexError extends CartographError {
  constructor(message: string) {
    super(message, 'INDEX_ERROR');
    this.name = 'IndexError';
  }
}

export class ParseError extends CartographError {
  constructor(message: string, public readonly filePath: string) {
    super(`${message} (file: ${filePath})`, 'PARSE_ERROR');
    this.name = 'ParseError';
  }
}

export class DatabaseError extends CartographError {
  constructor(message: string) {
    super(message, 'DATABASE_ERROR');
    this.name = 'DatabaseError';
  }
}

export class GenerateError extends CartographError {
  constructor(message: string) {
    super(message, 'GENERATE_ERROR');
    this.name = 'GenerateError';
  }
}
