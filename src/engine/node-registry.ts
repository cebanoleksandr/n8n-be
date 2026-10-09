import type { NodeType, NodeTypeDescription } from './types.js';

export class NodeRegistry {
  private readonly nodes = new Map<string, NodeType>();

  constructor(nodes: NodeType[] = []) {
    nodes.forEach((n) => this.register(n));
  }

  register(node: NodeType): void {
    const key = NodeRegistry.key(
      node.description.type,
      node.description.version,
    );
    if (this.nodes.has(key)) {
      throw new Error(`Node type ${key} is already registered`);
    }
    this.nodes.set(key, node);
  }

  get(type: string, version: number): NodeType | undefined {
    return this.nodes.get(NodeRegistry.key(type, version));
  }

  getOrThrow(type: string, version: number): NodeType {
    const node = this.get(type, version);
    if (!node)
      throw new Error(`Unknown node type ${NodeRegistry.key(type, version)}`);
    return node;
  }

  describeAll(): NodeTypeDescription[] {
    return [...this.nodes.values()].map((n) => n.description);
  }

  private static key(type: string, version: number): string {
    return `${type}@${version}`;
  }
}
