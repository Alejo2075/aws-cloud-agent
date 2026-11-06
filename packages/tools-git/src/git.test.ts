import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { SystemGraph } from "@cloud-agent/contracts";
import { RepoAccessError, RepoReader, detectIac, mapResourcesToSource } from "./index.js";

let root: string;
let repo: RepoReader;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "repo-"));
  await mkdir(join(root, "lib"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules/x"), { recursive: true });
  await writeFile(join(root, "cdk.json"), "{}");
  await writeFile(
    join(root, "lib/stack.ts"),
    "const a = 1;\nnew NodejsFunction(this, 'CreateReservationFn', { entry: 'src/create.ts' });\n",
  );
  await writeFile(
    join(root, "src/create.ts"),
    "export const handler = async () => ({ key: 'AKIAABCDEFGHIJKLMNOP' });\n",
  );
  await writeFile(join(root, ".env"), "SECRET=1");
  await writeFile(join(root, "node_modules/x/i.js"), "x");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  ]);
  repo = await RepoReader.open(root);
});

const graph = {
  systemId: "s",
  environment: "p",
  accountId: "123456789012",
  region: "us-east-1",
  builtAt: "2026-11-06T00:00:00.000Z",
  gaps: [],
  edges: [],
  resources: [
    {
      id: "arn:aws:lambda:us-east-1:123456789012:function:create-reservation",
      arn: "arn:aws:lambda:us-east-1:123456789012:function:create-reservation",
      type: "AWS::Lambda::Function",
      logicalId: "CreateReservationFn",
      tags: {},
      provenance: "discovery" as const,
      observedAt: "2026-11-06T00:00:00.000Z",
    },
  ],
} satisfies SystemGraph;

describe("RepoReader", () => {
  it("lists files without dependencies or secrets", async () => {
    const { files } = await repo.listFiles();
    expect(files).toEqual(["cdk.json", "lib/stack.ts", "src/create.ts"]);
  });
  it("blocks traversal, symlink escapes and secret files", async () => {
    await expect(repo.readText("../etc/passwd")).rejects.toBeInstanceOf(RepoAccessError);
    await symlink("/etc/hosts", join(root, "link.txt"));
    await expect(repo.readText("link.txt")).rejects.toBeInstanceOf(RepoAccessError);
    await expect(repo.readText(".env")).rejects.toThrow("secret-bearing");
  });
  it("redacts secret-shaped content and reports the revision", async () => {
    expect((await repo.readText("src/create.ts")).text).not.toContain("AKIA");
    const r = await repo.revision();
    expect(r.revision).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("IaC detection and source mapping", () => {
  it("detects CDK", async () => expect((await detectIac(repo)).kind).toBe("aws-cdk"));
  it("maps a resource to its definition with a stated basis", async () => {
    const refs = await mapResourcesToSource(repo, graph, {
      [graph.resources[0]!.id]: "src/create.handler",
    });
    expect(refs).toContainEqual(
      expect.objectContaining({
        kind: "iac-definition",
        file: "lib/stack.ts",
        line: 2,
        confidence: "medium",
      }),
    );
    expect(refs).toContainEqual(
      expect.objectContaining({ kind: "handler-source", file: "src/create.ts" }),
    );
    expect(refs.every((r) => r.basis.length > 0 && r.revision)).toBe(true);
  });
  it("reports unknown IaC honestly", async () => {
    const empty = await RepoReader.open(await mkdtemp(join(tmpdir(), "empty-")));
    const d = await detectIac(empty);
    expect(d.kind).toBe("unknown");
    expect(d.notes.join()).toContain("no IaC definitions");
  });
});
