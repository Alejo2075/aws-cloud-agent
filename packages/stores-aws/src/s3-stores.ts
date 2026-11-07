import { randomUUID } from "node:crypto";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { SystemGraph } from "@cloud-agent/contracts";
import type { Observation } from "@cloud-agent/contracts";
import { redact } from "@cloud-agent/evidence";
import type { EvidenceStore, NewObservation } from "@cloud-agent/evidence";
import { graphKeyPath } from "@cloud-agent/graph";
import type { GraphKey, GraphStore } from "@cloud-agent/graph";

async function text(s3: S3Client, bucket: string, key: string): Promise<string | undefined> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return await r.Body?.transformToString();
  } catch (e) {
    if ((e as { name?: string }).name === "NoSuchKey") return undefined;
    throw e;
  }
}

const put = (s3: S3Client, bucket: string, key: string, body: string) =>
  s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
    }),
  );

const prefixed = (prefix: string, key: string) => `${prefix.replace(/\/+$/, "")}/${key}`;

/** Account/region/system/environment stay in the object key, so IAM can scope access by prefix. */
export class S3GraphStore implements GraphStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly prefix = "graphs",
  ) {}
  async save(graph: SystemGraph) {
    await put(
      this.s3,
      this.bucket,
      prefixed(this.prefix, graphKeyPath(graph).split("\\").join("/")),
      JSON.stringify(SystemGraph.parse(graph)),
    );
  }
  async load(key: GraphKey) {
    const body = await text(
      this.s3,
      this.bucket,
      prefixed(this.prefix, graphKeyPath(key).split("\\").join("/")),
    );
    return body ? SystemGraph.parse(JSON.parse(body)) : undefined;
  }
}

/** One redacted JSON object per observation under `<prefix>/<scope>/`. */
export class S3EvidenceStore implements EvidenceStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly prefix: string,
  ) {}

  async record(input: NewObservation, payload: unknown, now = new Date()): Promise<Observation> {
    const id = `obs-${randomUUID()}`;
    const obs: Observation = {
      id,
      source: input.source,
      ...(input.resource !== undefined && { resource: input.resource }),
      ...(input.timeRange !== undefined && { timeRange: input.timeRange }),
      observedAt: now.toISOString(),
      evidenceRef: `artifact://observations/${id}`,
      confidence: input.confidence ?? "high",
      limitations: input.limitations ?? [],
    };
    await put(
      this.s3,
      this.bucket,
      prefixed(this.prefix, `${id}.json`),
      JSON.stringify({ observation: obs, payload: redact(payload) }),
    );
    return obs;
  }

  async getPayload(evidenceRef: string) {
    const id = evidenceRef.replace("artifact://observations/", "");
    if (!/^obs-[0-9a-f-]{36}$/.test(id)) throw new Error("invalid evidence ref");
    const body = await text(this.s3, this.bucket, prefixed(this.prefix, `${id}.json`));
    if (!body) throw new Error(`unknown evidence ref ${evidenceRef}`);
    return JSON.parse(body).payload;
  }

  async list() {
    const out: Observation[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${this.prefix.replace(/\/+$/, "")}/`,
          ...(token && { ContinuationToken: token }),
        }),
      );
      for (const o of r.Contents ?? []) {
        const body = o.Key ? await text(this.s3, this.bucket, o.Key) : undefined;
        if (body) out.push(JSON.parse(body).observation);
      }
      token = r.NextContinuationToken;
    } while (token);
    return out;
  }
}
