import { ExpressionError } from './errors.js';
import { evaluateAst, type ExpressionData } from './expression/evaluator.js';
import { toText } from './expression/library.js';
import { parseExpression } from './expression/parser.js';

/**
 * Expression language for node parameters. Safe by construction: it is parsed
 * into an AST and interpreted; there is no eval and no access to JS globals,
 * prototypes or functions other than the whitelisted library.
 *
 *   {{ $json.user.email }}                       fields; also ["first name"], [0]
 *   {{ $json.price * 1.2 }}                      + - * / %, comparisons, && || ?? !, a ? b : c
 *   {{ $json.name.toUpperCase() }}               whitelisted methods
 *   {{ $json.items.filter(i => i.qty > 0) }}     arrow functions in array methods
 *   {{ round($json.total, 2) }}                  global functions
 *   {{ $node["HTTP Request"].json.id }}          earlier node output (paired item)
 *   {{ $binary.data.fileName }}, $itemIndex, $now, $today, $workflow, $execution
 *
 * A parameter that is exactly one expression keeps the resolved value's type;
 * otherwise expressions are interpolated into the string.
 */
export type { ExpressionData };
export { toText };

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

export function evaluate(source: string, data: ExpressionData): unknown {
  try {
    return evaluateAst(parseExpression(source.trim()), data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExpressionError(`${message} in "{{ ${source.trim()} }}"`, source);
  }
}

function resolveString(value: string, data: ExpressionData): unknown {
  if (!value.includes('{{')) return value;
  const segments = splitTemplate(value);
  if (segments.length === 1 && typeof segments[0] !== 'string') {
    return evaluate(segments[0].expression, data) ?? null;
  }
  return segments
    .map((s) =>
      typeof s === 'string' ? s : toText(evaluate(s.expression, data)),
    )
    .join('');
}

type Segment = string | { expression: string };

/**
 * Splits "a {{ x }} b" into text and expression segments. Scans quotes and
 * braces so "}}" inside a string or an object literal does not end the expression.
 * Whitespace around a lone expression is ignored so "{{ x }} " keeps its type.
 */
function splitTemplate(value: string): Segment[] {
  const segments: Segment[] = [];
  let text = '';
  let i = 0;
  while (i < value.length) {
    if (!value.startsWith('{{', i)) {
      text += value[i++];
      continue;
    }
    const end = findClose(value, i + 2);
    if (end === -1) {
      throw new ExpressionError('Missing "}}"', value);
    }
    if (text) segments.push(text);
    text = '';
    segments.push({ expression: value.slice(i + 2, end) });
    i = end + 2;
  }
  if (text) segments.push(text);
  const meaningful = segments.filter(
    (s) => typeof s !== 'string' || s.trim() !== '',
  );
  return meaningful.length === 1 && typeof meaningful[0] !== 'string'
    ? meaningful
    : segments;
}

function findClose(value: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      if (depth === 0 && value[i + 1] === '}') return i;
      depth = Math.max(0, depth - 1);
    }
  }
  return -1;
}
