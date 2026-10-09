import { ExpressionError } from './errors.js';
import type { Item, JsonObject } from './types.js';

/**
 * Minimal, eval-free expression language for node parameters.
 *
 *   {{ $json.user.email }}              field of the current input item
 *   {{ $json["first name"] }}           bracket access, also [0] for arrays
 *   {{ $node["HTTP Request"].json.id }} output of an earlier node (same item index, else first item)
 *   {{ $itemIndex }}, {{ $now }}
 *
 * A parameter that is exactly one expression keeps the resolved value's type;
 * otherwise expressions are interpolated into the string.
 */
export interface ExpressionData {
  json: JsonObject;
  itemIndex: number;
  /** Items emitted by a previously executed node on its first output. */
  nodeOutput(nodeName: string): Item[] | undefined;
}

const EXPRESSION = /\{\{(.*?)\}\}/gs;
const SINGLE_EXPRESSION = /^\s*\{\{(.*?)\}\}\s*$/s;

export function resolveParameter(
  value: unknown,
  data: ExpressionData,
): unknown {
  if (typeof value === 'string') return resolveString(value, data);
  if (Array.isArray(value)) return value.map((v) => resolveParameter(v, data));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveParameter(v, data)]),
    );
  }
  return value;
}

function resolveString(value: string, data: ExpressionData): unknown {
  if (!value.includes('{{')) return value;
  const single = SINGLE_EXPRESSION.exec(value);
  if (single && !single[1].includes('{{')) {
    return evaluate(single[1], data) ?? null;
  }
  return value.replace(EXPRESSION, (_, expr: string) =>
    toText(evaluate(expr, data)),
  );
}

/** Text form of a value: '' for null/undefined, JSON for objects. */
export function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function evaluate(source: string, data: ExpressionData): unknown {
  return new Parser(source.trim(), data).parse();
}

class Parser {
  private pos = 0;

  constructor(
    private readonly src: string,
    private readonly data: ExpressionData,
  ) {}

  parse(): unknown {
    let value = this.root();
    while (this.pos < this.src.length) {
      value = this.accessor(value);
    }
    return value;
  }

  private root(): unknown {
    const name = this.identifier();
    switch (name) {
      case '$json':
        return this.data.json;
      case '$itemIndex':
        return this.data.itemIndex;
      case '$now':
        return new Date().toISOString();
      case '$node': {
        const nodeName = this.bracketKey();
        if (typeof nodeName !== 'string')
          this.fail('Expected a node name, e.g. $node["Name"]');
        const items = this.data.nodeOutput(nodeName);
        if (!items) this.fail(`Node "${nodeName}" has not produced any data`);
        const item = items[this.data.itemIndex] ?? items[0];
        return item ? { json: item.json } : undefined;
      }
      default:
        this.fail(`Unknown variable "${name}"`);
    }
  }

  private accessor(target: unknown): unknown {
    const ch = this.src[this.pos];
    let key: string | number;
    if (ch === '.') {
      this.pos++;
      key = this.identifier();
    } else if (ch === '[') {
      key = this.bracketKey();
    } else {
      this.fail(`Unexpected "${ch}"`);
    }
    if (target === null || typeof target !== 'object') return undefined;
    return (target as Record<string | number, unknown>)[key];
  }

  private identifier(): string {
    const match = /^\$?[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!match) this.fail('Expected an identifier');
    this.pos += match[0].length;
    return match[0];
  }

  private bracketKey(): string | number {
    const match =
      /^\[\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\d+))\s*\]/.exec(
        this.src.slice(this.pos),
      );
    if (!match) this.fail('Expected ["key"] or [index]');
    this.pos += match[0].length;
    if (match[3] !== undefined) return Number(match[3]);
    return (match[1] ?? match[2]).replace(/\\(.)/g, '$1');
  }

  private fail(message: string): never {
    throw new ExpressionError(
      `${message} at position ${this.pos} in "{{ ${this.src} }}"`,
      this.src,
    );
  }
}
