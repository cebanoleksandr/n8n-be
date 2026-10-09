import { NodeOperationError, SuspendExecution } from '../../engine/errors.js';
import type { NodeType } from '../../engine/types.js';

/** Shorter waits sleep in the worker; longer ones pause the execution. */
export const IN_PROCESS_WAIT_MS = 65_000;

const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

export const waitNode: NodeType = {
  description: {
    type: 'core.wait',
    version: 1,
    displayName: 'Wait',
    description:
      'Pause the workflow for a while or until a date. Long waits free the worker and resume later',
    group: 'flow',
    inputs: 1,
    outputs: ['main'],
    properties: [
      {
        name: 'resume',
        displayName: 'Resume',
        type: 'options',
        default: 'timeInterval',
        options: [
          { name: 'After a time interval', value: 'timeInterval' },
          { name: 'At a specific time', value: 'specificTime' },
        ],
      },
      {
        name: 'amount',
        displayName: 'Amount',
        type: 'number',
        default: 1,
        displayOptions: { show: { resume: ['timeInterval'] } },
      },
      {
        name: 'unit',
        displayName: 'Unit',
        type: 'options',
        default: 'minutes',
        options: Object.keys(UNIT_MS).map((u) => ({ name: u, value: u })),
        displayOptions: { show: { resume: ['timeInterval'] } },
      },
      {
        name: 'dateTime',
        displayName: 'Date and Time',
        type: 'string',
        default: '',
        placeholder: '2026-12-31T09:00:00Z',
        displayOptions: { show: { resume: ['specificTime'] } },
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputItems();
    const resumeAt = resumeTime(
      ctx.getParameter<string>('resume', 0),
      ctx.getParameter<number>('amount', 0),
      ctx.getParameter<string>('unit', 0),
      ctx.getParameter<string>('dateTime', 0),
    );
    const delay = resumeAt.getTime() - Date.now();
    if (delay <= 0) return [items];
    if (delay > IN_PROCESS_WAIT_MS) throw new SuspendExecution(resumeAt);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, delay);
      ctx.signal.addEventListener('abort', done, { once: true });
      function done() {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', done);
        resolve();
      }
    });
    return [items];
  },
};

function resumeTime(
  mode: string,
  amount: unknown,
  unit: string,
  dateTime: string,
): Date {
  if (mode === 'specificTime') {
    const date = new Date(dateTime);
    if (!dateTime || Number.isNaN(date.getTime())) {
      throw new NodeOperationError(`Invalid date "${dateTime}"`);
    }
    return date;
  }
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0)
    throw new NodeOperationError('Amount must be 0 or more');
  const ms = UNIT_MS[unit];
  if (!ms) throw new NodeOperationError(`Unknown unit "${unit}"`);
  return new Date(Date.now() + n * ms);
}
