import { CronExpressionParser } from 'cron-parser';
import type { NodeType } from '../../engine/types.js';

/** Returns an error message, or null when the expression and timezone are valid. */
export function validateCron(cron: string, timezone: string): string | null {
  try {
    CronExpressionParser.parse(cron, { tz: timezone, strict: false });
  } catch (err) {
    return `Invalid cron expression "${cron}": ${(err as Error).message}`;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return `Unknown timezone "${timezone}"`;
  }
  return null;
}

export const scheduleNode: NodeType = {
  description: {
    type: 'core.schedule',
    version: 1,
    displayName: 'Schedule',
    description:
      'Starts the workflow on a cron schedule. Active workflows only',
    group: 'trigger',
    inputs: 0,
    outputs: ['main'],
    properties: [
      {
        name: 'cron',
        displayName: 'Cron Expression',
        type: 'string',
        default: '0 * * * *',
        required: true,
        description:
          'minute hour day-of-month month day-of-week; optional leading seconds',
      },
      {
        name: 'timezone',
        displayName: 'Timezone',
        type: 'string',
        default: 'UTC',
        placeholder: 'Europe/Kyiv',
      },
    ],
  },
  // The scheduler passes { timestamp } as the trigger item.
  async execute(ctx) {
    return [ctx.getInputItems()];
  },
};
