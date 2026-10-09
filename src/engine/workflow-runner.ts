import { WorkflowValidationError } from './errors.js';
import { resolveParameter } from './expression.js';
import {
  incomingConnections,
  topologicalOrder,
  validateGraph,
} from './graph.js';
import { httpRequest } from './http.js';
import type { NodeRegistry } from './node-registry.js';
import type {
  Item,
  JsonObject,
  NodeExecuteContext,
  NodeType,
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
}

export type RunStatus = 'success' | 'error' | 'canceled';

export interface RunResult {
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
  signal?: AbortSignal;
  hooks?: RunHooks;
}

export class WorkflowRunner {
  constructor(private readonly registry: NodeRegistry) {}

  async run(options: RunOptions): Promise<RunResult> {
    const {
      graph,
      hooks = {},
      signal = new AbortController().signal,
    } = options;

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
          : collectInputs(node, nodeType, incoming.get(node.id) ?? [], outputs);

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
      const result = await this.executeNode(
        node,
        nodeType,
        inputs,
        outputsByName,
        signal,
      );
      results.push(result);
      await hooks.nodeFinished?.(result);

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
    outputsByName: Map<string, Item[][]>,
    signal: AbortSignal,
  ): Promise<NodeRunResult> {
    const startedAt = new Date();
    const outputCount = nodeType.description.outputs.length;
    const ctx: NodeExecuteContext = {
      node,
      signal,
      getInputItems: (inputIndex = 0) => inputs[inputIndex] ?? [],
      getParameter: <T>(name: string, itemIndex: number) => {
        const raw = node.parameters[name] ?? defaultFor(nodeType, name);
        return resolveParameter(raw, {
          json: inputs[0]?.[itemIndex]?.json ?? {},
          itemIndex,
          nodeOutput: (nodeName) => outputsByName.get(nodeName)?.[0],
        }) as T;
      },
      helpers: { httpRequest: (opts) => httpRequest(opts, signal) },
    };

    try {
      const output = await nodeType.execute(ctx);
      return {
        nodeId: node.id,
        nodeName: node.name,
        status: 'success',
        startedAt,
        finishedAt: new Date(),
        output: Array.from({ length: outputCount }, (_, i) => output[i] ?? []),
      };
    } catch (err) {
      const error = serializeError(err);
      const errorItem: Item = { json: { error: error.message } as JsonObject };
      return {
        nodeId: node.id,
        nodeName: node.name,
        status: 'error',
        startedAt,
        finishedAt: new Date(),
        output: Array.from({ length: outputCount }, (_, i) =>
          i === 0 && node.continueOnFail ? [errorItem] : [],
        ),
        error,
      };
    }
  }
}

function collectInputs(
  node: WorkflowNode,
  nodeType: NodeType,
  connections: {
    from: { nodeId: string; index: number };
    to: { index: number };
  }[],
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
