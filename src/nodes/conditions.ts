/** Condition lists shared by If, Filter and Switch. */
import { NodeOperationError } from '../engine/errors.js';
import { toText } from '../engine/expression.js';
import type { NodeExecuteContext, PropertySchema } from '../engine/types.js';

export type Operator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'isTrue'
  | 'isFalse';

export interface Condition {
  leftValue: unknown;
  operator: Operator;
  rightValue: unknown;
}

export const OPERATORS: { name: string; value: Operator }[] = [
  { name: 'Equals', value: 'equals' },
  { name: 'Not Equals', value: 'notEquals' },
  { name: 'Contains', value: 'contains' },
  { name: 'Not Contains', value: 'notContains' },
  { name: 'Greater Than', value: 'gt' },
  { name: 'Greater Than or Equal', value: 'gte' },
  { name: 'Less Than', value: 'lt' },
  { name: 'Less Than or Equal', value: 'lte' },
  { name: 'Is Empty', value: 'isEmpty' },
  { name: 'Is Not Empty', value: 'isNotEmpty' },
  { name: 'Is True', value: 'isTrue' },
  { name: 'Is False', value: 'isFalse' },
];

/** "conditions" + "combinator" parameters, as used by If and Filter. */
export const CONDITION_PROPERTIES: PropertySchema[] = [
  {
    name: 'conditions',
    displayName: 'Conditions',
    type: 'list',
    default: [],
    itemProperties: [
      {
        name: 'leftValue',
        displayName: 'Value 1',
        type: 'string',
        default: '',
      },
      {
        name: 'operator',
        displayName: 'Operator',
        type: 'options',
        default: 'equals',
        options: OPERATORS,
      },
      {
        name: 'rightValue',
        displayName: 'Value 2',
        type: 'string',
        default: '',
      },
    ],
  },
  {
    name: 'combinator',
    displayName: 'Combine',
    type: 'options',
    default: 'and',
    options: [
      { name: 'All conditions (AND)', value: 'and' },
      { name: 'Any condition (OR)', value: 'or' },
    ],
  },
];

/** Whether item `itemIndex` satisfies the node's conditions. */
export function itemMatches(
  ctx: NodeExecuteContext,
  itemIndex: number,
): boolean {
  const conditions =
    ctx.getParameter<Condition[]>('conditions', itemIndex) ?? [];
  const combinator = ctx.getParameter<'and' | 'or'>('combinator', itemIndex);
  const check = (c: Condition) => evaluateCondition(c, itemIndex);
  return combinator === 'or' ? conditions.some(check) : conditions.every(check);
}

export function evaluateCondition(c: Condition, itemIndex: number): boolean {
  const { leftValue: left, rightValue: right } = c;
  switch (c.operator) {
    case 'equals':
      return looseEquals(left, right);
    case 'notEquals':
      return !looseEquals(left, right);
    case 'contains':
      return contains(left, right);
    case 'notContains':
      return !contains(left, right);
    case 'gt':
      return toNumber(left, itemIndex) > toNumber(right, itemIndex);
    case 'gte':
      return toNumber(left, itemIndex) >= toNumber(right, itemIndex);
    case 'lt':
      return toNumber(left, itemIndex) < toNumber(right, itemIndex);
    case 'lte':
      return toNumber(left, itemIndex) <= toNumber(right, itemIndex);
    case 'isEmpty':
      return isEmpty(left);
    case 'isNotEmpty':
      return !isEmpty(left);
    case 'isTrue':
      return left === true || left === 'true';
    case 'isFalse':
      return left === false || left === 'false';
    default:
      throw new NodeOperationError(
        `Unknown operator "${String(c.operator)}"`,
        itemIndex,
      );
  }
}

/** Values typed into the UI arrive as strings, so `5` must equal `"5"`. */
function looseEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return toText(a) === toText(b);
}

function contains(haystack: unknown, needle: unknown): boolean {
  if (Array.isArray(haystack))
    return haystack.some((v) => looseEquals(v, needle));
  return toText(haystack).includes(toText(needle));
}

function toNumber(value: unknown, itemIndex: number): number {
  const n = Number(value);
  if (value === '' || value === null || Number.isNaN(n)) {
    throw new NodeOperationError(
      `"${toText(value)}" is not a number`,
      itemIndex,
    );
  }
  return n;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}
