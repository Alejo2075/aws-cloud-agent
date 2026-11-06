import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
} from "@aws-sdk/client-cloudformation";
import { authorizeApply, finalizePlan } from "@cloud-agent/changes";
import type { Authorization, ChangeRecord } from "@cloud-agent/changes";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { CfnChangeSetDeployer, EventBridgePublisher } from "./index.js";

const cfn = mockClient(CloudFormationClient);
beforeEach(() => cfn.reset());

const plan = (kind = "update-config", resourceId = "x") =>
  finalizePlan({
    changeId: "chg1",
    systemId: "s",
    environment: "production",
    accountId: "123456789012",
    region: "us-east-1",
    requestedBy: "a",
    intent: "i",
    sourceRevision: "r",
    graphBuiltAt: "2026-11-06T00:00:00.000Z",
    actions: [{ kind, resourceId, description: "d" }],
    steps: ["s"],
    verification: [{ id: "v", description: "d", kind: "test" }],
    rollback: { strategy: "revert", reversible: true, requiresBackup: kind === "delete-resource" },
  });
function auth(p = plan()): Authorization {
  const rec: ChangeRecord = {
    plan: p,
    state: "AWAITING_APPROVAL",
    history: [],
    validation: { passed: true, at: "t", report: "" },
    approval: {
      approvalId: "ap",
      changeId: p.changeId,
      planHash: p.planHash,
      sourceRevision: "r",
      environment: "production",
      accountId: "123456789012",
      region: "us-east-1",
      actor: "bob",
      elevated: true,
      approvedAt: "t",
      expiresAt: "2999-01-01T00:00:00Z",
    },
  };
  const d = authorizeApply(
    rec,
    { sourceRevision: "r", driftDetected: false, healthy: true },
    { writeRoleConfigured: true },
    new Date("2026-11-06T12:00:00Z"),
  );
  if (!d.authorization) throw new Error(d.reasons.join());
  return d.authorization;
}
const deployer = () =>
  new CfnChangeSetDeployer({
    client: new CloudFormationClient({ region: "us-east-1" }),
    accountId: "123456789012",
    region: "us-east-1",
    artifact: async () => ({ stackName: "app", templateBody: "{}" }),
    sleep: async () => undefined,
    maxPolls: 3,
  });

