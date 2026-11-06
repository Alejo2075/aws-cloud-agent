import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { BedrockModelPort } from "@cloud-agent/agent";
import type { ModelPort } from "@cloud-agent/agent";
import type { Deployer, EventPublisher, Validator } from "@cloud-agent/changes";
import type { ConnectionProfile } from "@cloud-agent/contracts";
import { CfnChangeSetDeployer, EventBridgePublisher } from "@cloud-agent/deployments";
import { CodeBuildValidator } from "@cloud-agent/validation";
import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import type { TemplateArtifact } from "@cloud-agent/deployments";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import {
  SdkAwsReadPort,
  SdkObservabilityPort,
  assumeRole,
  callerIdentity,
  createClients,
} from "@cloud-agent/tools-aws";
import type { AwsReadPort, ObservabilityPort } from "@cloud-agent/tools-aws";

export interface CliDeps {
  home: string;
  actor: string;
  now(): Date;
  out(text: string): void;
  err(text: string): void;
  readFile(path: string): Promise<string>;
  /** Assume the profile's read-only role; ports are bound to the identity AWS actually reports. */
  session(profile: ConnectionProfile): Promise<{ read: AwsReadPort; observe?: ObservabilityPort }>;
  model(modelId: string | undefined, region: string): ModelPort;
  /** Isolated validation in CodeBuild using the connection's change-planning role (optional). */
  codeBuildValidator?(profile: ConnectionProfile, project: string): Promise<Validator>;
  /** Lifecycle event publisher for connections that declare an event bus (optional). */
  events?(profile: ConnectionProfile): Promise<EventPublisher | undefined>;
  /** Builds a deployer bound to the profile's WRITE role. Used only after policy authorizes an apply. */
  deployer(profile: ConnectionProfile, artifact: TemplateArtifact): Promise<Deployer>;
}

export function defaultDeps(): CliDeps {
  return {
    home: process.env["CLOUD_AGENT_HOME"] ?? join(homedir(), ".cloud-agent"),
    actor: `local:${userInfo().username}`,
    now: () => new Date(),
    out: (t) => process.stdout.write(`${t}\n`),
    err: (t) => process.stderr.write(`${t}\n`),
    readFile: (p) => readFile(p, "utf8"),
    async session(profile) {
      const credentials = assumeRole(
        profile.roles["read-only"],
        profile.region,
        "cloud-agent-read",
      );
      const id = await callerIdentity(profile.region, credentials);
      return {
        read: new SdkAwsReadPort(
          { accountId: id.accountId, region: profile.region },
          createClients(profile.region, credentials),
        ),
        observe: new SdkObservabilityPort(profile.region, credentials),
      };
    },
    async deployer(profile, artifact) {
      const role = profile.roles.write;
      if (!role)
        throw new Error(
          "no write role is configured for this connection; add one with --write-role-arn",
        );
      const credentials = assumeRole(role, profile.region, "cloud-agent-write");
      const id = await callerIdentity(profile.region, credentials);
      return new CfnChangeSetDeployer({
        client: new CloudFormationClient({ region: profile.region, credentials }),
        accountId: id.accountId,
        region: profile.region,
        artifact: async () => artifact,
      });
    },
    async codeBuildValidator(profile, project) {
      const role = profile.roles["change-planning"];
      if (!role)
        throw new Error(
          "no change-planning role is configured for this connection; add one with --planning-role-arn",
        );
      const client = new CodeBuildClient({
        region: profile.region,
        credentials: assumeRole(role, profile.region, "cloud-agent-plan"),
      });
      return new CodeBuildValidator({ client, projectName: project });
    },
    async events(profile) {
      const role = profile.roles["change-planning"] ?? profile.roles.write;
      if (!profile.eventBusName || !role) return undefined;
      const client = new EventBridgeClient({
        region: profile.region,
        credentials: assumeRole(role, profile.region, "cloud-agent-events"),
      });
      return new EventBridgePublisher({ client, eventBusName: profile.eventBusName });
    },
    model(modelId, region) {
      const id = modelId ?? process.env["CLOUD_AGENT_MODEL_ID"];
      if (!id)
        throw new Error(
          "no Bedrock model configured: pass --model or set CLOUD_AGENT_MODEL_ID (use a model or inference profile enabled in your account)",
        );
      return new BedrockModelPort({ modelId: id, region });
    },
  };
}
