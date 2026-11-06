import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  StartBuildCommand,
} from "@aws-sdk/client-codebuild";
import type { ChangePlan, Validator } from "@cloud-agent/changes";

export interface CodeBuildOptions {
  client: CodeBuildClient;
  /** Project configured by you with a least-privilege service role and no production credentials. */
  projectName: string;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs validation in an ephemeral CodeBuild build pinned to the plan's source revision.
 * Only identifiers (change id, plan hash) are passed in; no secrets or model-written commands are.
 */
export class CodeBuildValidator implements Validator {
  constructor(private readonly o: CodeBuildOptions) {}

  async validate(plan: ChangePlan) {
    if (plan.sourceRevision.includes("+dirty")) {
      return {
        passed: false,
        report:
          "refusing to validate: the plan was made from a working tree with uncommitted changes, which CodeBuild cannot see. Commit and re-plan.",
      };
    }
    const sleep = this.o.sleep ?? wait;
    const started = await this.o.client.send(
      new StartBuildCommand({
        projectName: this.o.projectName,
        sourceVersion: plan.sourceRevision,
        environmentVariablesOverride: [
          { name: "CLOUD_AGENT_CHANGE_ID", value: plan.changeId, type: "PLAINTEXT" },
          { name: "CLOUD_AGENT_PLAN_HASH", value: plan.planHash, type: "PLAINTEXT" },
        ],
        idempotencyToken: plan.planHash.slice(0, 64),
      }),
    );
    const id = started.build?.id;
    if (!id) return { passed: false, report: "CodeBuild did not return a build id" };
    for (let i = 0; i < (this.o.maxPolls ?? 120); i++) {
      const b = (await this.o.client.send(new BatchGetBuildsCommand({ ids: [id] }))).builds?.[0];
      const status = b?.buildStatus ?? "UNKNOWN";
      if (status !== "IN_PROGRESS" && status !== "UNKNOWN") {
        const phases = (b?.phases ?? [])
          .map((p) => `${p.phaseType}: ${p.phaseStatus ?? "-"}`)
          .join("\n");
        return {
          passed: status === "SUCCEEDED",
          report: `CodeBuild ${id} ${status}\n${phases}${b?.logs?.deepLink ? `\nlogs: ${b.logs.deepLink}` : ""}`,
        };
      }
      await sleep(this.o.pollMs ?? 5000);
    }
    return { passed: false, report: `CodeBuild ${id} did not finish within the polling budget` };
  }
}
