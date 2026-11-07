import { z } from "zod";

export const AwsAccountId = z.string().regex(/^\d{12}$/, "AWS account id must be 12 digits");
export const AwsRegion = z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "invalid AWS region");

/** Explicit selectors that bound what Cloud Agent may discover. An empty selector set matches nothing. */
export const ScopeSelectors = z
  .object({
    stacks: z.array(z.string().min(1)).default([]),
    resourceArns: z.array(z.string().startsWith("arn:")).default([]),
    tags: z.array(z.object({ key: z.string().min(1), value: z.string() })).default([]),
  })
  .refine((s) => s.stacks.length + s.resourceArns.length + s.tags.length > 0, {
    message: "scope must declare at least one stack, ARN, or tag selector",
  });
export type ScopeSelectors = z.infer<typeof ScopeSelectors>;

export const AccessLevel = z.enum(["read-only", "change-planning", "write"]);
export type AccessLevel = z.infer<typeof AccessLevel>;

/** Each access level has its own role ARN; only read-only is required. */
export const RoleSet = z.object({
  "read-only": z.string().startsWith("arn:aws:iam::"),
  "change-planning": z.string().startsWith("arn:aws:iam::").optional(),
  write: z.string().startsWith("arn:aws:iam::").optional(),
});
export type RoleSet = z.infer<typeof RoleSet>;

/** Explicitly linked source repository (a local checkout). Linking is opt-in per connection. */
export const RepositoryLink = z.object({
  path: z.string().min(1),
  iacRoot: z.string().optional(),
  defaultBranch: z.string().optional(),
});
export type RepositoryLink = z.infer<typeof RepositoryLink>;

export const ConnectionProfile = z.object({
  connectionId: z.string().min(1),
  systemId: z.string().min(1),
  ownerIdentity: z.string().min(1),
  environment: z.string().min(1),
  accountId: AwsAccountId,
  region: AwsRegion,
  scope: ScopeSelectors,
  roles: RoleSet,
  /** Allows log message content to reach the model. Off by default: telemetry can contain PII. */
  sensitiveDataAccess: z.boolean().default(false),
  /** Allows Cost Explorer queries scoped to the connection's tag selector. */
  costDataAccess: z.boolean().default(false),
  repository: RepositoryLink.optional(),
  /** Optional EventBridge bus that receives change lifecycle events (identifiers and states only). */
  eventBusName: z.string().min(1).optional(),
  /** Exact hostnames that `http` verification criteria may call (HTTPS only). Empty means none: no outbound checks. */
  verificationHosts: z.array(z.string().min(1)).default([]),
  lastDiscoveryAt: z.iso.datetime().optional(),
});
export type ConnectionProfile = z.infer<typeof ConnectionProfile>;
