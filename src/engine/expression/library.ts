import { ExpressionError } from '../errors.js';

/**
 * Whitelisted functions and methods available in expressions. Every entry is
 * pure data-in/data-out; nothing here can reach the host environment. The
 * name/signature/description fields feed editor autocomplete.
 */

export type Callable = (...args: unknown[]) => unknown;

export interface FunctionDef {
  signature: string;
  description: string;
  fn: (...args: unknown[]) => unknown;
}

export interface MethodDef<T> {
  signature: string;
  description: string;
  fn: (receiver: T, ...args: unknown[]) => unknown;
}

export const MAX_STRING_LENGTH = 1_000_000;
export const MAX_ARRAY_LENGTH = 100_000;

export function fail(message: string): never {
  throw new ExpressionError(message, '');
}

/** Text form of a value: '' for null/undefined, JSON for objects. */
export function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    )
  );
}

function str(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`${what} must be a string`);
  return value;
}

function num(value: unknown, what: string): number {
  if (typeof value !== 'number' || Number.isNaN(value))
    fail(`${what} must be a number`);
  return value;
}

function int(value: unknown, what: string, min: number, max: number): number {
  const n = num(value, what);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(`${what} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function optionalInt(value: unknown, what: string, min: number, max: number) {
  return value === undefined ? undefined : int(value, what, min, max);
}

function fn(value: unknown, what: string): Callable {
  if (typeof value !== 'function')
    fail(`${what} must be an arrow function, e.g. x => x.id`);
  return value as Callable;
}

function noFunction(args: unknown[]): void {
  if (args.some((a) => typeof a === 'function')) {
    fail('Arrow functions are only allowed in array methods');
  }
}

// ---------------------------------------------------------------------------
// Dates (ISO-8601 strings in, ISO-8601 strings out; UTC)
// ---------------------------------------------------------------------------

const UNIT_MS: Record<string, number> = {
  milliseconds: 1,
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};
const UNITS = [...Object.keys(UNIT_MS), 'months', 'years'];

export function toDate(value: unknown): Date {
  const date =
    typeof value === 'number' || typeof value === 'string'
      ? new Date(value)
      : fail('Expected a date (ISO string or timestamp)');
  if (Number.isNaN(date.getTime())) fail(`Invalid date "${toText(value)}"`);
  return date;
}

function unit(value: unknown): string {
  const u = str(value, 'Unit');
  if (!UNITS.includes(u))
    fail(`Unknown unit "${u}", use one of ${UNITS.join(', ')}`);
  return u;
}

function dateAdd(date: unknown, amount: unknown, u: unknown): string {
  const d = toDate(date);
  const n = num(amount, 'Amount');
  const name = unit(u);
  if (name === 'months') d.setUTCMonth(d.getUTCMonth() + n);
  else if (name === 'years') d.setUTCFullYear(d.getUTCFullYear() + n);
  else return new Date(d.getTime() + n * UNIT_MS[name]).toISOString();
  return d.toISOString();
}

function dateDiff(from: unknown, to: unknown, u: unknown): number {
  const a = toDate(from);
  const b = toDate(to);
  const name = unit(u);
  if (name === 'months' || name === 'years') {
    const months =
      (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
      (b.getUTCMonth() - a.getUTCMonth());
    return name === 'months' ? months : Math.trunc(months / 12);
  }
  return Math.trunc((b.getTime() - a.getTime()) / UNIT_MS[name]);
}

function formatDate(
  date: unknown,
  pattern: unknown = 'yyyy-MM-dd HH:mm:ss',
): string {
  const d = toDate(date);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const parts: Record<string, string> = {
    yyyy: String(d.getUTCFullYear()),
    MM: pad(d.getUTCMonth() + 1),
    dd: pad(d.getUTCDate()),
    HH: pad(d.getUTCHours()),
    mm: pad(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()),
    SSS: pad(d.getUTCMilliseconds(), 3),
  };
  return str(pattern, 'Pattern').replace(
    /yyyy|MM|dd|HH|mm|ss|SSS/g,
    (t) => parts[t],
  );
}

// ---------------------------------------------------------------------------
// Global functions
// ---------------------------------------------------------------------------

export const FUNCTIONS: Record<string, FunctionDef> = {
  abs: {
    signature: 'abs(n)',
    description: 'Absolute value',
    fn: (n) => Math.abs(num(n, 'n')),
  },
  ceil: {
    signature: 'ceil(n)',
    description: 'Round up',
    fn: (n) => Math.ceil(num(n, 'n')),
  },
  floor: {
    signature: 'floor(n)',
    description: 'Round down',
    fn: (n) => Math.floor(num(n, 'n')),
  },
  round: {
    signature: 'round(n, digits = 0)',
    description: 'Round to the given number of decimal places',
    fn: (n, digits) => {
      const f = 10 ** (optionalInt(digits, 'digits', 0, 15) ?? 0);
      return Math.round(num(n, 'n') * f) / f;
    },
  },
  min: {
    signature: 'min(a, b, ...)',
    description: 'Smallest number; also accepts one array',
    fn: (...args) => Math.min(...numbers(args)),
  },
  max: {
    signature: 'max(a, b, ...)',
    description: 'Largest number; also accepts one array',
    fn: (...args) => Math.max(...numbers(args)),
  },
  sum: {
    signature: 'sum(array)',
    description: 'Sum of an array of numbers',
    fn: (a) => numbers([a]).reduce((s, n) => s + n, 0),
  },
  number: {
    signature: 'number(value)',
    description: 'Convert to a number (null if not numeric)',
    fn: (v) => {
      const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
      return Number.isNaN(n) ? null : n;
    },
  },
  string: {
    signature: 'string(value)',
    description: 'Convert to text',
    fn: (v) => toText(v),
  },
  boolean: {
    signature: 'boolean(value)',
    description: 'true for true/"true"/1/"1"/non-empty values',
    fn: (v) => (typeof v === 'string' ? v === 'true' || v === '1' : Boolean(v)),
  },
  isEmpty: {
    signature: 'isEmpty(value)',
    description: 'null, "", [] or {}',
    fn: (v) =>
      v === null ||
      v === undefined ||
      v === '' ||
      (Array.isArray(v) && v.length === 0) ||
      (isPlainObject(v) && Object.keys(v).length === 0),
  },
  typeOf: {
    signature: 'typeOf(value)',
    description: '"string", "number", "boolean", "array", "object" or "null"',
    fn: (v) =>
      v === null || v === undefined
        ? 'null'
        : Array.isArray(v)
          ? 'array'
          : typeof v,
  },
  keys: {
    signature: 'keys(object)',
    description: 'Property names of an object',
    fn: (o) => Object.keys(obj(o)),
  },
  values: {
    signature: 'values(object)',
    description: 'Property values of an object',
    fn: (o) => Object.values(obj(o)),
  },
  entries: {
    signature: 'entries(object)',
    description: '[key, value] pairs of an object',
    fn: (o) => Object.entries(obj(o)),
  },
  merge: {
    signature: 'merge(a, b, ...)',
    description: 'Shallow-merge objects; later ones win',
    fn: (...args) => Object.assign({}, ...args.map(obj)) as unknown,
  },
  toJson: {
    signature: 'toJson(value)',
    description: 'Serialize to a JSON string',
    fn: (v) => JSON.stringify(v ?? null),
  },
  parseJson: {
    signature: 'parseJson(text)',
    description: 'Parse a JSON string',
    fn: (t) => {
      try {
        return JSON.parse(str(t, 'Text')) as unknown;
      } catch {
        return fail('parseJson: invalid JSON');
      }
    },
  },
  now: {
    signature: 'now()',
    description: 'Current time (ISO string)',
    fn: () => new Date().toISOString(),
  },
  toDate: {
    signature: 'toDate(value)',
    description: 'Normalize a timestamp or date string to ISO format',
    fn: (v) => toDate(v).toISOString(),
  },
  dateAdd: {
    signature: 'dateAdd(date, amount, unit)',
    description: `Add time; unit: ${UNITS.join(', ')}`,
    fn: dateAdd,
  },
  dateDiff: {
    signature: 'dateDiff(from, to, unit)',
    description: 'Whole units from "from" to "to"',
    fn: dateDiff,
  },
  formatDate: {
    signature: "formatDate(date, 'yyyy-MM-dd HH:mm:ss')",
    description: 'Format a date (UTC); tokens yyyy MM dd HH mm ss SSS',
    fn: formatDate,
  },
};

function numbers(args: unknown[]): number[] {
  const list =
    args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  return list.map((v, i) => num(v, `Argument ${i + 1}`));
}

function obj(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) fail('Expected an object');
  return value;
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export const STRING_METHODS: Record<string, MethodDef<string>> = {
  toUpperCase: {
    signature: 'toUpperCase()',
    description: 'Upper case',
    fn: (s) => s.toUpperCase(),
  },
  toLowerCase: {
    signature: 'toLowerCase()',
    description: 'Lower case',
    fn: (s) => s.toLowerCase(),
  },
  trim: {
    signature: 'trim()',
    description: 'Strip surrounding whitespace',
    fn: (s) => s.trim(),
  },
  trimStart: {
    signature: 'trimStart()',
    description: 'Strip leading whitespace',
    fn: (s) => s.trimStart(),
  },
  trimEnd: {
    signature: 'trimEnd()',
    description: 'Strip trailing whitespace',
    fn: (s) => s.trimEnd(),
  },
  split: {
    signature: 'split(separator)',
    description: 'Split into an array',
    fn: (s, sep) => s.split(str(sep, 'Separator')),
  },
  replace: {
    signature: 'replace(search, replacement)',
    description: 'Replace the first occurrence (plain text, no regex)',
    fn: (s, a, b) => s.replace(str(a, 'Search'), () => str(b, 'Replacement')),
  },
  replaceAll: {
    signature: 'replaceAll(search, replacement)',
    description: 'Replace every occurrence (plain text, no regex)',
    fn: (s, a, b) => s.split(str(a, 'Search')).join(str(b, 'Replacement')),
  },
  includes: {
    signature: 'includes(text)',
    description: 'Contains the text',
    fn: (s, t) => s.includes(str(t, 'Text')),
  },
  startsWith: {
    signature: 'startsWith(text)',
    description: 'Starts with the text',
    fn: (s, t) => s.startsWith(str(t, 'Text')),
  },
  endsWith: {
    signature: 'endsWith(text)',
    description: 'Ends with the text',
    fn: (s, t) => s.endsWith(str(t, 'Text')),
  },
  indexOf: {
    signature: 'indexOf(text)',
    description: 'Position of the text or -1',
    fn: (s, t) => s.indexOf(str(t, 'Text')),
  },
  slice: {
    signature: 'slice(start, end?)',
    description: 'Part of the string; negative indexes count from the end',
    fn: (s, a, b) =>
      s.slice(
        optionalInt(a, 'start', -MAX_STRING_LENGTH, MAX_STRING_LENGTH),
        optionalInt(b, 'end', -MAX_STRING_LENGTH, MAX_STRING_LENGTH),
      ),
  },
  substring: {
    signature: 'substring(start, end?)',
    description: 'Part of the string',
    fn: (s, a, b) =>
      s.substring(
        int(a, 'start', 0, MAX_STRING_LENGTH),
        optionalInt(b, 'end', 0, MAX_STRING_LENGTH),
      ),
  },
  padStart: {
    signature: 'padStart(length, fill = " ")',
    description: 'Pad at the start to the given length',
    fn: (s, n, f) =>
      s.padStart(
        int(n, 'length', 0, 10_000),
        f === undefined ? ' ' : str(f, 'fill'),
      ),
  },
  padEnd: {
    signature: 'padEnd(length, fill = " ")',
    description: 'Pad at the end to the given length',
    fn: (s, n, f) =>
      s.padEnd(
        int(n, 'length', 0, 10_000),
        f === undefined ? ' ' : str(f, 'fill'),
      ),
  },
  repeat: {
    signature: 'repeat(count)',
    description: 'Repeat the string',
    fn: (s, n) => {
      const count = int(n, 'count', 0, MAX_STRING_LENGTH);
      if (s.length * count > MAX_STRING_LENGTH)
        fail('Resulting string is too long');
      return s.repeat(count);
    },
  },
  at: {
    signature: 'at(index)',
    description: 'Character at index; negative counts from the end',
    fn: (s, i) =>
      s.at(int(i, 'index', -MAX_STRING_LENGTH, MAX_STRING_LENGTH)) ?? null,
  },
  toNumber: {
    signature: 'toNumber()',
    description: 'Parse as a number (null if not numeric)',
    fn: (s) => (s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s)),
  },
};

export const NUMBER_METHODS: Record<string, MethodDef<number>> = {
  toFixed: {
    signature: 'toFixed(digits)',
    description: 'Format with a fixed number of decimals',
    fn: (n, d) => n.toFixed(optionalInt(d, 'digits', 0, 20)),
  },
  toString: {
    signature: 'toString()',
    description: 'Convert to text',
    fn: (n: number) => String(n),
  },
};

export const ARRAY_METHODS: Record<string, MethodDef<unknown[]>> = {
  map: {
    signature: 'map(x => ...)',
    description: 'Transform every element',
    fn: (a, f) => a.map((x, i) => fn(f, 'map callback')(x, i)),
  },
  filter: {
    signature: 'filter(x => ...)',
    description: 'Keep elements where the callback is truthy',
    fn: (a, f) => a.filter((x, i) => fn(f, 'filter callback')(x, i)),
  },
  find: {
    signature: 'find(x => ...)',
    description: 'First matching element or null',
    fn: (a, f) => a.find((x, i) => fn(f, 'find callback')(x, i)) ?? null,
  },
  findIndex: {
    signature: 'findIndex(x => ...)',
    description: 'Index of the first match or -1',
    fn: (a, f) => a.findIndex((x, i) => fn(f, 'findIndex callback')(x, i)),
  },
  some: {
    signature: 'some(x => ...)',
    description: 'At least one element matches',
    fn: (a, f) => a.some((x, i) => fn(f, 'some callback')(x, i)),
  },
  every: {
    signature: 'every(x => ...)',
    description: 'All elements match',
    fn: (a, f) => a.every((x, i) => fn(f, 'every callback')(x, i)),
  },
  reduce: {
    signature: 'reduce((acc, x) => ..., initial)',
    description: 'Fold the array into one value',
    fn: (a, f, initial) =>
      a.reduce((acc, x, i) => fn(f, 'reduce callback')(acc, x, i), initial),
  },
  sort: {
    signature: 'sort((a, b) => a - b)?',
    description:
      'Sorted copy; without a callback sorts numbers/strings ascending',
    fn: (a, f) =>
      [...a].sort(
        f === undefined
          ? (x, y) => (x === y ? 0 : (x as number) < (y as number) ? -1 : 1)
          : (x, y) => Number(fn(f, 'sort callback')(x, y)),
      ),
  },
  sortBy: {
    signature: 'sortBy(x => key)',
    description: 'Sorted copy by a key, ascending',
    fn: (a, f) => {
      const key = fn(f, 'sortBy callback');
      return a
        .map((x) => ({ x, k: key(x) as number }))
        .sort((p, q) => (p.k === q.k ? 0 : p.k < q.k ? -1 : 1))
        .map((p) => p.x);
    },
  },
  join: {
    signature: 'join(separator = ",")',
    description: 'Join into a string',
    fn: (a, sep) =>
      a.map(toText).join(sep === undefined ? ',' : str(sep, 'Separator')),
  },
  includes: {
    signature: 'includes(value)',
    description: 'Contains an equal element',
    fn: (a, v) => a.some((x) => deepEqual(x, v)),
  },
  indexOf: {
    signature: 'indexOf(value)',
    description: 'Index of an equal element or -1',
    fn: (a, v) => a.findIndex((x) => deepEqual(x, v)),
  },
  slice: {
    signature: 'slice(start, end?)',
    description: 'Part of the array; negative indexes count from the end',
    fn: (a, s, e) =>
      a.slice(
        optionalInt(s, 'start', -MAX_ARRAY_LENGTH, MAX_ARRAY_LENGTH),
        optionalInt(e, 'end', -MAX_ARRAY_LENGTH, MAX_ARRAY_LENGTH),
      ),
  },
  concat: {
    signature: 'concat(other, ...)',
    description: 'Append arrays or values',
    fn: (a, ...rest) => a.concat(...rest),
  },
  reverse: {
    signature: 'reverse()',
    description: 'Reversed copy',
    fn: (a) => [...a].reverse(),
  },
  flat: {
    signature: 'flat(depth = 1)',
    description: 'Flatten nested arrays',
    fn: (a, d) => a.flat(optionalInt(d, 'depth', 0, 10) ?? 1),
  },
  unique: {
    signature: 'unique()',
    description: 'Copy without duplicates',
    fn: (a) => a.filter((x, i) => a.findIndex((y) => deepEqual(x, y)) === i),
  },
  at: {
    signature: 'at(index)',
    description: 'Element at index; negative counts from the end',
    fn: (a, i) =>
      a.at(int(i, 'index', -MAX_ARRAY_LENGTH, MAX_ARRAY_LENGTH)) ?? null,
  },
  first: {
    signature: 'first()',
    description: 'First element or null',
    fn: (a) => a[0] ?? null,
  },
  last: {
    signature: 'last()',
    description: 'Last element or null',
    fn: (a) => a.at(-1) ?? null,
  },
};

/** Methods that accept arrow functions; every other call rejects them. */
const LAMBDA_METHODS = new Set([
  'map',
  'filter',
  'find',
  'findIndex',
  'some',
  'every',
  'reduce',
  'sort',
  'sortBy',
]);

export function callMethod(
  receiver: unknown,
  name: string,
  args: unknown[],
): unknown {
  if (typeof receiver === 'string' && Object.hasOwn(STRING_METHODS, name)) {
    noFunction(args);
    return STRING_METHODS[name].fn(receiver, ...args);
  }
  if (typeof receiver === 'number' && Object.hasOwn(NUMBER_METHODS, name)) {
    noFunction(args);
    return NUMBER_METHODS[name].fn(receiver, ...args);
  }
  if (Array.isArray(receiver) && Object.hasOwn(ARRAY_METHODS, name)) {
    if (!LAMBDA_METHODS.has(name)) noFunction(args);
    return ARRAY_METHODS[name].fn(receiver, ...args);
  }
  const type =
    receiver === null || receiver === undefined
      ? 'null'
      : Array.isArray(receiver)
        ? 'array'
        : typeof receiver;
  return fail(`${type} has no method "${name}"`);
}

export function callFunction(name: string, args: unknown[]): unknown {
  if (!Object.hasOwn(FUNCTIONS, name)) fail(`Unknown function "${name}"`);
  noFunction(args);
  return FUNCTIONS[name].fn(...args);
}
