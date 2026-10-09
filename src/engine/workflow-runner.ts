import { NodeOperationError, WorkflowValidationError } from './errors.js';
import { type ExpressionData, resolveParameter } from './expression.js';
import {
  incomingConnections,
  topologicalOrder,
  validateGraph,
} from './graph.js';
import { httpRequest } from './http.js';
import type { NodeRegistry } from './node-registry.js';
import type {
  BinaryStore,
  CredentialsProvider,
  Item,
  JsonObject,
  NodeExecuteContext,
  NodeType,
  WorkflowConnection,
  WorkflowGraph,
  WorkflowNode,
} from './types.js';

export interface SerializedError {
  name: string;
  message: string;
  itemIndex?: number;
}

export interface NodeRunResult {
  nodeId: string;
  nodeName: string;
  status: 'success' | 'error';
  startedAt: Date;
  finishedAt: Date;
  /** One item array per output. */
  output: Item[][];
  error?: SerializedError;
  /** Attempts made, > 1 when retryOnFail kicked in. */
  tries: number;
}

export type RunStatus = 'success' | 'error' | 'canceled';

export interface RunResult {
  /**
   * 'canceled' means the signal aborted the run; the caller knows why
   * (signal.reason) and decides how to report it, e.g. timeout vs. user cancel.
   */
  status: RunStatus;
  nodes: NodeRunResult[];
  error?: SerializedError & { nodeId?: string };
}

export interface RunHooks {
  nodeStarted?(node: WorkflowNode): void | Promise<void>;
  nodeFinished?(result: NodeRunResult): void | Promise<void>;
}

export interface RunOptions {
  graph: WorkflowGraph;
  /** Trigger node to start from. Defaults to the first trigger node in the graph. */
  startNodeId?: string;
  /** Items handed to the start node. Defaults to a single empty item. */
  triggerItems?: Item[];
  /** Aborting it stops the run: between nodes, during retries and mid-node. */
  signal?: AbortSignal;
  hooks?: RunHooks;
  credentials?: CredentialsProvider;
  binary?: BinaryStore;
  /** Exposed to expressions as $workflow and $execution. */
  workflow?: { id: string; name: string };
  execution?: { id: string; mode: string };
}

const MAX_TRIES = 10;
const DEFAULT_TRIES = 3;
const DEFAULT_WAIT_BETWEEN_TRIES_MS = 1000;

export class WorkflowRunner {
  constructor(private readonly registry: NodeRegistry) {}

  async run(options: RunOptions): Promise<RunResult> {
    const { graph, hooks = {} } = options;
    const signal = options.signal ?? new AbortController().signal;

    const issues = validateGraph(graph, this.registry);
    if (issues.length > 0) throw new WorkflowValidationError(issues);

    const startNode = this.findStartNode(graph, options.startNodeId);
    const reachable = reachableFrom(graph, startNode.id);
    const incoming = incomingConnections(graph);
    const outputs = new Map<string, Item[][]>();
    const outputsByName = new Map<string, Item[][]>();
    const results: NodeRunResult[] = [];

    for (const node of topologicalOrder(graph)!) {
      if (!reachable.has(node.id)) continue;
      if (signal.aborted) return { status: 'canceled', nodes: results };

      const nodeType = this.registry.getOrThrow(node.type, node.typeVersion);
      const inputs =
        node.id === startNode.id
          ? [options.triggerItems ?? [{ json: {} }]]
          : collectInputs(nodeType, incoming.get(node.id) ?? [], outputs);

      // Nodes on branches that received no data (e.g. the unused side of an IF) are skipped.
      if (inputs.every((items) => items.length === 0)) continue;

      if (node.disabled) {
        const passThrough = [
          inputs[0] ?? [],
          ...nodeType.description.outputs.slice(1).map(() => []),
        ];
        outputs.set(node.id, passThrough);
        outputsByName.set(node.name, passThrough);
        continue;
      }

      await hooks.nodeStarted?.(node);
      const result = await this.executeNode(node, nodeType, inputs, {
        outputsByName,
        signal,
        options,
      });
      results.push(result);
      await hooks.nodeFinished?.(result);

      if (signal.aborted) return { status: 'canceled', nodes: results };
      if (result.status === 'error' && !node.continueOnFail) {
        return {
          status: 'error',
          nodes: results,
          error: { ...result.error!, nodeId: node.id },
        };
      }
      outputs.set(node.id, result.output);
      outputsByName.set(node.name, result.output);
    }

    return { status: 'success', nodes: results };
  }

  private findStartNode(
    graph: WorkflowGraph,
    startNodeId?: string,
  ): WorkflowNode {
    const isTrigger = (n: WorkflowNode) =>
      this.registry.getOrThrow(n.type, n.typeVersion).description.group ===
      'trigger';

    const node = startNodeId
      ? graph.nodes.find((n) => n.id === startNodeId)
      : graph.nodes.find((n) => isTrigger(n) && !n.disabled);
    if (!node) {
      throw new WorkflowValidationError([
        {
          message: startNodeId
            ? `Start node "${startNodeId}" not found`
            : 'Workflow has no trigger node',
        },
      ]);
    }
    if (!isTrigger(node)) {
      throw new WorkflowValidationError([
        { nodeId: node.id, message: `Node "${node.name}" is not a trigger` },
      ]);
    }
    return node;
  }

