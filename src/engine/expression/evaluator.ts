import { ExpressionError } from '../errors.js';
import type { BinaryRef, Item, JsonObject } from '../types.js';
import {
  callFunction,
  callMethod,
  deepEqual,
  fail,
  isPlainObject,
  MAX_ARRAY_LENGTH,
  MAX_STRING_LENGTH,
  toText,
} from './library.js';
import type { Node } from './parser.js';

export interface ExpressionData {
  json: JsonObject;
  binary?: Record<string, BinaryRef>;
  itemIndex: number;
  /** Items emitted by a previously executed node on its first output. */
  nodeOutput(nodeName: string): Item[] | undefined;
  workflow?: { id: string; name: string };
  execution?: { id: string; mode: string };
}

/** Upper bound on evaluated AST nodes per expression (lambdas over big arrays). */
const MAX_STEPS = 1_000_000;

/** Value of `$node`; only indexing by node name is allowed on it. */
class NodeAccessor {}
const NODE_ACCESSOR = new NodeAccessor();

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

type Scope = ReadonlyMap<string, unknown>;

export function evaluateAst(ast: Node, data: ExpressionData): unknown {
  const evaluator = new Evaluator(data);
  const value = evaluator.eval(ast, new Map());
  if (value instanceof NodeAccessor)
    fail('$node must be indexed, e.g. $node["Name"]');
  return value;
}

class Evaluator {
  private steps = 0;

  constructor(private readonly data: ExpressionData) {}

  eval(node: Node, scope: Scope): unknown {
    if (++this.steps > MAX_STEPS) fail('Expression is too complex');
    switch (node.kind) {
      case 'literal':
        return node.value;
      case 'ident':
        return this.variable(node.name, scope);
      case 'array':
        return guard(node.items.map((item) => this.eval(item, scope)));
      case 'object': {
        const result: Record<string, unknown> = {};
        for (const [key, value] of node.entries) {
          if (BLOCKED_KEYS.has(key)) fail(`Property "${key}" is not allowed`);
          result[key] = this.eval(value, scope);
        }
        return result;
      }
      case 'member': {
        const object = this.eval(node.object, scope);
        return this.member(object, this.key(node, scope));
      }
      case 'call':
        return guard(this.call(node, scope));
      case 'unary': {
        const arg = this.eval(node.arg, scope);
        if (node.op === '!') return !truthy(arg);
        return node.op === '-' ? -Number(arg) : Number(arg);
      }
      case 'binary':
        return guard(
          binary(
            node.op,
            this.eval(node.left, scope),
            this.eval(node.right, scope),
          ),
        );
      case 'logical': {
        const left = this.eval(node.left, scope);
        if (node.op === '&&')
          return truthy(left) ? this.eval(node.right, scope) : left;
        if (node.op === '||')
          return truthy(left) ? left : this.eval(node.right, scope);
        return left ?? this.eval(node.right, scope);
      }
      case 'conditional':
        return truthy(this.eval(node.test, scope))
          ? this.eval(node.consequent, scope)
          : this.eval(node.alternate, scope);
      case 'arrow':
        return fail(
          'Arrow functions can only be passed to array methods, e.g. map(x => x.id)',
        );
    }
  }

