import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { BedrockModelPort } from "@cloud-agent/agent";
import type { ModelPort } from "@cloud-agent/agent";
import type { ConnectionProfile } from "@cloud-agent/contracts";
import { SdkAwsReadPort, assumeRole, callerIdentity, createClients } from "@cloud-agent/tools-aws";
import type { AwsReadPort } from "@cloud-agent/tools-aws";

export interface CliDeps {
  home: string;
  actor: string;
  now(): Date;
  out(text: string): void;
  err(text: string): void;
  readFile(path: string): Promise<string>;
  /** Assume the profile's read-only role and return a port bound to the identity AWS actually reports. */
  readPort(profile: ConnectionProfile): Promise<AwsReadPort>;
  model(modelId: string | undefined, region: string): ModelPort;
}

export function defaultDeps(): CliDeps {
  return {
    home: process.env["CLOUD_AGENT_HOME"] ?? join(homedir(), ".cloud-agent"),
    actor: `local:${userInfo().username}`,
    now: () => new Date(),
    out: (t) => process.stdout.write(`${t}\n`),
    err: (t) => process.stderr.write(`${t}\n`),
    readFile: (p) => readFile(p, "utf8"),
    async readPort(profile) {
      const credentials = assumeRole(
        profile.roles["read-only"],
        profile.region,
        "cloud-agent-read",
      );
      const id = await callerIdentity(profile.region, credentials);
      return new SdkAwsReadPort(
        { accountId: id.accountId, region: profile.region },
        createClients(profile.region, credentials),
      );
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
