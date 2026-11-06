import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ModelPort } from "@cloud-agent/agent";
import type { Deployer } from "@cloud-agent/changes";
import { restaurantPort } from "@cloud-agent/discovery";
import { runCli } from "./app.js";
import type { CliDeps } from "./deps.js";

const ROLE = "arn:aws:iam::123456789012:role/ro";
const WRITE = "arn:aws:iam::123456789012:role/rw";
const git = (repo: string, ...a: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);

let out: string[];
let errs: string[];
let deps: CliDeps;
let repo: string;
let template: string;
let deploys: number;
let actor = "alice";
let port = restaurantPort();

const plannerModel = (
  actions: object[] = [
    { kind: "update-config", resourceId: "fn", description: "timeout 10 -> 20" },
  ],
  edits: object[] = [],
): ModelPort => ({
  async converse() {
    return {
      stopReason: "tool_use",
      content: [
        {
          type: "toolUse",
          id: "p",
          name: "submit_plan",
          input: {
            actions,
            edits,
            steps: ["edit stack", "deploy"],
            verification: [{ id: "v1", description: "timeout is 20", kind: "manual" }],
            rollback: { strategy: "revert and redeploy", reversible: true, requiresBackup: false },
          },
        },
      ],
    };
  },
});

beforeEach(async () => {
  out = [];
  errs = [];
  deploys = 0;
  port = restaurantPort();
  actor = "alice";
  repo = await mkdtemp(join(tmpdir(), "cli-repo-"));
  await writeFile(join(repo, "stack.ts"), "x");
  execFileSync("git", ["-C", repo, "init", "-q"]);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  template = join(repo, "..", `tpl-${Date.now()}.json`);
  await writeFile(template, '{"Resources":{}}');
  const deployer: Deployer = {
    apply: async () => {
      deploys++;
      return { status: "succeeded", detail: "ok" };
    },
  };
  deps = {
    home: await mkdtemp(join(tmpdir(), "ca-")),
    get actor() {
      return actor;
    },
    now: () => new Date(),
    out: (t) => out.push(t),
    err: (t) => errs.push(t),
    readFile: (p) => readFile(p, "utf8"),
    session: async () => ({ read: port }),
    model: () => plannerModel(),
    deployer: async () => deployer,
  } as CliDeps;
  await runCli(
    [
      "connect",
      "--stack",
      "restaurant-app-prod",
      "--region",
      "us-east-1",
      "--role-arn",
      ROLE,
      "--write-role-arn",
      WRITE,
      "--system",
      "restaurant-app",
      "--repo",
      repo,
    ],
    deps,
  );
  out.length = 0;
});

const text = () => out.join("\n");
const id = () => /chg-[a-z0-9]+/.exec(text())![0];
const S = ["--system", "restaurant-app"];
async function planAndValidate(extra: string[] = ["--template", template, "--stack", "app"]) {
  expect(await runCli(["plan", ...S, ...extra, "Set", "timeout", "to", "20s"], deps)).toBe(0);
  const changeId = id();
  out.length = 0;
  expect(
    await runCli(
      ["changes", "validate", changeId, ...S, "--check", `${process.execPath} -e process.exit(0)`],
      deps,
    ),
  ).toBe(0);
  out.length = 0;
  return changeId;
}

