import { z } from "zod";
import { AwsAccountId, AwsRegion } from "@cloud-agent/contracts";

export const MANIFEST_SCHEMA_VERSION = "1.0.0";

export const CloudSystemManifest = z.object({
  schemaVersion: z
    .string()
    .regex(/^1\.\d+\.\d+$/, "unsupported schemaVersion (this reader supports 1.x)"),
  kind: z.literal("CloudSystemManifest"),
  system: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  source: z
    .object({ repositoryUrl: z.url().optional(), revision: z.string().optional() })
    .optional(),
  environments: z
    .array(
      z.object({
        name: z.string().min(1),
        provider: z.literal("aws"),
        accountId: AwsAccountId,
        region: AwsRegion,
        stacks: z.array(z.string().min(1)).default([]),
        resources: z
          .array(z.object({ logicalId: z.string().min(1), type: z.string().min(1) }))
          .default([]),
      }),
    )
    .min(1),
  deployment: z
    .object({
      iac: z.string().optional(),
      artifactRef: z.string().optional(),
      verifiedAt: z.iso.datetime().optional(),
    })
    .optional(),
});
export type CloudSystemManifest = z.infer<typeof CloudSystemManifest>;

const SECRET_LIKE =
  /(AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"(secret|password|token|apiKey)"\s*:/i;

export class ManifestError extends Error {}

/** Parse untrusted manifest JSON. Manifests must not carry credentials; reject ones that appear to. */
export function parseManifest(json: string): CloudSystemManifest {
  if (SECRET_LIKE.test(json))
    throw new ManifestError(
      "manifest appears to contain credentials or secret fields; refusing to import",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ManifestError("manifest is not valid JSON");
  }
  const r = CloudSystemManifest.safeParse(raw);
  if (!r.success)
    throw new ManifestError(
      `invalid CloudSystemManifest: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return r.data;
}

export function manifestJsonSchema() {
  return {
    $id: "https://github.com/Alejo2075/aws-cloud-agent/docs/integration/cloud-system-manifest.schema.json",
    ...z.toJSONSchema(CloudSystemManifest),
  };
}
