import type { Item, NodeType } from '../../engine/types.js';
import { type Condition, evaluateCondition, OPERATORS } from '../conditions.js';

interface Rule extends Condition {
  outputKey?: string;
}

function rulesOf(parameters: Record<string, unknown>): Rule[] {
  return Array.isArray(parameters.rules) ? (parameters.rules as Rule[]) : [];
}

export const switchNode: NodeType = {
  description: {
    type: 'core.switch',
    version: 1,
    displayName: 'Switch',
    description: 'Route items to one output per rule',
    group: 'flow',
    inputs: 1,
    outputs: [],
    dynamicOutputs:
      'One output per rule (named by outputKey or its index), plus "fallback" when fallbackOutput is "extra"',
    properties: [
      {
        name: 'rules',
        displayName: 'Routing Rules',
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
          {
            name: 'outputKey',
            displayName: 'Output Name',
            type: 'string',
            default: '',
          },
        ],
      },
      {
        name: 'mode',
        displayName: 'Send To',
        type: 'options',
        default: 'firstMatch',
        options: [
          { name: 'First matching output', value: 'firstMatch' },
          { name: 'All matching outputs', value: 'allMatches' },
        ],
      },
      {
        name: 'fallbackOutput',
        displayName: 'Items Matching No Rule',
        type: 'options',
        default: 'none',
        options: [
          { name: 'Drop', value: 'none' },
          { name: 'Send to an extra "fallback" output', value: 'extra' },
        ],
      },
    ],
  },

  outputsFor(parameters) {
    const outputs = rulesOf(parameters).map((r, i) => r.outputKey || String(i));
    return parameters.fallbackOutput === 'extra'
      ? [...outputs, 'fallback']
      : outputs;
  },

  async execute(ctx) {
    const ruleCount = rulesOf(ctx.node.parameters).length;
    const withFallback = ctx.node.parameters.fallbackOutput === 'extra';
    const outputs: Item[][] = Array.from(
      { length: ruleCount + (withFallback ? 1 : 0) },
      () => [],
    );
    ctx.getInputItems().forEach((item, i) => {
      const rules = ctx.getParameter<Rule[]>('rules', i) ?? [];
      const allMatches = ctx.getParameter<string>('mode', i) === 'allMatches';
      let matched = false;
      for (let r = 0; r < rules.length; r++) {
        if (!evaluateCondition(rules[r], i)) continue;
        outputs[r].push(item);
        matched = true;
        if (!allMatches) break;
      }
      if (!matched && withFallback) outputs[ruleCount].push(item);
    });
    return outputs;
  },
};
