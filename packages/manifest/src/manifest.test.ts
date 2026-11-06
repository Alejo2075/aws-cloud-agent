import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConnectionProfile } from "@cloud-agent/contracts";
import { InMemoryEvidenceStore } from "@cloud-agent/evidence";
import { discoverSystem, restaurantPort } from "@cloud-agent/discovery";
import {
  ManifestError,
  manifestJsonSchema,
  parseManifest,
  reconcileManifest,
  scopeFromManifest,
} from "./index.js";

const manifest = (over: object = {}) =>
  JSON.stringify({
    schemaVersion: "1.0.0",
    kind: "CloudSystemManifest",
    system: { id: "restaurant-app", name: "Restaurant App" },
    environments: [
      {
        name: "production",
        provider: "aws",
        accountId: "123456789012",
        region: "us-east-1",
        stacks: ["restaurant-app-prod"],
        resources: [
          { logicalId: "ReservationsApi", type: "AWS::ApiGatewayV2::Api" },
          { logicalId: "GoneTable", type: "AWS::DynamoDB::Table" },
          { logicalId: "ConfirmFn", type: "AWS::SQS::Queue" },
        ],
      },
    ],
    ...over,
  });

describe("parseManifest", () => {
  it("accepts a valid manifest", () =>
    expect(parseManifest(manifest()).system.id).toBe("restaurant-app"));
  it.each([
    ["bad json", "{"],
    ["wrong kind", manifest({ kind: "Other" })],
    ["future major", manifest({ schemaVersion: "2.0.0" })],
    ["credentials", manifest({ deployment: { artifactRef: "AKIAABCDEFGHIJKLMNOP" } })],
  ])("rejects %s", (_n, input) => expect(() => parseManifest(input)).toThrow(ManifestError));
});

describe("reconcileManifest", () => {
  it("lets live discovery win", async () => {
    const profile = ConnectionProfile.parse({
      connectionId: "c",
      ...scopeFromManifest(parseManifest(manifest()), "production"),
      ownerIdentity: "u",
      roles: { "read-only": "arn:aws:iam::123456789012:role/ro" },
    });
    const graph = await discoverSystem(profile, restaurantPort(), new InMemoryEvidenceStore());
    const r = reconcileManifest(parseManifest(manifest()), "production", graph);
    expect(r.confirmed.map((c) => c.logicalId)).toEqual(["ReservationsApi"]);
    expect(r.missing.map((c) => c.logicalId)).toEqual(["GoneTable"]);
    expect(r.typeMismatches[0]).toMatchObject({
      logicalId: "ConfirmFn",
      liveType: "AWS::Lambda::Function",
    });
    expect(r.unexpected.length).toBeGreaterThan(0);
    expect(r.source).toBe("imported-manifest");
  });
});

describe("published JSON Schema", () => {
  it("matches the committed docs file", () => {
    const committed = JSON.parse(
      readFileSync(
        new URL("../../../docs/integration/cloud-system-manifest.schema.json", import.meta.url),
        "utf8",
      ),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(manifestJsonSchema())));
  });
});
