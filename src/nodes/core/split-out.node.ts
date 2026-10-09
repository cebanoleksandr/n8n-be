import { NodeOperationError } from '../../engine/errors.js';
import type {
  Item,
  JsonObject,
  JsonValue,
  NodeType,
} from '../../engine/types.js';
import { getPath } from '../utils.js';

export const splitOutNode: NodeType = {
  description: {
    type: 'core.splitOut',
    version: 1,
    displayName: 'Split Out',
    description: 'Turn an array field into one item per element',
    group: 'transform',
    inputs: 1,
    outputs: ['main'],
    properties: [
      {
        name: 'field',
        displayName: 'Field to Split Out',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'items',
        description: 'Dot path to an array, e.g. order.lines',
      },
      {
        name: 'include',
        displayName: 'Include',
        type: 'options',
        default: 'none',
        options: [
          { name: 'Only the element', value: 'none' },
          { name: 'All other fields', value: 'all' },
        ],
      },
      {
        name: 'destination',
        displayName: 'Destination Field',
        type: 'string',
        default: '',
        description:
          'Put each element under this field (defaults to the field name)',
      },
    ],
  },

  async execute(ctx) {
    const output: Item[] = [];
    ctx.getInputItems().forEach((item, i) => {
      const field = ctx.getParameter<string>('field', i);
      if (!field)
        throw new NodeOperationError('Field to Split Out is required', i);
      const value = getPath(item.json, field);
      if (value === undefined || value === null) return;
      const elements = (Array.isArray(value) ? value : [value]) as JsonValue[];
      const includeAll = ctx.getParameter<string>('include', i) === 'all';
      const destination =
        ctx.getParameter<string>('destination', i) || field.split('.').at(-1)!;

      for (const element of elements) {
        const isObject =
          element !== null &&
          typeof element === 'object' &&
          !Array.isArray(element);
        if (
          !includeAll &&
          isObject &&
          !ctx.getParameter<string>('destination', i)
        ) {
          output.push({ json: element as JsonObject });
          continue;
        }
        const base: JsonObject = includeAll ? { ...item.json } : {};
        // Drop the split array itself; nested paths keep their parent object.
        if (includeAll && !field.includes('.')) delete base[field];
        output.push({ json: { ...base, [destination]: element } });
      }
    });
    return [output];
  },
};
