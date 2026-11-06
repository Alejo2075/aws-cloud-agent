import { describe, expect, it } from "vitest";
import type { SystemGraph } from "@cloud-agent/contracts";
import { FileGraphStore, impactOf, InMemoryGraphStore, summarize } from "./index.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const at = "2026-11-06T00:00:00.000Z";
const res = (id: string, type: string) => ({
  id,
  type,
  tags: {},
  provenance: "discovery" as const,
  observedAt: at,
});
const graph: SystemGraph = {
  systemId: "s",
  environment: "prod",
  accountId: "123456789012",
  region: "us-east-1",
  builtAt: at,
  resources: [
    res("api", "AWS::ApiGatewayV2::Api"),
    res("fn", "AWS::Lambda::Function"),
    res("q", "AWS::SQS::Queue"),
  ],
  edges: [
    { from: "api", to: "fn", kind: "invokes", provenance: "discovery", evidence: ["o1"] },
    {
      from: "fn",
      to: "q",
      kind: "writes-to",
      provenance: "inferred",
      evidence: [],
      rationale: "env var",
    },
  ],
  gaps: ["no tracing"],
};

describe("impactOf", () => {
  it("walks upstream transitively and flags inferred paths", () => {
    const hits = impactOf(graph, "q");
    expect(hits.map((h) => h.resourceId).sort()).toEqual(["api", "fn"]);
    expect(hits.every((h) => h.hasInferred)).toBe(true);
  });
  it("terminates on cycles", () => {
    const cyc = {
      ...graph,
      edges: [
        ...graph.edges,
        {
          from: "q",
          to: "api",
          kind: "invokes" as const,
          provenance: "discovery" as const,
          evidence: [],
        },
      ],
    };
    expect(impactOf(cyc, "q")).toHaveLength(2);
  });
});

describe("stores", () => {
  it("round-trips and isolates by account", async () => {
    const mem = new InMemoryGraphStore();
    await mem.save(graph);
    expect(await mem.load(graph)).toEqual(graph);
    expect(await mem.load({ ...graph, accountId: "999999999999" })).toBeUndefined();
    const file = new FileGraphStore(await mkdtemp(join(tmpdir(), "g-")));
    await file.save(graph);
    expect(await file.load(graph)).toEqual(graph);
    expect(await file.load({ ...graph, environment: "dev" })).toBeUndefined();
  });
  it("summarizes", () => {
    expect(summarize(graph)).toMatchObject({
      resourceCount: 3,
      edgeCount: 2,
      inferredEdgeCount: 1,
    });
  });
});
