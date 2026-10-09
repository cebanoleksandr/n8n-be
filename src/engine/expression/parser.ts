import { ExpressionError } from '../errors.js';

/**
 * Tokenizer + Pratt parser for the expression language used inside {{ }}.
 * It produces an AST; nothing here executes code.
 */

export type Node =
  | { kind: 'literal'; value: unknown }
  | { kind: 'ident'; name: string; pos: number }
  | { kind: 'array'; items: Node[] }
  | { kind: 'object'; entries: [string, Node][] }
  | {
      kind: 'member';
      object: Node;
      property: Node;
      computed: boolean;
      optional: boolean;
      pos: number;
    }
  | { kind: 'call'; callee: Node; args: Node[]; optional: boolean; pos: number }
  | { kind: 'unary'; op: '!' | '-' | '+'; arg: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'logical'; op: '&&' | '||' | '??'; left: Node; right: Node }
  | { kind: 'conditional'; test: Node; consequent: Node; alternate: Node }
  | { kind: 'arrow'; params: string[]; body: Node };

type Token =
  | { type: 'num'; value: number; pos: number }
  | { type: 'str'; value: string; pos: number }
  | { type: 'ident'; value: string; pos: number }
  | { type: 'punct'; value: string; pos: number }
  | { type: 'eof'; value: ''; pos: number };

const PUNCTUATORS = [
  '===',
  '!==',
  '?.',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '!',
  '?',
  ':',
  '.',
  ',',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
];

const MAX_SOURCE_LENGTH = 10_000;

export function parseExpression(source: string): Node {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new ExpressionError(
      `Expression is longer than ${MAX_SOURCE_LENGTH} characters`,
      source,
    );
  }
  return new Parser(source).parse();
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const fail = (message: string): never => {
    throw new ExpressionError(`${message} at position ${i}`, src);
  };

  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      tokens.push({ type: 'num', value: Number(match[0]), pos: start });
      i += match[0].length;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let value = '';
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') {
          const next = src[i + 1];
          value +=
            next === 'n'
              ? '\n'
              : next === 't'
                ? '\t'
                : next === 'r'
                  ? '\r'
                  : (next ?? '');
          i += 2;
        } else {
          value += src[i++];
        }
      }
      if (src[i] !== ch) fail('Unterminated string');
      i++;
      tokens.push({ type: 'str', value, pos: start });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      tokens.push({ type: 'ident', value: match[0], pos: start });
      i += match[0].length;
      continue;
    }
    const punct = PUNCTUATORS.find((p) => src.startsWith(p, i));
    if (!punct) fail(`Unexpected character "${ch}"`);
    tokens.push({ type: 'punct', value: punct!, pos: start });
    i += punct!.length;
  }
  tokens.push({ type: 'eof', value: '', pos: src.length });
  return tokens;
}

