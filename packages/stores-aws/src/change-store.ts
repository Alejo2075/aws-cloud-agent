import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { ChangeRecord, ChangeStore } from "@cloud-agent/changes";

/** DynamoDB item limit is 400 KB; refuse to write a record that would be silently rejected or truncated. */
const MAX_BYTES = 380 * 1024;

/**
 * Table: partition key `changeId` (S); global index `byIdempotencyKey` on `idempotencyKey` (S).
 * The record is stored as one JSON string so its shape can evolve without DynamoDB marshalling surprises.
 */
export class DynamoDbChangeStore implements ChangeStore {
  constructor(
    private readonly db: DynamoDBClient,
    private readonly table: string,
  ) {}

  async get(changeId: string) {
    const r = await this.db.send(
      new GetItemCommand({
        TableName: this.table,
        Key: { changeId: { S: changeId } },
        ConsistentRead: true,
      }),
    );
    const body = r.Item?.record?.S;
    return body ? (JSON.parse(body) as ChangeRecord) : undefined;
  }

  async put(rec: ChangeRecord) {
    const body = JSON.stringify(rec);
    if (Buffer.byteLength(body) > MAX_BYTES)
      throw new Error("change record exceeds the DynamoDB item size limit; reduce the patch size");
    await this.db.send(
      new PutItemCommand({
        TableName: this.table,
        Item: {
          changeId: { S: rec.plan.changeId },
          record: { S: body },
          state: { S: rec.state },
          ...(rec.execution && { idempotencyKey: { S: rec.execution.idempotencyKey } }),
        },
      }),
    );
  }

  async list() {
    const out: ChangeRecord[] = [];
    let key: Record<string, never> | undefined;
    do {
      const r = await this.db.send(
        new ScanCommand({
          TableName: this.table,
          ConsistentRead: true,
          ...(key && { ExclusiveStartKey: key }),
        }),
      );
      for (const i of r.Items ?? []) if (i.record?.S) out.push(JSON.parse(i.record.S));
      key = r.LastEvaluatedKey as typeof key;
    } while (key);
    return out;
  }

  async findExecution(key: string) {
    const r = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "byIdempotencyKey",
        KeyConditionExpression: "idempotencyKey = :k",
        ExpressionAttributeValues: { ":k": { S: key } },
        Limit: 1,
      }),
    );
    const id = r.Items?.[0]?.changeId?.S;
    // The index is eventually consistent; confirm against the base table before trusting it.
    return id ? this.get(id) : undefined;
  }
}
