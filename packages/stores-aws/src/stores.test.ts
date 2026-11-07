import { describe, expect, it } from "vitest";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { verifyChain } from "@cloud-agent/evidence";
import type { AuditRecord } from "@cloud-agent/evidence";
import { DynamoDbAuditLog, DynamoDbChangeStore, S3EvidenceStore, S3GraphStore } from "./index.js";

const ddb = mockClient(DynamoDBClient);
const s3 = mockClient(S3Client);
const db = new DynamoDBClient({ region: "us-east-1" });
const s3c = new S3Client({ region: "us-east-1" });

describe("DynamoDbChangeStore", () => {
  const rec = {
    plan: { changeId: "c1" },
    state: "AWAITING_APPROVAL",
    history: [],
    execution: { idempotencyKey: "k1" },
  } as never;

  it("round-trips a record, indexes the idempotency key, and re-reads the base table", async () => {
    ddb.reset();
    ddb.on(PutItemCommand).resolves({});
    const store = new DynamoDbChangeStore(db, "changes");
    await store.put(rec);
    const item = ddb.commandCalls(PutItemCommand)[0]?.args[0].input.Item;
    expect(item).toMatchObject({ changeId: { S: "c1" }, idempotencyKey: { S: "k1" } });
    ddb.on(GetItemCommand).resolves({ Item: item! });
    ddb.on(QueryCommand).resolves({ Items: [item!] });
    expect((await store.get("c1"))?.plan.changeId).toBe("c1");
    expect((await store.findExecution("k1"))?.plan.changeId).toBe("c1");
  });

  it("refuses records that would exceed the item size limit", async () => {
    ddb.reset();
    const big = { ...(rec as object), blob: "x".repeat(400 * 1024) } as never;
    await expect(new DynamoDbChangeStore(db, "changes").put(big)).rejects.toThrow("size limit");
    expect(ddb.commandCalls(PutItemCommand)).toHaveLength(0);
  });
});

describe("DynamoDbAuditLog", () => {
  it("chains records and retries after losing a race, never forking", async () => {
    ddb.reset();
    const stored: AuditRecord[] = [];
    const first = new DynamoDbAuditLog(db, "audit");
    ddb.on(QueryCommand).callsFake(async () => ({
      Items: stored.length
        ? [{ seq: { N: String(stored.length) }, record: { S: JSON.stringify(stored.at(-1)) } }]
        : [],
    }));
    let conflicts = 1;
    ddb.on(PutItemCommand).callsFake(async (input) => {
      if (conflicts-- > 0) {
        const e = new Error("conflict");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      stored.push(JSON.parse(input.Item.record.S));
    });
    const a = await first.append({ actor: "a", action: "x", systemId: "s", outcome: "ok" });
    const b = await first.append({ actor: "a", action: "y", systemId: "s", outcome: "ok" });
    expect(b.prevHash).toBe(a.hash);
    expect(verifyChain(stored)).toEqual({ ok: true });
    expect(ddb.commandCalls(PutItemCommand)[0]?.args[0].input.ConditionExpression).toContain(
      "attribute_not_exists",
    );
  });

  it("gives up rather than writing out of order", async () => {
    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(PutItemCommand).callsFake(async () => {
      const e = new Error("conflict");
      e.name = "ConditionalCheckFailedException";
      throw e;
    });
    await expect(
      new DynamoDbAuditLog(db, "audit").append({
        actor: "a",
        action: "x",
        systemId: "s",
        outcome: "ok",
      }),
    ).rejects.toThrow("lost the race");
  });
});

describe("S3 stores", () => {
  it("keeps account/region/system/environment in the graph key and encrypts at rest", async () => {
    s3.reset();
    s3.on(PutObjectCommand).resolves({});
    const graph = {
      systemId: "app",
      environment: "prod",
      accountId: "123456789012",
      region: "us-east-1",
      builtAt: "2026-11-06T00:00:00.000Z",
      resources: [],
      edges: [],
      gaps: [],
    };
    const store = new S3GraphStore(s3c, "b");
    await store.save(graph);
    const call = s3.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(call?.Key).toBe("graphs/123456789012/us-east-1/app/prod.json");
    expect(call?.ServerSideEncryption).toBe("AES256");
    s3.on(GetObjectCommand).resolves({
      Body: { transformToString: async () => String(call?.Body) } as never,
    });
    const key = {
      accountId: "123456789012",
      region: "us-east-1",
      systemId: "app",
      environment: "prod",
    };
    expect(await store.load(key)).toMatchObject({ systemId: "app" });
    s3.on(GetObjectCommand).rejects(Object.assign(new Error("n"), { name: "NoSuchKey" }));
    expect(await store.load({ ...key, systemId: "other" })).toBeUndefined();
  });

  it("redacts evidence before writing and rejects malformed refs", async () => {
    s3.reset();
    s3.on(PutObjectCommand).resolves({});
    const store = new S3EvidenceStore(s3c, "b", "evidence/app");
    const obs = await store.record({ source: "test" }, { token: "AKIAABCDEFGHIJKLMNOP" });
    const body = String(s3.commandCalls(PutObjectCommand)[0]?.args[0].input.Body);
    expect(body).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(s3.commandCalls(PutObjectCommand)[0]?.args[0].input.Key).toBe(
      `evidence/app/${obs.id}.json`,
    );
    await expect(store.getPayload("artifact://observations/../../x")).rejects.toThrow("invalid");
    s3.on(GetObjectCommand).rejects(Object.assign(new Error("n"), { name: "NoSuchKey" }));
    await expect(store.getPayload(obs.evidenceRef)).rejects.toThrow("unknown evidence ref");
  });
});