// Binding power of binary operators; higher binds tighter.
const BINARY: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '===': 4,
  '!==': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
};

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(private readonly src: string) {
    this.tokens = tokenize(src);
  }

  parse(): Node {
    if (this.peek().type === 'eof') this.fail('Empty expression');
    const node = this.expression();
    if (this.peek().type !== 'eof')
      this.fail(`Unexpected "${this.peek().value}"`);
    return node;
  }

  private expression(): Node {
    const test = this.binary(0);
    if (this.matchPunct('?')) {
      const consequent = this.expression();
      this.expectPunct(':');
      return {
        kind: 'conditional',
        test,
        consequent,
        alternate: this.expression(),
      };
    }
    return test;
  }

  private binary(minPower: number): Node {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      const power = token.type === 'punct' ? BINARY[token.value] : undefined;
      if (power === undefined || power <= minPower) return left;
      this.index++;
      const right = this.binary(power);
      const op = token.value as string;
      left =
        op === '&&' || op === '||' || op === '??'
          ? { kind: 'logical', op, left, right }
          : { kind: 'binary', op, left, right };
    }
  }

  private unary(): Node {
    const token = this.peek();
    if (
      token.type === 'punct' &&
      (token.value === '!' || token.value === '-' || token.value === '+')
    ) {
      this.index++;
      // The operand binds tighter than any binary operator: -a * b is (-a) * b.
      return { kind: 'unary', op: token.value, arg: this.unary() };
    }
    return this.postfix(this.primary());
  }

  private postfix(node: Node): Node {
    for (;;) {
      const token = this.peek();
      if (token.type !== 'punct') return node;
      if (token.value === '.' || token.value === '?.') {
        this.index++;
        const optional = token.value === '?.';
        if (optional && this.peekPunct('(')) {
          node = this.call(node, true);
          continue;
        }
        if (optional && this.matchPunct('[')) {
          const property = this.expression();
          this.expectPunct(']');
          node = {
            kind: 'member',
            object: node,
            property,
            computed: true,
            optional,
            pos: token.pos,
          };
          continue;
        }
        const name = this.next();
        if (name.type !== 'ident')
          this.fail('Expected a property name', name.pos);
        node = {
          kind: 'member',
          object: node,
          property: { kind: 'literal', value: name.value },
          computed: false,
          optional,
          pos: token.pos,
        };
      } else if (token.value === '[') {
        this.index++;
        const property = this.expression();
        this.expectPunct(']');
        node = {
          kind: 'member',
          object: node,
          property,
          computed: true,
          optional: false,
          pos: token.pos,
        };
      } else if (token.value === '(') {
        node = this.call(node, false);
      } else {
        return node;
      }
    }
  }

  private call(callee: Node, optional: boolean): Node {
    const pos = this.expectPunct('(').pos;
    const args: Node[] = [];
    if (!this.matchPunct(')')) {
      do args.push(this.expression());
      while (this.matchPunct(','));
      this.expectPunct(')');
    }
    return { kind: 'call', callee, args, optional, pos };
  }

  private primary(): Node {
    const token = this.next();
    switch (token.type) {
      case 'num':
      case 'str':
        return { kind: 'literal', value: token.value };
      case 'ident': {
        if (this.peekPunct('=>')) {
          this.index++;
          return {
            kind: 'arrow',
            params: [token.value],
            body: this.expression(),
          };
        }
        if (token.value === 'true') return { kind: 'literal', value: true };
        if (token.value === 'false') return { kind: 'literal', value: false };
        if (token.value === 'null') return { kind: 'literal', value: null };
        if (token.value === 'undefined')
          return { kind: 'literal', value: undefined };
        return { kind: 'ident', name: token.value, pos: token.pos };
      }
      case 'punct':
        if (token.value === '(') return this.parenthesized();
        if (token.value === '[') return this.arrayLiteral();
        if (token.value === '{') return this.objectLiteral();
        break;
    }
    return this.fail(
      token.type === 'eof'
        ? 'Unexpected end of expression'
        : `Unexpected "${token.value}"`,
      token.pos,
    );
  }

  /** `(expr)` or an arrow function `(a, b) => expr`. */
  private parenthesized(): Node {
    const start = this.index;
    const params: string[] = [];
    let isArrow = false;
    if (this.matchPunct(')')) {
      isArrow = this.peekPunct('=>');
    } else {
      while (this.peek().type === 'ident') {
        params.push(this.next().value as string);
        if (!this.matchPunct(',')) break;
      }
      isArrow = this.matchPunct(')') && this.peekPunct('=>');
    }
    if (isArrow) {
      this.expectPunct('=>');
      return { kind: 'arrow', params, body: this.expression() };
    }
    this.index = start;
    const inner = this.expression();
    this.expectPunct(')');
    return inner;
  }

  private arrayLiteral(): Node {
    const items: Node[] = [];
    if (!this.matchPunct(']')) {
      do items.push(this.expression());
      while (this.matchPunct(','));
      this.expectPunct(']');
    }
    return { kind: 'array', items };
  }

  private objectLiteral(): Node {
    const entries: [string, Node][] = [];
    if (!this.matchPunct('}')) {
      do {
        const key = this.next();
        if (key.type !== 'ident' && key.type !== 'str')
          this.fail('Expected a property name', key.pos);
        this.expectPunct(':');
        entries.push([String(key.value), this.expression()]);
      } while (this.matchPunct(','));
      this.expectPunct('}');
    }
    return { kind: 'object', entries };
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (token.type !== 'eof') this.index++;
    return token;
  }

  private peekPunct(value: string): boolean {
    const token = this.peek();
    return token.type === 'punct' && token.value === value;
  }

  private matchPunct(value: string): boolean {
    if (!this.peekPunct(value)) return false;
    this.index++;
    return true;
  }

  private expectPunct(value: string): Token {
    const token = this.peek();
    if (token.type !== 'punct' || token.value !== value) {
      this.fail(`Expected "${value}"`, token.pos);
    }
    this.index++;
    return token;
  }

  private fail(message: string, pos = this.peek().pos): never {
    throw new ExpressionError(`${message} at position ${pos}`, this.src);
  }
}
