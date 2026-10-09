import { type ChildProcess, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface CodeRunRequest {
  code: string;
  mode: 'allItems' | 'eachItem';
  input: {
    items: unknown[];
    nodes: Record<string, unknown[]>;
    workflow?: unknown;
    execution?: unknown;
  };
  timeoutMs: number;
  memoryMb: number;
}

export interface CodeRunResult {
  result: unknown;
  logs: string[];
}

export class CodeError extends Error {
  constructor(
    message: string,
    readonly logs: string[],
  ) {
    super(message);
    this.name = 'CodeError';
  }
}

type Response =
  | { id: number; ok: true; result: string; logs: string[] }
  | { id: number; ok: false; error: string; logs: string[] };

/**
 * Runs Code node scripts in a separate process (sandbox-host) that holds
 * isolated-vm. One process serves many requests; it is restarted if it dies,
 * so a V8 crash inside an isolate never takes the worker down.
 */
class CodeSandbox {
  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (r: CodeRunResult) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  run(request: CodeRunRequest): Promise<CodeRunResult> {
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // Backstop in case the host never answers (it enforces timeoutMs itself).
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodeError('Code sandbox did not respond', []));
      }, request.timeoutMs + 5000);
      this.pending.set(id, { resolve, reject, timer });
      child.send({
        id,
        code: request.code,
        mode: request.mode,
        input: JSON.stringify(request.input),
        timeoutMs: request.timeoutMs,
        memoryMb: request.memoryMb,
      });
    });
  }

  close(): void {
    this.child?.disconnect();
    this.child?.kill();
    this.child = undefined;
  }

  private ensureChild(): ChildProcess {
    if (this.child?.connected) return this.child;
    const compiled = fileURLToPath(
      new URL('./sandbox-host.js', import.meta.url),
    );
    const source = fileURLToPath(new URL('./sandbox-host.ts', import.meta.url));
    // dist/ ships the .js; tests run the TypeScript source directly.
    const entry = existsSync(compiled) ? compiled : source;
    const child = fork(entry, [], {
      execArgv: ['--no-node-snapshot'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'json',
    });
    child.on('message', (res: Response) => {
      const waiter = this.pending.get(res.id);
      if (!waiter) return;
      this.pending.delete(res.id);
      clearTimeout(waiter.timer);
      if (res.ok) {
        waiter.resolve({
          result: JSON.parse(res.result) as unknown,
          logs: res.logs,
        });
      } else {
        waiter.reject(new CodeError(res.error, res.logs));
      }
    });
    child.on('exit', () => {
      if (this.child === child) this.child = undefined;
      for (const [id, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new CodeError('Code sandbox crashed', []));
        this.pending.delete(id);
      }
    });
    // Do not keep the parent alive just for an idle sandbox.
    child.unref();
    child.channel?.unref();
    this.child = child;
    return child;
  }
}

export const codeSandbox = new CodeSandbox();
