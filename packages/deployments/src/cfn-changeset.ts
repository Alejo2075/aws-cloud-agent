import { createHash } from "node:crypto";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
} from "@aws-sdk/client-cloudformation";
import type { Authorization, ChangePlan, DeployResult, Deployer } from "@cloud-agent/changes";

export interface TemplateArtifact {
  stackName: string;
  /** Template produced by the validated build (e.g. cdk synth output), never free-form model text. */
  templateBody: string;
}

export interface CfnDeployerOptions {
  client: CloudFormationClient;
  /** Account/region the (write-role) client is bound to; must equal the authorization target. */
  accountId: string;
  region: string;
  artifact(plan: ChangePlan): Promise<TemplateArtifact>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
}

const MAX_CHANGE_PAGES = 50;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Applies a template through a CloudFormation change set. The change set is inspected before execution:
 * removals and replacements must have been declared in the approved plan, otherwise nothing is executed.
 */
export class CfnChangeSetDeployer implements Deployer {
  constructor(private readonly o: CfnDeployerOptions) {}

  async apply(plan: ChangePlan, auth: Authorization): Promise<DeployResult> {
    if (auth.planHash !== plan.planHash || auth.changeId !== plan.changeId)
      return { status: "failed", detail: "authorization does not match plan" };
    if (
      auth.accountId !== this.o.accountId ||
      auth.region !== this.o.region ||
      plan.accountId !== this.o.accountId ||
      plan.region !== this.o.region
    ) {
      return {
        status: "failed",
        detail: "authorization target differs from the deployer's account/region",
      };
    }
    const sleep = this.o.sleep ?? wait;
    const pollMs = this.o.pollMs ?? 5000;
    const maxPolls = this.o.maxPolls ?? 120;
    const { stackName, templateBody } = await this.o.artifact(plan);
    const name = `ca-${plan.changeId}-${plan.planHash.slice(0, 8)}`
      .replace(/[^A-Za-z0-9-]/g, "-")
      .slice(0, 128);
    const iamAllowed = plan.actions.some((a) => a.kind === "iam-expansion");

    await this.o.client.send(
      new CreateChangeSetCommand({
        StackName: stackName,
        ChangeSetName: name,
        ChangeSetType: "UPDATE",
        TemplateBody: templateBody,
        ...(iamAllowed && { Capabilities: ["CAPABILITY_IAM"] }),
        // Hash of the full key (change, plan hash, account, region, environment): distinct per change, valid charset.
        ClientToken: createHash("sha256").update(auth.idempotencyKey).digest("hex"),
      }),
    );

    let cs;
    for (let i = 0; i < maxPolls; i++) {
      cs = await this.o.client.send(
        new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: name }),
      );
      if (cs.Status === "CREATE_COMPLETE" || cs.Status === "FAILED") break;
      await sleep(pollMs);
    }
    if (!cs || (cs.Status !== "CREATE_COMPLETE" && cs.Status !== "FAILED"))
      return { status: "failed", detail: "timed out waiting for the change set to be created" };
    if (cs.Status === "FAILED") {
      const noChanges = /didn't contain changes|no updates/i.test(cs.StatusReason ?? "");
      await this.o.client
        .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: name }))
        .catch(() => undefined);
      return noChanges
        ? {
            status: "succeeded",
            detail: "change set contained no changes; stack already matches the template",
          }
        : { status: "failed", detail: `change set failed: ${cs.StatusReason ?? "unknown"}` };
    }

    // Enumerate EVERY page of changes before judging risk; if that is impossible, fail closed.
    const changes = [...(cs.Changes ?? [])];
    try {
      let next = cs.NextToken;
      for (let pages = 0; next; pages++) {
        if (pages >= MAX_CHANGE_PAGES) throw new Error("change set has too many pages to inspect");
        const page = await this.o.client.send(
          new DescribeChangeSetCommand({
            StackName: stackName,
            ChangeSetName: name,
            NextToken: next,
          }),
        );
        changes.push(...(page.Changes ?? []));
        next = page.NextToken;
      }
    } catch (e) {
      await this.o.client
        .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: name }))
        .catch(() => undefined);
      return {
        status: "failed",
        detail: `refused: could not enumerate every change in the change set (${(e as Error).message}); nothing was executed`,
      };
    }

    // Each removal/replacement must be individually declared by a destructive action in the approved plan.
    const declared = plan.actions
      .filter((a) => a.kind === "delete-resource" || a.kind === "data-migration")
      .map((a) => a.resourceId);
    const undeclared = changes.filter((c) => {
      const rc = c.ResourceChange;
      const risky =
        rc?.Action === "Remove" || rc?.Replacement === "True" || rc?.Replacement === "Conditional";
      if (!risky) return false;
      const ids = [rc?.LogicalResourceId, rc?.PhysicalResourceId].filter((x): x is string => !!x);
      return !ids.some((id) =>
        declared.some((d) => d === id || d.endsWith(`/${id}`) || d.endsWith(`:${id}`)),
      );
    });
    if (undeclared.length) {
      await this.o.client
        .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: name }))
        .catch(() => undefined);
      const list = undeclared
        .map(
          (c) =>
            `${c.ResourceChange?.Action} ${c.ResourceChange?.LogicalResourceId} (${c.ResourceChange?.ResourceType})`,
        )
        .join(", ");
      return {
        status: "failed",
        detail: `refused: change set removes or replaces resources the approved plan did not individually declare: ${list}`,
      };
    }

    await this.o.client.send(
      new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName: name }),
    );
    for (let i = 0; i < maxPolls; i++) {
      const s =
        (await this.o.client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]
          ?.StackStatus ?? "UNKNOWN";
      if (s === "UPDATE_COMPLETE")
        return { status: "succeeded", detail: `stack ${stackName} reached UPDATE_COMPLETE` };
      if (s === "UPDATE_ROLLBACK_COMPLETE")
        return {
          status: "failed",
          detail: `stack ${stackName} rolled back (UPDATE_ROLLBACK_COMPLETE); rollback does not restore data or external side effects`,
        };
      if (s === "UPDATE_ROLLBACK_FAILED" || s === "UPDATE_FAILED")
        return {
          status: "partial",
          detail: `stack ${stackName} is ${s}; manual intervention required`,
        };
      await sleep(pollMs);
    }
    return {
      status: "partial",
      detail: `stack ${stackName} did not settle within the polling budget; check CloudFormation before retrying`,
    };
  }
}
