import type { RelationshipKind } from "@cloud-agent/contracts";

export interface AwsContext {
  accountId: string;
  region: string;
}

export interface StackResource {
  stack: string;
  logicalId: string;
  physicalId: string;
  type: string;
  status: string;
}

export interface TaggedResource {
  arn: string;
  tags: Record<string, string>;
}

export interface ResourceLink {
  from: string;
  to: string;
  kind: RelationshipKind;
  rationale: string;
}

export interface ResourceDetail {
  /** Redaction-safe configuration summary. Never contains env var values or secrets. */
  summary: Record<string, unknown>;
  links: ResourceLink[];
  /** Local-only hints used for inferred edges; never persisted as evidence. */
  envValues?: Record<string, string>;
  limitations: string[];
}

export interface DescribeTarget {
  arn: string;
  physicalId: string;
  type: string;
}

/** Narrow read-only surface. Anything not on this interface cannot be reached by discovery or the agent. */
export interface AwsReadPort {
  readonly context: AwsContext;
  listStackResources(stack: string): Promise<StackResource[]>;
  listResourcesByTag(key: string, value: string): Promise<TaggedResource[]>;
  describeResource(target: DescribeTarget): Promise<ResourceDetail>;
  /** CloudFormation status of a stack, used as a pre-write health gate. */
  getStackStatus(stack: string): Promise<string>;
}

export class AccessDeniedError extends Error {
  constructor(
    readonly operation: string,
    cause?: unknown,
  ) {
    super(`access denied for ${operation}`, { cause });
    this.name = "AccessDeniedError";
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`not found: ${what}`);
    this.name = "NotFoundError";
  }
}

/** A stack may be changed only when it is settled and not in a failed or rollback state. */
export function isStackHealthy(status: string): boolean {
  return ["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"].includes(status);
}
