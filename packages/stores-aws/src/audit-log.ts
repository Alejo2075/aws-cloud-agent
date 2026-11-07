import { PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GENESIS, sealAuditRecord } from "@cloud-agent/evidence";
import type { AuditInput, AuditLog, AuditRecord } from "@cloud-agent/evidence";

/**
 * Hash-chained audit log on DynamoDB. Table: partition key `chain` (S), sort key `seq` (N).
 * Appends use a conditional write on the next sequence number, so two writers can never fork the chain;
 * the loser re-reads the tail and retries.
 */
export class DynamoDbAuditLog implements AuditLog {
  constructor(
    private readonly db: DynamoDBClient,
    private readonly table: string,
    private readonly chain = "audit",
  ) {}

  private async tail(): Promise<{ seq: number; hash: string }> {
    const r = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "chain = :c",
        ExpressionAttributeValues: { ":c": { S: this.chain } },
        ScanIndexForward: false,
        Limit: 1,
        ConsistentRead: true,
      }),
    );
    const it = r.Items?.[0];
    return it
      ? { seq: Number(it.seq?.N), hash: JSON.parse(it.record?.S ?? "{}").hash }
      : { seq: 0, hash: GENESIS };
  }

  async append(input: AuditInput, now = new Date()): Promise<AuditRecord> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const t = await this.tail();
      const rec = sealAuditRecord(input, t.hash, now);
      try {
        await this.db.send(
          new PutItemCommand({
            TableName: this.table,
            Item: {
              chain: { S: this.chain },
              seq: { N: String(t.seq + 1) },
              record: { S: JSON.stringify(rec) },
            },
            ConditionExpression: "attribute_not_exists(seq)",
          }),
        );
        return rec;
      } catch (e) {
        if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
      }
    }
    throw new Error("audit append lost the race too many times; not recording out of order");
  }

  async read(): Promise<AuditRecord[]> {
    const out: AuditRecord[] = [];
    let key: Record<string, never> | undefined;
    do {
      const r = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "chain = :c",
          ExpressionAttributeValues: { ":c": { S: this.chain } },
          ConsistentRead: true,
          ...(key && { ExclusiveStartKey: key }),
        }),
      );
      for (const i of r.Items ?? []) if (i.record?.S) out.push(JSON.parse(i.record.S));
      key = r.LastEvaluatedKey as typeof key;
    } while (key);
    return out;
  }
}
