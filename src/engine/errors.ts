export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

/** Thrown by node implementations for expected, user-facing failures. */
export class NodeOperationError extends Error {
  constructor(
    message: string,
    readonly itemIndex?: number,
  ) {
    super(message);
    this.name = 'NodeOperationError';
  }
}

export interface GraphIssue {
  message: string;
  nodeId?: string;
}

export class WorkflowValidationError extends Error {
  constructor(readonly issues: GraphIssue[]) {
    super(`Invalid workflow: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'WorkflowValidationError';
  }
}
