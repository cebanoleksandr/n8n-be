import { ExpressionError } from './errors.js';
import { resolveParameter, type ExpressionData } from './expression.js';

const data: ExpressionData = {
  json: {
    user: { email: 'a@b.c', 'first name': 'Ann', tags: ['x', 'y'] },
    count: 3,
  },
  itemIndex: 1,
  nodeOutput: (name) =>
    name === 'HTTP' ? [{ json: { id: 10 } }, { json: { id: 20 } }] : undefined,
};

describe('resolveParameter', () => {
  it('returns strings without expressions unchanged', () => {
    expect(resolveParameter('plain', data)).toBe('plain');
  });

  it('keeps the type of a single expression', () => {
    expect(resolveParameter('{{ $json.count }}', data)).toBe(3);
    expect(resolveParameter('{{ $json.user.tags }}', data)).toEqual(['x', 'y']);
  });

  it('interpolates expressions inside text', () => {
    expect(
      resolveParameter(
        'Hi {{ $json.user["first name"] }}, n={{$json.count}}',
        data,
      ),
    ).toBe('Hi Ann, n=3');
  });

  it('supports array indexes and $itemIndex', () => {
    expect(resolveParameter('{{ $json.user.tags[1] }}', data)).toBe('y');
    expect(resolveParameter('{{ $itemIndex }}', data)).toBe(1);
  });

  it('reads the paired item of another node', () => {
    expect(resolveParameter('{{ $node["HTTP"].json.id }}', data)).toBe(20);
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

  it('rejects unknown variables and arbitrary code', () => {
    expect(() => resolveParameter('{{ $env.SECRET }}', data)).toThrow(
      ExpressionError,
    );
    expect(() => resolveParameter('{{ process.exit() }}', data)).toThrow(
      ExpressionError,
    );
    expect(() => resolveParameter('{{ $json.count + 1 }}', data)).toThrow(
      ExpressionError,
    );
  });

  it('fails on a node without data', () => {
    expect(() => resolveParameter('{{ $node["Other"].json }}', data)).toThrow(
      /has not produced/,
    );
  });
});
