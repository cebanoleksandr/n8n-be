// Child process that runs Code node scripts in isolated-vm. Started by
// sandbox-client.ts with --no-node-snapshot (required by isolated-vm on
// Node >= 20). Self-contained on purpose (no local imports) so it can run
// both from dist/ and as TypeScript via Node's type stripping in tests.
import ivm from 'isolated-vm';

interface RunRequest {
  id: number;
  code: string;
  mode: 'allItems' | 'eachItem';
  /** JSON: { items, nodes, workflow, execution }. */
  input: string;
  timeoutMs: number;
  memoryMb: number;
}

type RunResponse =
  | { id: number; ok: true; result: string; logs: string[] }
  | { id: number; ok: false; error: string; logs: string[] };

const MAX_LOG_LINES = 100;

// Runs inside the isolate. Only data crosses the boundary: JSON in, JSON out.
const PRELUDE = `
const __data = JSON.parse(__input);
const __logs = [];
const console = {
  log: (...args) => {
    if (__logs.length < ${MAX_LOG_LINES}) {
      __logs.push(args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    }
  },
};
console.info = console.warn = console.error = console.log;
const $workflow = __data.workflow;
const $execution = __data.execution;
const $now = new Date().toISOString();
const $ = (name) => {
  const items = __data.nodes[name];
  if (!items) throw new Error('Node "' + name + '" has not produced any data');
  return { all: () => items, first: () => items[0], last: () => items[items.length - 1] };
};
`;

function wrap(code: string, mode: RunRequest['mode']): string {
  const body =
    mode === 'allItems'
      ? `const items = __data.items;
         const $input = { all: () => items, first: () => items[0], last: () => items[items.length - 1] };
         return await (async () => {\n${code}\n})();`
      : `const results = [];
         for (let $itemIndex = 0; $itemIndex < __data.items.length; $itemIndex++) {
           const item = __data.items[$itemIndex];
           const $json = item.json;
           const $input = { item };
           results.push(await (async () => {\n${code}\n})());
         }
         return results;`;
  return `${PRELUDE}
(async () => { ${body} })().then(
  (result) => JSON.stringify({ result: result === undefined ? null : result, logs: __logs }),
  (error) => { throw new Error(JSON.stringify({ message: String(error && error.message || error), logs: __logs })); },
)`;
}

async function run(req: RunRequest): Promise<RunResponse> {
  const isolate = new ivm.Isolate({ memoryLimit: req.memoryMb });
  // Async code can outlive the sync timeout (e.g. an awaited promise that
  // never settles); disposing the isolate stops it for good.
  const timer = setTimeout(() => {
    if (!isolate.isDisposed) isolate.dispose();
  }, req.timeoutMs);
  try {
    const context = await isolate.createContext();
    await context.global.set('__input', req.input);
    const output = (await context.eval(wrap(req.code, req.mode), {
      timeout: req.timeoutMs,
      promise: true,
    })) as string;
    const parsed = JSON.parse(output) as { result: unknown; logs: string[] };
    return {
      id: req.id,
      ok: true,
      result: JSON.stringify(parsed.result),
      logs: parsed.logs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const parsed = JSON.parse(message) as { message: string; logs: string[] };
      return {
        id: req.id,
        ok: false,
        error: parsed.message,
        logs: parsed.logs,
      };
    } catch {
      const error = isolate.isDisposed
        ? `Code did not finish within ${req.timeoutMs} ms or exceeded ${req.memoryMb} MB`
        : message;
      return { id: req.id, ok: false, error, logs: [] };
    }
  } finally {
    clearTimeout(timer);
    if (!isolate.isDisposed) isolate.dispose();
  }
}

process.on('message', (req: RunRequest) => {
  void run(req).then((res) => process.send?.(res));
});
// The parent going away must not leave this process behind.
process.on('disconnect', () => process.exit(0));
