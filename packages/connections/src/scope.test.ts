import { describe, expect, it } from "vitest";
import { ConnectionProfile } from "@cloud-agent/contracts";
import { evaluateScope } from "./scope.js";

const profile = ConnectionProfile.parse({
  connectionId: "c1",
  systemId: "restaurant-app",
  ownerIdentity: "user-1",
  environment: "production",
  accountId: "123456789012",
  region: "us-east-1",
  scope: {
    stacks: ["restaurant-app-prod"],
    resourceArns: ["arn:aws:s3:::assets-bucket"],
    tags: [{ key: "system", value: "restaurant-app" }],
  },
  roles: { "read-only": "arn:aws:iam::123456789012:role/CloudAgentReadOnly" },
});

describe("evaluateScope", () => {
  it("allows members of an approved stack", () => {
    expect(evaluateScope(profile, { stack: "restaurant-app-prod" }).allowed).toBe(true);
  });
  it("allows tagged resources and explicit ARNs", () => {
    expect(evaluateScope(profile, { tags: { system: "restaurant-app" } }).allowed).toBe(true);
    expect(evaluateScope(profile, { arn: "arn:aws:s3:::assets-bucket" }).allowed).toBe(true);
  });
  it("denies by default", () => {
    expect(evaluateScope(profile, { stack: "other" }).allowed).toBe(false);
    expect(evaluateScope(profile, {}).allowed).toBe(false);
  });
  it("denies cross-account and cross-region ARNs even if the stack matches", () => {
    const other = "arn:aws:lambda:us-east-1:999999999999:function:f";
    expect(evaluateScope(profile, { arn: other, stack: "restaurant-app-prod" }).allowed).toBe(
      false,
    );
    const region = "arn:aws:lambda:eu-west-1:123456789012:function:f";
    expect(evaluateScope(profile, { arn: region, stack: "restaurant-app-prod" }).allowed).toBe(
      false,
    );
  });
  it("rejects an empty scope at parse time", () => {
    expect(() => ConnectionProfile.parse({ ...profile, scope: {} })).toThrow();
  });
});
