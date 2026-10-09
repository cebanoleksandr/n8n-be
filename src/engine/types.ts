export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Unit of data passed between nodes. Every node receives and emits arrays of items. */
export interface Item {
  json: JsonObject;
  /** Files attached to the item, by property name (e.g. "data"). Content lives in object storage. */
  binary?: Record<string, BinaryRef>;
}

/** Reference to a stored file. Items carry only this, never the bytes. */
export interface BinaryRef {
  id: string;
  fileName?: string;
  mimeType: string;
  size: number;
}

export interface BinaryMeta {
  fileName?: string;
  mimeType: string;
}

/** Object storage for item files, scoped to the current execution by the caller. */
export interface BinaryStore {
  put(data: Buffer, meta: BinaryMeta): Promise<BinaryRef>;
  get(ref: BinaryRef): Promise<Buffer>;
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
  /** Re-run the node when it throws, up to maxTries attempts in total. */
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTriesMs?: number;
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
  /** Source code (JavaScript); the editor shows a code editor. */
  | 'code'
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
  /**
   * Set when the outputs depend on parameters (see NodeType.outputsFor);
   * describes the rule for the editor, `outputs` is then the default.
   */
  dynamicOutputs?: string;
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
  /** Tokens are obtained through the OAuth2 flow and managed by the server. */
  oauth2?: boolean;
}

export interface WebhookResponse {
  statusCode: number;
  headers: Record<string, string>;
  /** JSON value or text; ignored when `binary` is set. */
  body?: unknown;
  /** Send this stored file as the response body. */
  binary?: BinaryRef;
}

/** Starts sub-workflows for the Execute Workflow node. */
export interface SubWorkflowRunner {
  run(workflowId: string, items: Item[], wait: boolean): Promise<Item[]>;
}

/** Resolves decrypted credential data for the workspace the run belongs to. */
export interface CredentialsProvider {
  get(id: string, type: string): Promise<Record<string, unknown>>;
  /** A valid access token of an OAuth2 credential (refreshed when needed). */
  oauth2AccessToken(id: string): Promise<string>;
}

export interface HttpRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface NodeExecuteContext {
  readonly node: WorkflowNode;
  readonly signal: AbortSignal;
  getInputItems(inputIndex?: number): Item[];
  /** Returns the parameter with expressions resolved against the item at `itemIndex`. */
  getParameter<T = unknown>(name: string, itemIndex: number): T;
  /** First output of every node that ran before this one, by node name. */
  getNodeOutputs(): Record<string, Item[]>;
  /** The run this node belongs to, as exposed to expressions. */
  getRunInfo(): {
    workflow?: { id: string; name: string };
    execution?: { id: string; mode: string };
  };
  /** Decrypted data of the credential selected on this node for `type`. */
  getCredentials<T = Record<string, unknown>>(type: string): Promise<T>;
  /** Access token of the OAuth2 credential selected for `type`. */
  getOAuth2AccessToken(type: string): Promise<string>;
  helpers: {
    httpRequest(options: HttpRequestOptions): Promise<HttpResponse>;
    /** Store a file and get a reference to attach to an item's `binary`. */
    storeBinary(data: Buffer, meta: BinaryMeta): Promise<BinaryRef>;
    readBinary(ref: BinaryRef): Promise<Buffer>;
    /**
     * Runs another workflow of the same workspace with `items` as its trigger
     * input. With wait, resolves to the output of its last executed node.
     */
    executeWorkflow(
      workflowId: string,
      items: Item[],
      wait: boolean,
    ): Promise<Item[]>;
    /** Answers the webhook request that started this run (first call wins). */
    respondToWebhook(response: WebhookResponse): Promise<void>;
  };
}

export interface NodeType {
  description: NodeTypeDescription;
  /** Output names for a configured node, when they depend on its parameters. */
  outputsFor?(parameters: Record<string, unknown>): string[];
  /** Returns one item array per output. */
  execute(ctx: NodeExecuteContext): Promise<Item[][]>;
}
