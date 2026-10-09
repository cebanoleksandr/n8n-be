import {
  ARRAY_METHODS,
  FUNCTIONS,
  NUMBER_METHODS,
  STRING_METHODS,
} from './library.js';

export interface ReferenceEntry {
  name: string;
  signature: string;
  description: string;
}

export interface ExpressionReference {
  variables: ReferenceEntry[];
  functions: ReferenceEntry[];
  methods: {
    string: ReferenceEntry[];
    number: ReferenceEntry[];
    array: ReferenceEntry[];
  };
  properties: { string: ReferenceEntry[]; array: ReferenceEntry[] };
}

const VARIABLES: ReferenceEntry[] = [
  {
    name: '$json',
    signature: '$json',
    description: 'JSON of the current input item',
  },
  {
    name: '$binary',
    signature: '$binary',
    description:
      'Files of the current input item: { [field]: { id, fileName, mimeType, size } }',
  },
  {
    name: '$node',
    signature: '$node["Node name"].json',
    description:
      'Output of an earlier node (item with the same index, else the first)',
  },
  {
    name: '$itemIndex',
    signature: '$itemIndex',
    description: 'Index of the current item',
  },
  { name: '$now', signature: '$now', description: 'Current time, ISO string' },
  {
    name: '$today',
    signature: '$today',
    description: 'Start of today (UTC), ISO string',
  },
  {
    name: '$workflow',
    signature: '$workflow.name',
    description: '{ id, name } of this workflow',
  },
  {
    name: '$execution',
    signature: '$execution.id',
    description: '{ id, mode } of this execution',
  },
];

function entries(
  defs: Record<string, { signature: string; description: string }>,
) {
  return Object.entries(defs).map(([name, d]) => ({
    name,
    signature: d.signature,
    description: d.description,
  }));
}

/** Everything the editor needs for autocomplete and inline docs. */
export function expressionReference(): ExpressionReference {
  const length = {
    name: 'length',
    signature: 'length',
    description: 'Number of elements/characters',
  };
  return {
    variables: VARIABLES,
    functions: entries(FUNCTIONS),
    methods: {
      string: entries(STRING_METHODS),
      number: entries(NUMBER_METHODS),
      array: entries(ARRAY_METHODS),
    },
    properties: { string: [length], array: [length] },
  };
}
