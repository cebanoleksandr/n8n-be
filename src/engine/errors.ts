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

/**
 * Thrown by a node (Wait) to pause the run until `resumeAt`. The runner turns
 * it into a 'waiting' result with the state needed to continue later.
 */
export class SuspendExecution extends Error {
  constructor(readonly resumeAt: Date) {
    super(`Waiting until ${resumeAt.toISOString()}`);
    this.name = 'SuspendExecution';
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
