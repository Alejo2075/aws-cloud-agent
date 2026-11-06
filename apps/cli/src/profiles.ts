import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ConnectionProfile } from "@cloud-agent/contracts";

const File = z.object({ profiles: z.array(ConnectionProfile) });

/** Non-secret connection profiles. Credentials are never stored; roles are assumed per run. */
export class ProfileStore {
  constructor(private readonly file: string) {}

  async list(): Promise<ConnectionProfile[]> {
    try {
      return File.parse(JSON.parse(await readFile(this.file, "utf8"))).profiles;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  async save(p: ConnectionProfile) {
    const rest = (await this.list()).filter(
      (x) => !(x.systemId === p.systemId && x.environment === p.environment),
    );
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ profiles: [...rest, p] }, null, 2), {
      mode: 0o600,
    });
  }

  async resolve(systemId: string, environment?: string): Promise<ConnectionProfile> {
    const matches = (await this.list()).filter(
      (p) => p.systemId === systemId && (!environment || p.environment === environment),
    );
    if (matches.length === 0)
      throw new CliError(
        `no connection for system ${systemId}${environment ? ` environment ${environment}` : ""}; run \`cloud-agent connect\``,
      );
    if (matches.length > 1)
      throw new CliError(
        `system ${systemId} has several environments (${matches.map((m) => m.environment).join(", ")}); pass --env`,
      );
    return matches[0]!;
  }
}

export class CliError extends Error {}
