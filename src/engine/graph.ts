import { z } from 'zod';
import type { GraphIssue } from './errors.js';
import type { NodeRegistry } from './node-registry.js';
import type {
  WorkflowConnection,
  WorkflowGraph,
  WorkflowNode,
} from './types.js';

const endpointSchema = z.object({
  nodeId: z.string().min(1),
  index: z.number().int().min(0),
});

export const workflowGraphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().min(1).max(64),
      name: z.string().min(1).max(128),
      type: z.string().min(1),
      typeVersion: z.number().int().min(1),
      position: z.tuple([z.number(), z.number()]),
      parameters: z.record(z.string(), z.unknown()),
      continueOnFail: z.boolean().optional(),
      disabled: z.boolean().optional(),
    }),
  ),
  connections: z.array(z.object({ from: endpointSchema, to: endpointSchema })),
}) satisfies z.ZodType<WorkflowGraph>;

export const EMPTY_GRAPH: WorkflowGraph = { nodes: [], connections: [] };

/**
 * Semantic checks on top of the structural schema: unique ids and names,
 * known node types, valid connection endpoints, no cycles.
 */
export function validateGraph(
  graph: WorkflowGraph,
  registry: NodeRegistry,
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const byId = new Map<string, WorkflowNode>();
  const names = new Set<string>();

  for (const node of graph.nodes) {
    if (byId.has(node.id))
      issues.push({
        nodeId: node.id,
        message: `Duplicate node id "${node.id}"`,
      });
    if (names.has(node.name))
      issues.push({
        nodeId: node.id,
        message: `Duplicate node name "${node.name}"`,
      });
    byId.set(node.id, node);
    names.add(node.name);
    if (!registry.get(node.type, node.typeVersion)) {
      issues.push({
        nodeId: node.id,
        message: `Unknown node type ${node.type}@${node.typeVersion}`,
      });
    }
  }

  for (const c of graph.connections) {
    const from = byId.get(c.from.nodeId);
    const to = byId.get(c.to.nodeId);
    if (!from || !to) {
      issues.push({
        message: `Connection ${c.from.nodeId} -> ${c.to.nodeId} references a missing node`,
      });
      continue;
    }
    const fromType = registry.get(from.type, from.typeVersion);
    const toType = registry.get(to.type, to.typeVersion);
    if (fromType && c.from.index >= fromType.description.outputs.length) {
      issues.push({
        nodeId: from.id,
        message: `Node "${from.name}" has no output ${c.from.index}`,
      });
    }
    if (toType && c.to.index >= toType.description.inputs) {
      issues.push({
        nodeId: to.id,
        message: `Node "${to.name}" has no input ${c.to.index}`,
      });
    }
  }

  if (issues.length === 0 && topologicalOrder(graph) === null) {
    issues.push({ message: 'Workflow contains a cycle' });
  }
  return issues;
}

/** Kahn's algorithm. Returns null if the graph has a cycle. Ties keep declaration order. */
export function topologicalOrder(graph: WorkflowGraph): WorkflowNode[] | null {
  const inDegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const c of graph.connections) {
    inDegree.set(c.to.nodeId, (inDegree.get(c.to.nodeId) ?? 0) + 1);
  }
  const outgoing = groupBy(graph.connections, (c) => c.from.nodeId);
  const queue = graph.nodes.filter((n) => inDegree.get(n.id) === 0);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const order: WorkflowNode[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const c of outgoing.get(node.id) ?? []) {
      const remaining = inDegree.get(c.to.nodeId)! - 1;
      inDegree.set(c.to.nodeId, remaining);
      if (remaining === 0) queue.push(byId.get(c.to.nodeId)!);
    }
  }
  return order.length === graph.nodes.length ? order : null;
}

export function incomingConnections(
  graph: WorkflowGraph,
): Map<string, WorkflowConnection[]> {
  return groupBy(graph.connections, (c) => c.to.nodeId);
}

function groupBy<T>(list: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of list) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}