describe("change lifecycle through the CLI", () => {
  it("proposes without applying anything", async () => {
    await runCli(["plan", ...S, "--template", template, "--stack", "app", "Set", "timeout"], deps);
    expect(text()).toContain("This is a PROPOSAL. Nothing has been applied.");
    expect(text()).toContain("risk: routine");
    expect(deploys).toBe(0);
  });

  it("refuses to plan without a linked repository or discovery data", async () => {
    await runCli(
      [
        "connect",
        "--stack",
        "other",
        "--region",
        "us-east-1",
        "--role-arn",
        ROLE,
        "--system",
        "norepo",
        "--no-discover",
      ],
      deps,
    );
    expect(await runCli(["plan", "--system", "norepo", "do", "x"], deps)).toBe(1);
    expect(errs.join()).toContain("linked source repository");
  });

  it("applies only after validation + approval, with the exact template, then verifies", async () => {
    const cid = await planAndValidate();
    expect(await runCli(["changes", "apply", cid, ...S, "--template", template], deps)).toBe(1);
    expect(errs.join()).toContain("no approval recorded");
    expect(deploys).toBe(0);
    errs.length = 0;
    await runCli(["changes", "approve", cid, ...S], deps);
    await writeFile(template, '{"Resources":{"Evil":{}}}');
    expect(await runCli(["changes", "apply", cid, ...S, "--template", template], deps)).toBe(1);
    expect(errs.join()).toContain("does not match the sha256");
    expect(deploys).toBe(0);
    await writeFile(template, '{"Resources":{}}');
    out.length = 0;
    expect(await runCli(["changes", "apply", cid, ...S, "--template", template], deps)).toBe(0);
    expect(text()).toContain("state: VERIFYING");
    expect(deploys).toBe(1);
    out.length = 0;
    await runCli(["changes", "verify", cid, ...S], deps);
    expect(text()).toContain("ROLLBACK_REQUIRED");
  });

  it("completes when criteria are confirmed, and the audit chain stays valid", async () => {
    const cid = await planAndValidate();
    await runCli(["changes", "approve", cid, ...S], deps);
    await runCli(["changes", "apply", cid, ...S, "--template", template], deps);
    out.length = 0;
    await runCli(["changes", "verify", cid, ...S, "--confirm", "v1"], deps);
    expect(text()).toContain("state: COMPLETED");
    out.length = 0;
    expect(await runCli(["audit"], deps)).toBe(0);
    expect(text()).toContain("change.APPLYING");
    expect(text()).toContain("Audit chain verified");
  });

  it("voids the approval when the source moves after approval", async () => {
    const cid = await planAndValidate();
    await runCli(["changes", "approve", cid, ...S], deps);
    await writeFile(join(repo, "stack.ts"), "changed");
    git(repo, "commit", "-qam", "move");
    out.length = 0;
    await runCli(["changes", "apply", cid, ...S, "--template", template], deps);
    expect(text()).toContain("state: STALE_PLAN");
    expect(text()).toContain("INVALIDATED");
    expect(deploys).toBe(0);
  });

  it("requires a different, elevated approver for elevated plans", async () => {
    deps.model = () =>
      plannerModel([{ kind: "iam-expansion", resourceId: "role", description: "wider" }]);
    const cid = await planAndValidate();
    expect(text()).toBe("");
    await runCli(["changes", "approve", cid, ...S, "--elevated"], deps);
    expect(await runCli(["changes", "apply", cid, ...S, "--template", template], deps)).toBe(1);
    expect(errs.join()).toContain("requester");
    errs.length = 0;
    actor = "bob";
    await runCli(["changes", "approve", cid, ...S, "--elevated"], deps);
    expect(await runCli(["changes", "apply", cid, ...S, "--template", template], deps)).toBe(0);
    expect(deploys).toBe(1);
  });

  it("refuses to change a stack that is not healthy", async () => {
    const cid = await planAndValidate();
    await runCli(["changes", "approve", cid, ...S], deps);
    port.stackStatuses["app"] = "UPDATE_ROLLBACK_COMPLETE";
    expect(await runCli(["changes", "apply", cid, ...S, "--template", template], deps)).toBe(1);
    expect(errs.join()).toContain("stack app is UPDATE_ROLLBACK_COMPLETE");
    expect(deploys).toBe(0);
  });

  it("blocks a delete-stack plan outright", async () => {
    deps.model = () =>
      plannerModel([{ kind: "delete-stack", resourceId: "s", description: "remove" }]);
    await runCli(["plan", ...S, "Delete", "everything"], deps);
    expect(text()).toContain("state: BLOCKED");
  });

  it("applies a patch-carrying plan to an isolated branch, never touching the working tree", async () => {
    await writeFile(join(repo, "stack.ts"), "timeout = 10;\n");
    git(repo, "commit", "-qam", "baseline");
    await writeFile(join(repo, "stack.ts"), "timeout = 20;\n");
    const patch = `${git(repo, "diff").toString()}\n`;
    git(repo, "checkout", "--", "stack.ts");
    deps.model = () =>
      plannerModel(
        [{ kind: "update-code", resourceId: "fn", description: "raise timeout" }],
        [{ path: "stack.ts", summary: "timeout 10 -> 20", patch }],
      );
    const cid = await planAndValidate([]);
    await runCli(["changes", "approve", cid, ...S], deps);
    out.length = 0;
    expect(await runCli(["changes", "apply", cid, ...S], deps)).toBe(0);
    expect(text()).toContain(`created branch cloud-agent/${cid}`);
    expect(git(repo, "show", `cloud-agent/${cid}:stack.ts`).toString().trim()).toBe(
      "timeout = 20;",
    );
    expect(await readFile(join(repo, "stack.ts"), "utf8")).toBe("timeout = 10;\n");
    expect(deploys).toBe(0);
  });

  it("validates in CodeBuild when asked and emits lifecycle events without ever blocking", async () => {
    const seen: string[] = [];
    let project = "";
    deps.codeBuildValidator = async (_p, name) => ({
      validate: async () => {
        project = name;
        return { passed: true, report: "codebuild ok" };
      },
    });
    deps.events = async () => ({
      publish: async (e) => {
        seen.push(String(e.to ?? e.type));
      },
    });
    await runCli(["plan", ...S, "--template", template, "--stack", "app", "Set", "timeout"], deps);
    const cid = id();
    out.length = 0;
    expect(await runCli(["changes", "validate", cid, ...S, "--codebuild", "proj-1"], deps)).toBe(0);
    expect(project).toBe("proj-1");
    expect(text()).toContain("AWAITING_APPROVAL");
    await runCli(["changes", "approve", cid, ...S], deps);
    expect(seen).toEqual(
      expect.arrayContaining(["VALIDATING", "AWAITING_APPROVAL", "change.approved"]),
    );
  });

  it("explains how to apply a plan that carries neither a template nor patches", async () => {
    const cid = await planAndValidate([]);
    await runCli(["changes", "approve", cid, ...S], deps);
    expect(await runCli(["changes", "apply", cid, ...S], deps)).toBe(1);
    expect(errs.join()).toContain("no template or patches");
  });
});
