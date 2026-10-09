import { toText } from '../engine/expression.js';
import type { JsonObject, JsonValue } from '../engine/types.js';

/** Reads "a.b.c" from an object; undefined when any part is missing. */
export function getPath(target: unknown, path: string): unknown {
  let current = target;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Writes "a.b.c", creating intermediate objects. */
export function setPath(
  target: JsonObject,
  path: string,
  value: JsonValue,
): void {
  const keys = path.split('.');
  let current = target;
  for (const key of keys.slice(0, -1)) {
    const next = current[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      current[key] = {};
    }
    current = current[key] as JsonObject;
  }
  current[keys[keys.length - 1]] = value;
}

/** Ascending order: numbers numerically, everything else as text; nulls last. */
export function compareValues(a: unknown, b: unknown): number {
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing || bMissing)
    return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = typeof a === 'object' ? JSON.stringify(a) : String(a as string);
  const y = typeof b === 'object' ? JSON.stringify(b) : String(b as string);
  return x.localeCompare(y, undefined, { numeric: true });
}

/** "a, b , c" -> ["a", "b", "c"] */
export function splitList(value: unknown): string[] {
  return toText(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
