import { describe, expect, it } from "vitest";
import { ConnectionProfile } from "@cloud-agent/contracts";
import { InMemoryEvidenceStore } from "@cloud-agent/evidence";
import { AccessDeniedError } from "@cloud-agent/tools-aws";
import { discoverSystem, ScopeMismatchError } from "./discover.js";
import { A, FakeAwsReadPort, restaurantPort } from "./fixture.js";

const profile = (scope: object = { stacks: ["restaurant-app-prod"] }) =>
  ConnectionProfile.parse({
    connectionId: "c",
    systemId: "restaurant-app",
    ownerIdentity: "u",
    environment: "production",
    accountId: "123456789012",
    region: "us-east-1",
    scope,
    roles: { "read-only": "arn:aws:iam::123456789012:role/ro" },
  });

describe("discoverSystem", () => {
  it("builds a graph with provenance-tagged edges", async () => {
    const g = await discoverSystem(profile(), restaurantPort(), new InMemoryEvidenceStore());
    expect(g.resources).toHaveLength(7);
    const edge = (from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);
    expect(edge(A.api, A.create)).toMatchObject({ kind: "invokes", provenance: "discovery" });
    expect(edge(A.confirm, A.queue)).toMatchObject({
      kind: "subscribes-to",
      provenance: "discovery",
    });
    expect(edge(A.queue, A.dlq)).toMatchObject({ kind: "writes-to" });
    expect(edge(A.create, A.table)).toMatchObject({ kind: "depends-on", provenance: "inferred" });
    expect(edge(A.create, A.queue)?.rationale).toContain("QUEUE_URL");
    expect(g.edges.every((e) => e.evidence.length > 0)).toBe(true);
  });

  it("reports gaps instead of following out-of-scope links", async () => {
    const g = await discoverSystem(profile(), restaurantPort(), new InMemoryEvidenceStore());
    expect(g.gaps.some((x) => x.includes("not-in-scope"))).toBe(true);
    expect(g.gaps.some((x) => x.includes("AWS::IAM::Role"))).toBe(true);
    expect(g.gaps.some((x) => x.includes("tracing"))).toBe(true);
    expect(g.edges.some((e) => e.to.includes("not-in-scope"))).toBe(false);
  });

  it("never persists env var values", async () => {
    const ev = new InMemoryEvidenceStore();
    await discoverSystem(profile(), restaurantPort(), ev);
    const blob = JSON.stringify(
      await Promise.all((await ev.list()).map((o) => ev.getPayload(o.evidenceRef))),
    );
    expect(blob).not.toContain("https://sqs");
  });

  it("turns access denied into a gap with low-confidence evidence", async () => {
    const ev = new InMemoryEvidenceStore();
    const g = await discoverSystem(
      profile(),
      restaurantPort({ [A.table]: new AccessDeniedError("dynamodb:DescribeTable") }),
      ev,
    );
    expect(g.gaps.some((x) => x.includes("dynamodb:DescribeTable"))).toBe(true);
    expect((await ev.list()).some((o) => o.confidence === "low")).toBe(true);
  });

  it("refuses credentials for another account or region", async () => {
    const other = new FakeAwsReadPort({ accountId: "999999999999", region: "us-east-1" }, {});
    await expect(
      discoverSystem(profile(), other, new InMemoryEvidenceStore()),
    ).rejects.toBeInstanceOf(ScopeMismatchError);
  });

  it("honors the resource budget", async () => {
    const g = await discoverSystem(profile(), restaurantPort(), new InMemoryEvidenceStore(), {
      maxResources: 3,
    });
    expect(g.resources).toHaveLength(3);
    expect(g.gaps.some((x) => x.includes("budget"))).toBe(true);
  });

  it("drops tag-found resources in another account", async () => {
    const port = new FakeAwsReadPort(
      { accountId: "123456789012", region: "us-east-1" },
      {},
      {},
      {
        "system=x": [{ arn: "arn:aws:sqs:us-east-1:999999999999:q", tags: { system: "x" } }],
      },
    );
    const g = await discoverSystem(
      profile({ tags: [{ key: "system", value: "x" }] }),
      port,
      new InMemoryEvidenceStore(),
    );
    expect(g.resources).toHaveLength(0);
    expect(g.gaps.some((x) => x.includes("outside the approved scope"))).toBe(true);
  });
});