  private variable(name: string, scope: Scope): unknown {
    if (scope.has(name)) return scope.get(name);
    switch (name) {
      case '$json':
        return this.data.json;
      case '$binary':
        return this.data.binary ?? {};
      case '$itemIndex':
        return this.data.itemIndex;
      case '$now':
        return new Date().toISOString();
      case '$today': {
        const d = new Date();
        return new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
        ).toISOString();
      }
      case '$node':
        return NODE_ACCESSOR;
      case '$workflow':
        return this.data.workflow ?? null;
      case '$execution':
        return this.data.execution ?? null;
      default:
        return fail(`Unknown variable "${name}"`);
    }
  }

  private key(
    node: Extract<Node, { kind: 'member' }>,
    scope: Scope,
  ): string | number {
    const key = node.computed
      ? this.eval(node.property, scope)
      : (node.property as { value: string }).value;
    if (typeof key !== 'string' && typeof key !== 'number') {
      fail('Property key must be a string or a number');
    }
    return key;
  }

  private member(object: unknown, key: string | number): unknown {
    if (object instanceof NodeAccessor) {
      if (typeof key !== 'string')
        fail('Expected a node name, e.g. $node["Name"]');
      const items = this.data.nodeOutput(key);
      if (!items) fail(`Node "${key}" has not produced any data`);
      const item = items[this.data.itemIndex] ?? items[0];
      return item ? { json: item.json, binary: item.binary ?? {} } : undefined;
    }
    if (object === null || object === undefined) return undefined;
    if (typeof key === 'string' && BLOCKED_KEYS.has(key))
      fail(`Property "${key}" is not allowed`);

    if (typeof object === 'string' || Array.isArray(object)) {
      if (key === 'length') return object.length;
      const index =
        typeof key === 'number' ? key : /^\d+$/.test(key) ? Number(key) : NaN;
      return Number.isInteger(index) ? object[index] : undefined;
    }
    // Only own properties of plain data objects: never prototypes or functions.
    if (isPlainObject(object)) {
      return Object.hasOwn(object, key) ? object[key] : undefined;
    }
    return undefined;
  }

  private call(node: Extract<Node, { kind: 'call' }>, scope: Scope): unknown {
    const args = node.args.map((arg) =>
      arg.kind === 'arrow' ? this.lambda(arg, scope) : this.eval(arg, scope),
    );
    const callee = node.callee;
    if (callee.kind === 'ident' && !scope.has(callee.name)) {
      return callFunction(callee.name, args);
    }
    if (callee.kind === 'member') {
      const receiver = this.eval(callee.object, scope);
      if (
        (node.optional || callee.optional) &&
        (receiver === null || receiver === undefined)
      ) {
        return undefined;
      }
      const name = this.key(callee, scope);
      return callMethod(receiver, String(name), args);
    }
    return fail('Only functions and methods can be called');
  }

  private lambda(node: Extract<Node, { kind: 'arrow' }>, scope: Scope) {
    return (...args: unknown[]) => {
      const inner = new Map(scope);
      node.params.forEach((p, i) => inner.set(p, args[i]));
      const result = this.eval(node.body, inner);
      return result instanceof NodeAccessor
        ? fail('$node must be indexed')
        : result;
    };
  }
}

export function truthy(value: unknown): boolean {
  return Boolean(value);
}

function binary(op: string, a: unknown, b: unknown): unknown {
  switch (op) {
    case '+':
      if (
        typeof a === 'string' ||
        typeof b === 'string' ||
        isComposite(a) ||
        isComposite(b)
      ) {
        return toText(a) + toText(b);
      }
      return Number(a) + Number(b);
    case '-':
      return Number(a) - Number(b);
    case '*':
      return Number(a) * Number(b);
    case '/':
      return Number(a) / Number(b);
    case '%':
      return Number(a) % Number(b);
    case '===':
      return deepEqual(a, b);
    case '!==':
      return !deepEqual(a, b);
    // Loose equality: values typed in the UI are strings, so 5 == "5".
    case '==':
      return looseEqual(a, b);
    case '!=':
      return !looseEqual(a, b);
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compare(op, a, b);
    default:
      return fail(`Unknown operator "${op}"`);
  }
}

function isComposite(v: unknown): boolean {
  return v !== null && typeof v === 'object';
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (isComposite(a) || isComposite(b)) return deepEqual(a, b);
  if ((a === null || a === undefined) && (b === null || b === undefined))
    return true;
  return toText(a) === toText(b);
}

function compare(op: string, a: unknown, b: unknown): boolean {
  const both = typeof a === 'string' && typeof b === 'string';
  const x = both ? a : Number(a);
  const y = both ? b : Number(b);
  switch (op) {
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    default:
      return x >= y;
  }
}

function guard<T>(value: T): T {
  if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
    fail('Resulting string is too long');
  }
  if (Array.isArray(value) && value.length > MAX_ARRAY_LENGTH) {
    fail('Resulting array is too long');
  }
  return value;
}

export { ExpressionError };
