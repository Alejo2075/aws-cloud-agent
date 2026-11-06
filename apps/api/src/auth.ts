import type { Action, Principal } from "./types.js";

export interface Authenticator {
  /** Verify the caller's credentials (e.g. a JWT) and return their principal, or undefined. */
  authenticate(headers: Record<string, string | undefined>): Promise<Principal | undefined>;
}

export interface Authorizer {
  can(
    principal: Principal,
    target: { systemId: string; environment: string },
    action: Action,
  ): boolean;
}

/** Authorizer driven by the principal's explicit grants. Anything not granted is denied. */
export const grantAuthorizer: Authorizer = {
  can(principal, target, action) {
    return principal.grants.some(
      (g) =>
        g.systemId === target.systemId &&
        (!g.environment || g.environment === target.environment) &&
        g.actions.includes(action),
    );
  },
};

/** Fixed-window limiter keyed by principal; replace with a shared store when running several instances. */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  allow(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t - h.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 });
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }
}