  private async executeNode(
    node: WorkflowNode,
    nodeType: NodeType,
    inputs: Item[][],
    run: {
      outputsByName: Map<string, Item[][]>;
      signal: AbortSignal;
      options: RunOptions;
    },
  ): Promise<NodeRunResult> {
    const { signal } = run;
    const startedAt = new Date();
    const outputCount = nodeType.description.outputs.length;
    const ctx = this.createContext(node, nodeType, inputs, run);
    const maxTries = node.retryOnFail
      ? Math.min(Math.max(node.maxTries ?? DEFAULT_TRIES, 1), MAX_TRIES)
      : 1;
    const base = { nodeId: node.id, nodeName: node.name, startedAt };

    for (let tries = 1; ; tries++) {
      try {
        const output = await untilAborted(nodeType.execute(ctx), signal);
        return {
          ...base,
          status: 'success',
          finishedAt: new Date(),
          output: Array.from(
            { length: outputCount },
            (_, i) => output[i] ?? [],
          ),
          tries,
        };
      } catch (err) {
        if (tries < maxTries && !signal.aborted) {
          await sleep(
            node.waitBetweenTriesMs ?? DEFAULT_WAIT_BETWEEN_TRIES_MS,
            signal,
          );
          if (!signal.aborted) continue;
        }
        const error = signal.aborted ? abortError(signal) : serializeError(err);
        const errorItem: Item = {
          json: { error: error.message } as JsonObject,
        };
        return {
          ...base,
          status: 'error',
          finishedAt: new Date(),
          output: Array.from({ length: outputCount }, (_, i) =>
            i === 0 && node.continueOnFail && !signal.aborted
              ? [errorItem]
              : [],
          ),
          error,
          tries,
        };
      }
    }
  }

  private createContext(
    node: WorkflowNode,
    nodeType: NodeType,
    inputs: Item[][],
    {
      outputsByName,
      signal,
      options,
    }: {
      outputsByName: Map<string, Item[][]>;
      signal: AbortSignal;
      options: RunOptions;
    },
  ): NodeExecuteContext {
    const binary = options.binary;
    const noBinary = (): never => {
      throw new NodeOperationError('Binary data storage is not configured');
    };
    return {
      node,
      signal,
      getInputItems: (inputIndex = 0) => inputs[inputIndex] ?? [],
      getParameter: <T>(name: string, itemIndex: number) => {
        const raw = node.parameters[name] ?? defaultFor(nodeType, name);
        const item = inputs[0]?.[itemIndex];
        const data: ExpressionData = {
          json: item?.json ?? {},
          binary: item?.binary,
          itemIndex,
          nodeOutput: (nodeName) => outputsByName.get(nodeName)?.[0],
          workflow: options.workflow,
          execution: options.execution,
        };
        return resolveParameter(raw, data) as T;
      },
      getCredentials: async <T>(type: string) => {
        const id = node.credentials?.[type];
        if (!id) {
          throw new NodeOperationError(`No "${type}" credential selected`);
        }
        if (!options.credentials) {
          throw new NodeOperationError('Credentials are not available');
        }
        return (await options.credentials.get(id, type)) as T;
      },
      helpers: {
        httpRequest: (opts) => httpRequest(opts, signal),
        storeBinary: (data, meta) =>
          binary ? binary.put(data, meta) : noBinary(),
        readBinary: (ref) => (binary ? binary.get(ref) : noBinary()),
      },
    };
  }
}

function collectInputs(
  nodeType: NodeType,
  connections: WorkflowConnection[],
  outputs: Map<string, Item[][]>,
): Item[][] {
  const inputs: Item[][] = Array.from(
    { length: nodeType.description.inputs },
    () => [],
  );
  for (const c of connections) {
    const items = outputs.get(c.from.nodeId)?.[c.from.index] ?? [];
    // Clone so that a node mutating its input cannot affect sibling branches.
    inputs[c.to.index].push(...structuredClone(items));
  }
  return inputs;
}

function reachableFrom(graph: WorkflowGraph, startId: string): Set<string> {
  const seen = new Set([startId]);
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const c of graph.connections) {
      if (c.from.nodeId === id && !seen.has(c.to.nodeId)) {
        seen.add(c.to.nodeId);
        stack.push(c.to.nodeId);
      }
    }
  }
  return seen;
}

function defaultFor(nodeType: NodeType, name: string): unknown {
  return nodeType.description.properties.find((p) => p.name === name)?.default;
}

/**
 * Resolves with the node's result, or rejects as soon as the signal aborts so a
 * node that ignores the signal cannot hold the run past a timeout or cancel.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err as Error);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

function abortError(signal: AbortSignal): SerializedError {
  const reason = signal.reason as unknown;
  return reason instanceof Error
    ? { name: reason.name, message: reason.message }
    : { name: 'AbortError', message: 'Execution was aborted' };
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const itemIndex = (err as { itemIndex?: unknown }).itemIndex;
    return {
      name: err.name,
      message: err.message,
      ...(typeof itemIndex === 'number' ? { itemIndex } : {}),
    };
  }
  return { name: 'Error', message: String(err) };
}
