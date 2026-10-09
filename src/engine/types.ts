export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Unit of data passed between nodes. Every node receives and emits arrays of items. */
export interface Item {
  json: JsonObject;
}

// ---------------------------------------------------------------------------
// Workflow graph (stored as JSONB in workflow_versions.graph)
// ---------------------------------------------------------------------------

export interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  /** When true, a failing node emits `{ error }` items instead of stopping the run. */
  continueOnFail?: boolean;
  disabled?: boolean;
  /** Selected credentials: credential type -> credential id. */
  credentials?: Record<string, string>;
}

export interface ConnectionEndpoint {
  nodeId: string;
  /** Output index on the source node / input index on the target node. */
  index: number;
}

export interface WorkflowConnection {
  from: ConnectionEndpoint;
  to: ConnectionEndpoint;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
}

// ---------------------------------------------------------------------------
// Node type definitions
// ---------------------------------------------------------------------------

export type PropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'options'
  | 'json'
  /** Repeated group of sub-properties, e.g. a list of headers. Value is an array of objects. */
  | 'list';

export interface PropertyOption {
  name: string;
  value: string | number | boolean;
}

/** Declarative description of a node parameter. The frontend renders forms from it. */
export interface PropertySchema {
  name: string;
  displayName: string;
  type: PropertyType;
  default: unknown;
  required?: boolean;
  description?: string;
  placeholder?: string;
  options?: PropertyOption[];
  /** Sub-properties of each entry when type === 'list'. */
  itemProperties?: PropertySchema[];
  /** Show this property only when other properties have one of the listed values. */
  displayOptions?: { show: Record<string, unknown[]> };
  /** Credential fields only: never returned by the API once saved. */
  secret?: boolean;
}

export type NodeGroup = 'trigger' | 'action' | 'transform' | 'flow';

export interface NodeTypeDescription {
  type: string;
  version: number;
  displayName: string;
  description: string;
  group: NodeGroup;
  /** Number of inputs. Triggers have 0. */
  inputs: number;
  /** Output names; their order defines output indexes. */
  outputs: string[];
  properties: PropertySchema[];
  /** Credential types this node can use. */
  credentials?: NodeCredentialDescription[];
}

export interface NodeCredentialDescription {
  type: string;
  required?: boolean;
  displayOptions?: { show: Record<string, unknown[]> };
}

export interface CredentialTypeDescription {
  type: string;
  displayName: string;
  properties: PropertySchema[];
}

/** Resolves decrypted credential data for the workspace the run belongs to. */
export interface CredentialsProvider {
  get(id: string, type: string): Promise<Record<string, unknown>>;
}

export interface HttpRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface NodeExecuteContext {
  readonly node: WorkflowNode;
  readonly signal: AbortSignal;
  getInputItems(inputIndex?: number): Item[];
  /** Returns the parameter with expressions resolved against the item at `itemIndex`. */
  getParameter<T = unknown>(name: string, itemIndex: number): T;
  /** Decrypted data of the credential selected on this node for `type`. */
  getCredentials<T = Record<string, unknown>>(type: string): Promise<T>;
  helpers: {
    httpRequest(options: HttpRequestOptions): Promise<HttpResponse>;
  };
}

export interface NodeType {
  description: NodeTypeDescription;
  /** Returns one item array per output. */
  execute(ctx: NodeExecuteContext): Promise<Item[][]>;
}
