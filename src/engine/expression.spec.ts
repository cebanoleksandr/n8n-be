import { ExpressionError } from './errors.js';
import {
  evaluate,
  resolveParameter,
  type ExpressionData,
} from './expression.js';

const data: ExpressionData = {
  json: {
    user: { email: 'a@b.c', 'first name': 'Ann', tags: ['x', 'y'] },
    count: 3,
    price: '10.5',
    items: [
      { sku: 'a', qty: 2, price: 5 },
      { sku: 'b', qty: 0, price: 7 },
      { sku: 'c', qty: 1, price: 3 },
    ],
    created: '2026-01-31T10:00:00.000Z',
    empty: null,
  },
  binary: {
    data: { id: 'f1', fileName: 'a.pdf', mimeType: 'application/pdf', size: 3 },
  },
  itemIndex: 1,
  nodeOutput: (name) =>
    name === 'HTTP' ? [{ json: { id: 10 } }, { json: { id: 20 } }] : undefined,
  workflow: { id: 'wf-1', name: 'Orders' },
  execution: { id: 'ex-1', mode: 'manual' },
};

const ev = (expr: string) => evaluate(expr, data);

describe('resolveParameter', () => {
  it('returns strings without expressions unchanged', () => {
    expect(resolveParameter('plain', data)).toBe('plain');
  });

  it('keeps the type of a single expression, ignoring surrounding whitespace', () => {
    expect(resolveParameter('{{ $json.count }}', data)).toBe(3);
    expect(resolveParameter('  {{ $json.user.tags }} ', data)).toEqual([
      'x',
      'y',
    ]);
  });

  it('interpolates expressions inside text', () => {
    expect(
      resolveParameter(
        'Hi {{ $json.user["first name"] }}, n={{$json.count}}',
        data,
      ),
    ).toBe('Hi Ann, n=3');
  });

  it('handles "}}" inside strings and object literals', () => {
    expect(resolveParameter('{{ "a}}b" }}', data)).toBe('a}}b');
    expect(resolveParameter('{{ {a: {b: 1}} }}', data)).toEqual({
      a: { b: 1 },
    });
    expect(() => resolveParameter('{{ $json.count', data)).toThrow(
      'Missing "}}"',
    );
  });

  it('returns null for missing paths', () => {
    expect(resolveParameter('{{ $json.nope.deeper }}', data)).toBeNull();
    expect(resolveParameter('x{{ $json.nope }}y', data)).toBe('xy');
  });

  it('resolves nested objects and arrays', () => {
    expect(resolveParameter({ a: ['{{ $json.count }}'], b: 1 }, data)).toEqual({
      a: [3],
      b: 1,
    });
  });
});

