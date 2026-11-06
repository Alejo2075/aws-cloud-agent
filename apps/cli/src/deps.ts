import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { BedrockModelPort } from "@cloud-agent/agent";
import type { ModelPort } from "@cloud-agent/agent";
import type { Deployer } from "@cloud-agent/changes";
import type { ConnectionProfile } from "@cloud-agent/contracts";
import { CfnChangeSetDeployer } from "@cloud-agent/deployments";
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