describe("CfnChangeSetDeployer (mocked CloudFormation)", () => {
  it("executes a clean change set and waits for UPDATE_COMPLETE", async () => {
    cfn.on(CreateChangeSetCommand).resolves({});
    cfn.on(DescribeChangeSetCommand).resolves({
      Status: "CREATE_COMPLETE",
      Changes: [
        { ResourceChange: { Action: "Modify", Replacement: "False", LogicalResourceId: "Fn" } },
      ],
    });
    cfn.on(ExecuteChangeSetCommand).resolves({});
    cfn
      .on(DescribeStacksCommand)
      .resolvesOnce({
        Stacks: [{ StackName: "app", CreationTime: new Date(), StackStatus: "UPDATE_IN_PROGRESS" }],
      })
      .resolves({
        Stacks: [{ StackName: "app", CreationTime: new Date(), StackStatus: "UPDATE_COMPLETE" }],
      });
    expect((await deployer().apply(plan(), auth())).status).toBe("succeeded");
    expect(cfn.commandCalls(ExecuteChangeSetCommand)).toHaveLength(1);
    expect(cfn.commandCalls(CreateChangeSetCommand)[0]!.args[0].input.Capabilities).toBeUndefined();
  });

  it("refuses undeclared removals/replacements without executing", async () => {
    cfn.on(CreateChangeSetCommand).resolves({});
    cfn.on(DescribeChangeSetCommand).resolves({
      Status: "CREATE_COMPLETE",
      Changes: [
        {
          ResourceChange: {
            Action: "Modify",
            Replacement: "True",
            LogicalResourceId: "Table",
            ResourceType: "AWS::DynamoDB::Table",
          },
        },
      ],
    });
    cfn.on(DeleteChangeSetCommand).resolves({});
    const r = await deployer().apply(plan(), auth());
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("Table");
    expect(cfn.commandCalls(ExecuteChangeSetCommand)).toHaveLength(0);
    expect(cfn.commandCalls(DeleteChangeSetCommand)).toHaveLength(1);
  });

  it("allows removals only when the plan declared a destructive action", async () => {
    const p = plan("delete-resource", "Old");
    cfn.on(CreateChangeSetCommand).resolves({});
    cfn.on(DescribeChangeSetCommand).resolves({
      Status: "CREATE_COMPLETE",
      Changes: [{ ResourceChange: { Action: "Remove", LogicalResourceId: "Old" } }],
    });
    cfn.on(ExecuteChangeSetCommand).resolves({});
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [{ StackName: "app", CreationTime: new Date(), StackStatus: "UPDATE_COMPLETE" }],
    });
    expect((await deployer().apply(p, auth(p))).status).toBe("succeeded");
  });

  it("scopes a destructive approval to the resources it names", async () => {
    const p = plan("delete-resource", "Old");
    cfn.on(CreateChangeSetCommand).resolves({});
    cfn.on(DescribeChangeSetCommand).resolves({
      Status: "CREATE_COMPLETE",
      Changes: [
        { ResourceChange: { Action: "Remove", LogicalResourceId: "Old" } },
        {
          ResourceChange: {
            Action: "Remove",
            LogicalResourceId: "ProdTable",
            ResourceType: "AWS::DynamoDB::Table",
          },
        },
      ],
    });
    cfn.on(DeleteChangeSetCommand).resolves({});
    const r = await deployer().apply(p, auth(p));
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("ProdTable");
    expect(cfn.commandCalls(ExecuteChangeSetCommand)).toHaveLength(0);
  });

  it("inspects every page of changes and fails closed when a page cannot be read", async () => {
    cfn.on(CreateChangeSetCommand).resolves({});
    cfn.on(DeleteChangeSetCommand).resolves({});
    cfn
      .on(DescribeChangeSetCommand)
      .resolvesOnce({
        Status: "CREATE_COMPLETE",
        NextToken: "p2",
        Changes: [
          { ResourceChange: { Action: "Modify", Replacement: "False", LogicalResourceId: "Fn" } },
        ],
      })
      .resolvesOnce({
        Status: "CREATE_COMPLETE",
        Changes: [{ ResourceChange: { Action: "Remove", LogicalResourceId: "HiddenOnPage2" } }],
      });
    const r = await deployer().apply(plan(), auth());
    expect(r.detail).toContain("HiddenOnPage2");
    expect(cfn.commandCalls(ExecuteChangeSetCommand)).toHaveLength(0);

    cfn.reset();
    cfn.on(CreateChangeSetCommand).resolves({});
    cfn.on(DeleteChangeSetCommand).resolves({});
    cfn
      .on(DescribeChangeSetCommand)
      .resolvesOnce({ Status: "CREATE_COMPLETE", NextToken: "p2", Changes: [] })
      .rejects(new Error("throttled"));
    const failed = await deployer().apply(plan(), auth());
    expect(failed.status).toBe("failed");
    expect(failed.detail).toContain("could not enumerate");
    expect(cfn.commandCalls(ExecuteChangeSetCommand)).toHaveLength(0);
  });

  it("derives a valid, distinct client token from the whole idempotency key", async () => {
    cfn.on(CreateChangeSetCommand).resolves({});
    cfn
      .on(DescribeChangeSetCommand)
      .resolves({ Status: "FAILED", StatusReason: "didn't contain changes" });
    cfn.on(DeleteChangeSetCommand).resolves({});
    await deployer().apply(plan("update-config", "a"), auth(plan("update-config", "a")));
    await deployer().apply(plan("update-config", "b"), auth(plan("update-config", "b")));
    const tokens = cfn.commandCalls(CreateChangeSetCommand).map((c) => c.args[0].input.ClientToken);
    expect(tokens[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("treats an empty change set as success and a rollback as failure with a data warning", async () => {
    cfn.on(CreateChangeSetCommand).resolves({});
    cfn.on(DescribeChangeSetCommand).resolves({
      Status: "FAILED",
      StatusReason: "The submitted information didn't contain changes.",
    });
    cfn.on(DeleteChangeSetCommand).resolves({});
    expect((await deployer().apply(plan(), auth())).detail).toContain("no changes");
    cfn.reset();
    cfn.on(CreateChangeSetCommand).resolves({});
    cfn.on(DescribeChangeSetCommand).resolves({ Status: "CREATE_COMPLETE", Changes: [] });
    cfn.on(ExecuteChangeSetCommand).resolves({});
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        { StackName: "app", CreationTime: new Date(), StackStatus: "UPDATE_ROLLBACK_COMPLETE" },
      ],
    });
    const r = await deployer().apply(plan(), auth());
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("does not restore data");
  });

  it("rejects a mismatched authorization or target before any API call", async () => {
    const other = plan();
    const a = { ...auth(), planHash: "0".repeat(64) } as Authorization;
    expect((await deployer().apply(other, a)).detail).toContain("does not match plan");
    const wrongTarget = { ...auth(), accountId: "999999999999" } as Authorization;
    expect((await deployer().apply(other, wrongTarget)).detail).toContain("differs");
    expect(cfn.calls()).toHaveLength(0);
  });
});

describe("EventBridgePublisher (mocked)", () => {
  const eb = mockClient(EventBridgeClient);
  it("publishes identifiers only and reports rejected entries", async () => {
    eb.reset();
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: "e" }] });
    const pub = new EventBridgePublisher({
      client: new EventBridgeClient({ region: "us-east-1" }),
      eventBusName: "bus",
    });
    const ev = {
      type: "change.state-changed" as const,
      changeId: "c",
      systemId: "s",
      environment: "e",
      accountId: "123456789012",
      region: "us-east-1",
      planHash: "h",
      riskClass: "routine",
      to: "APPLYING",
      at: "t",
    };
    await pub.publish(ev);
    const entry = eb.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries![0]!;
    expect(entry).toMatchObject({
      EventBusName: "bus",
      Source: "cloud-agent",
      DetailType: "change.state-changed",
    });
    expect(JSON.parse(entry.Detail!)).toEqual(ev);
    eb.reset();
    eb.on(PutEventsCommand).resolves({
      FailedEntryCount: 1,
      Entries: [{ ErrorMessage: "denied" }],
    });
    await expect(pub.publish(ev)).rejects.toThrow("denied");
  });
});
