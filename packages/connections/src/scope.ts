import type { ConnectionProfile } from "@cloud-agent/contracts";

export interface ResourceRef {
  arn?: string;
  stack?: string;
  tags?: Record<string, string>;
}

export interface ScopeDecision {
  allowed: boolean;
  reason: string;
}

/** Parse the account and region out of an ARN; global services may leave region empty. */
function parseArn(arn: string): { region: string; account: string } | undefined {
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") return undefined;
  return { region: parts[3] ?? "", account: parts[4] ?? "" };
}

/**
 * Decide whether a resource is inside a connection's approved scope.
 * Deny by default: a resource must match an explicit selector AND sit in the connection's account/region.
 */
export function evaluateScope(profile: ConnectionProfile, ref: ResourceRef): ScopeDecision {
  if (ref.arn) {
    const parsed = parseArn(ref.arn);
    if (!parsed) return { allowed: false, reason: "malformed ARN" };
    if (parsed.account && parsed.account !== profile.accountId) {
      return { allowed: false, reason: "ARN belongs to a different account" };
    }
    if (parsed.region && parsed.region !== profile.region) {
      return { allowed: false, reason: "ARN belongs to a different region" };
    }
  }
  const { stacks, resourceArns, tags } = profile.scope;
  if (ref.arn && resourceArns.includes(ref.arn)) {
    return { allowed: true, reason: "matched explicit resource ARN" };
  }
  if (ref.stack && stacks.includes(ref.stack)) {
    return { allowed: true, reason: `member of approved stack ${ref.stack}` };
  }
  const hit = tags.find((t) => ref.tags?.[t.key] === t.value);
  if (hit) return { allowed: true, reason: `matched tag ${hit.key}=${hit.value}` };
  return { allowed: false, reason: "no scope selector matched" };
}