describe('expression language', () => {
  it('evaluates variables', () => {
    expect(ev('$itemIndex')).toBe(1);
    expect(ev('$node["HTTP"].json.id')).toBe(20);
    expect(ev('$binary.data.fileName')).toBe('a.pdf');
    expect(ev('$workflow.name')).toBe('Orders');
    expect(ev('$execution.mode')).toBe('manual');
    expect(ev('$now')).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(ev('$today')).toMatch(/T00:00:00\.000Z$/);
  });

  it('supports arithmetic with precedence and parentheses', () => {
    expect(ev('$json.count + 1')).toBe(4);
    expect(ev('2 + 3 * 4')).toBe(14);
    expect(ev('(2 + 3) * 4')).toBe(20);
    expect(ev('-$json.count * 2')).toBe(-6);
    expect(ev('10 % 4')).toBe(2);
    expect(ev('$json.price * 2')).toBe(21);
    expect(ev('"n=" + $json.count')).toBe('n=3');
  });

  it('supports comparisons, logic and the ternary operator', () => {
    expect(ev('$json.count >= 3 && $json.count < 4')).toBe(true);
    expect(ev('$json.count == "3"')).toBe(true);
    expect(ev('$json.count === "3"')).toBe(false);
    expect(ev('$json.user.tags === ["x", "y"]')).toBe(true);
    expect(ev('!$json.empty')).toBe(true);
    expect(ev('$json.empty ?? "default"')).toBe('default');
    expect(ev('$json.empty || "fallback"')).toBe('fallback');
    expect(ev('$json.count > 2 ? "big" : "small"')).toBe('big');
    expect(ev('"b" > "a"')).toBe(true);
  });

  it('supports literals', () => {
    expect(ev('[1, "two", true, null]')).toEqual([1, 'two', true, null]);
    expect(ev('{ a: 1, "b c": [2] }')).toEqual({ a: 1, 'b c': [2] });
    expect(ev("'it\\'s'")).toBe("it's");
    expect(ev('1.5e3')).toBe(1500);
  });

  it('calls string, number and array methods', () => {
    expect(ev('$json.user.email.toUpperCase()')).toBe('A@B.C');
    expect(ev('$json.user.email.split("@")[1]')).toBe('b.c');
    expect(ev('"a-b-c".replaceAll("-", "+")')).toBe('a+b+c');
    expect(ev('$json.user["first name"].length')).toBe(3);
    expect(ev('(1 / 3).toFixed(2)')).toBe('0.33');
    expect(ev('$json.user.tags.join(", ")')).toBe('x, y');
    expect(ev('$json.user.tags.includes("y")')).toBe(true);
    expect(ev('[3, 1, 2].sort()')).toEqual([1, 2, 3]);
    expect(ev('[1, 1, 2].unique()')).toEqual([1, 2]);
    expect(ev('$json.empty?.toUpperCase()')).toBeUndefined();
  });

  it('supports arrow functions in array methods', () => {
    expect(ev('$json.items.filter(i => i.qty > 0).map(i => i.sku)')).toEqual([
      'a',
      'c',
    ]);
    expect(ev('$json.items.find(i => i.sku == "b").price')).toBe(7);
    expect(ev('$json.items.reduce((sum, i) => sum + i.qty * i.price, 0)')).toBe(
      13,
    );
    expect(ev('$json.items.sortBy(i => i.price).map(i => i.sku)')).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(ev('$json.items.some(i => i.qty == 0)')).toBe(true);
    expect(ev('[1, 2].map((x, i) => x * 10 + i)')).toEqual([10, 21]);
    expect(ev('[[1], [2]].map(a => a.map(x => x + $json.count))')).toEqual([
      [4],
      [5],
    ]);
  });

  it('calls global functions', () => {
    expect(ev('round(2.345, 2)')).toBe(2.35);
    expect(ev('max($json.items.map(i => i.price))')).toBe(7);
    expect(ev('sum([1, 2, 3])')).toBe(6);
    expect(ev('number("42")')).toBe(42);
    expect(ev('number("abc")')).toBeNull();
    expect(ev('isEmpty($json.empty) && !isEmpty($json.user)')).toBe(true);
    expect(ev('keys($json.user)')).toEqual(['email', 'first name', 'tags']);
    expect(ev('parseJson(\'{"a":1}\').a')).toBe(1);
    expect(ev('toJson({ a: 1 })')).toBe('{"a":1}');
    expect(ev('typeOf($json.user.tags)')).toBe('array');
  });

  it('works with dates', () => {
    expect(ev('dateAdd($json.created, 1, "months")')).toBe(
      '2026-03-03T10:00:00.000Z',
    );
    expect(ev('dateAdd($json.created, -2, "hours")')).toBe(
      '2026-01-31T08:00:00.000Z',
    );
    expect(ev('dateDiff("2026-01-01", $json.created, "days")')).toBe(30);
    expect(ev('formatDate($json.created, "dd.MM.yyyy HH:mm")')).toBe(
      '31.01.2026 10:00',
    );
    expect(() => ev('toDate("not a date")')).toThrow('Invalid date');
  });

  describe('sandboxing', () => {
    it.each([
      ['process.exit()', 'Unknown variable "process"'],
      ['globalThis', 'Unknown variable "globalThis"'],
      ['$env.SECRET', 'Unknown variable "$env"'],
      ['require("fs")', 'Unknown function "require"'],
      ['eval("1")', 'Unknown function "eval"'],
      ['$json.constructor', 'Property "constructor" is not allowed'],
      ['$json["__proto__"]', 'Property "__proto__" is not allowed'],
      ['"".constructor', 'Property "constructor" is not allowed'],
      [
        '"".constructor.constructor("return 1")()',
        'Only functions and methods can be called',
      ],
      ['$json.user.tags.map.call(null)', 'null has no method "call"'],
      ['{ __proto__: 1 }', 'Property "__proto__" is not allowed'],
      ['$json.toString()', 'object has no method "toString"'],
      ['$json.user.email.valueOf()', 'string has no method "valueOf"'],
      ['(x => x)', 'Arrow functions can only be passed to array methods'],
      [
        '[1].concat(x => x)',
        'Arrow functions are only allowed in array methods',
      ],
      ['$node', '$node must be indexed'],
    ])('rejects %s', (expr, message) => {
      expect(() => ev(expr)).toThrow(ExpressionError);
      expect(() => ev(expr)).toThrow(message);
    });

    it('does not expose methods as values', () => {
      expect(ev('$json.user.email.toUpperCase')).toBeUndefined();
      expect(ev('$json.user.tags.map')).toBeUndefined();
    });

    it('limits result size and evaluation work', () => {
      expect(() => ev('"x".repeat(2000000)')).toThrow(
        'count must be an integer',
      );
      expect(() => ev('"x".repeat(1000).repeat(1000).repeat(2)')).toThrow(
        'too long',
      );
      expect(() =>
        ev(
          '[1,2,3,4,5,6,7,8,9,10].map(a => [1,2,3,4,5,6,7,8,9,10].map(b => [1,2,3,4,5,6,7,8,9,10].map(c => [1,2,3,4,5,6,7,8,9,10].map(d => [1,2,3,4,5,6,7,8,9,10].map(e => [1,2,3,4,5,6,7,8,9,10].map(f => a+b+c+d+e+f))))))',
        ),
      ).toThrow('too complex');
    });
  });

  it('reports syntax errors with the position', () => {
    expect(() => ev('$json.count +')).toThrow(
      'Unexpected end of expression at position 13',
    );
    expect(() => ev('$json..x')).toThrow('Expected a property name');
    expect(() => ev('"open')).toThrow('Unterminated string');
    expect(() => ev('$json.count + 1 $json')).toThrow('Unexpected "$json"');
    expect(() => ev('$node["Other"].json')).toThrow('has not produced');
  });
});
