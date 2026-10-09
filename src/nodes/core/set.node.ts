import { NodeOperationError } from '../../engine/errors.js';
import { toText } from '../../engine/expression.js';
import type { JsonObject, JsonValue, NodeType } from '../../engine/types.js';

interface Assignment {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  value: unknown;
}

export const setNode: NodeType = {
  description: {
    type: 'core.set',
    version: 1,
    displayName: 'Set',
    description: 'Add or overwrite fields on each item',
    group: 'transform',
    inputs: 1,
    outputs: ['main'],
    properties: [
      {
        name: 'assignments',
        displayName: 'Fields',
        type: 'list',
        default: [],
        itemProperties: [
          {
            name: 'name',
            displayName: 'Name',
            type: 'string',
            default: '',
            required: true,
            description: 'Supports dot paths, e.g. user.email',
          },
          {
            name: 'type',
            displayName: 'Type',
            type: 'options',
            default: 'string',
            options: [
              { name: 'String', value: 'string' },
              { name: 'Number', value: 'number' },
              { name: 'Boolean', value: 'boolean' },
              { name: 'JSON', value: 'json' },
            ],
          },
          { name: 'value', displayName: 'Value', type: 'string', default: '' },
        ],
      },
      {
        name: 'keepOtherFields',
        displayName: 'Keep Other Fields',
        type: 'boolean',
        default: true,
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputItems();
    const output = items.map((item, i) => {
      const assignments =
        ctx.getParameter<Assignment[]>('assignments', i) ?? [];
      const keep = ctx.getParameter<boolean>('keepOtherFields', i);
      const json: JsonObject = keep ? item.json : {};
      for (const a of assignments) {
        if (!a.name) throw new NodeOperationError('Field name is required', i);
        setPath(json, a.name, cast(a.value, a.type, i));
      }
      // Files pass through unchanged; Set only edits JSON.
      return item.binary ? { json, binary: item.binary } : { json };
    });
    return [output];
  },
};

function cast(
  value: unknown,
  type: Assignment['type'],
  itemIndex: number,
): JsonValue {
  switch (type) {
    case 'number': {
      const n = Number(value);
      if (Number.isNaN(n))
        throw new NodeOperationError(
          `"${toText(value)}" is not a number`,
          itemIndex,
        );
      return n;
    }
    case 'boolean':
      return value === true || value === 'true' || value === 1 || value === '1';
    case 'json':
      if (typeof value !== 'string') return (value ?? null) as JsonValue;
      try {
        return JSON.parse(value) as JsonValue;
      } catch {
        throw new NodeOperationError(`Invalid JSON: ${value}`, itemIndex);
      }
    default:
      return toText(value);
  }
}

function setPath(target: JsonObject, path: string, value: JsonValue): void {
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
