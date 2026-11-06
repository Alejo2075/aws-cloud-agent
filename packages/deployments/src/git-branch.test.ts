import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeApply, finalizePlan } from "@cloud-agent/changes";
import type { Authorization, ChangeRecord } from "@cloud-agent/changes";
import {
  GitBranchDeployer,
  PatchRejectedError,
  validatePatchPaths,
  verifyStagedChanges,
} from "./index.js";

const sh = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    encoding: "utf8",
  }).trim();
let repo: string;
let head: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "gb-"));
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  await writeFile(join(repo, "stack.ts"), "timeout = 10;\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "init");
  head = sh(repo, "rev-parse", "HEAD");
});

async function patchFor(file: string, from: string, to: string) {
  await writeFile(join(repo, file), to);
  const diff = sh(repo, "diff");
  sh(repo, "checkout", "--", file);
  return `${diff}\n`;
}
const planWith = (patch: string, over: object = {}) =>
  finalizePlan({
    changeId: "chg1",
    systemId: "s",
    environment: "production",
    accountId: "123456789012",
    region: "us-east-1",
    requestedBy: "a",
    intent: "Raise timeout",
    sourceRevision: head,
    graphBuiltAt: "2026-11-06T00:00:00.000Z",
    actions: [{ kind: "update-code", resourceId: "x", description: "d" }],
    steps: ["s"],
    edits: [{ path: "stack.ts", summary: "timeout", patch }],
    verification: [{ id: "v", description: "d", kind: "test" }],
    rollback: { strategy: "revert", reversible: true, requiresBackup: false },
    ...over,
  });
function auth(p: ReturnType<typeof planWith>): Authorization {
  const rec: ChangeRecord = {
    plan: p,
    state: "AWAITING_APPROVAL",
    history: [],
    validation: { passed: true, at: "t", report: "" },
    approval: {
      approvalId: "ap",
      changeId: p.changeId,
      planHash: p.planHash,
      sourceRevision: head,
      environment: "production",
      accountId: "123456789012",
      region: "us-east-1",
      actor: "bob",
      elevated: false,
      approvedAt: "t",
      expiresAt: "2999-01-01T00:00:00Z",
    },
  };
  const d = authorizeApply(
    rec,
    { sourceRevision: head, driftDetected: false, healthy: true },
    { writeRoleConfigured: true },
    new Date("2026-11-06T12:00:00Z"),
  );
  if (!d.authorization) throw new Error(d.reasons.join());
  return d.authorization;
}

describe("validatePatchPaths", () => {
  const mk = (p: string, extra = "") =>
    `diff --git a/${p} b/${p}\n${extra}--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b\n`;
  it("accepts ordinary patches, including hunks whose content looks like headers", () => {
    expect(validatePatchPaths(mk("lib/stack.ts"))).toEqual(["lib/stack.ts"]);
    expect(
      validatePatchPaths(
        `diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1 +1 @@\n--- a comment\n+++ b comment\n`,
      ),
    ).toEqual(["q.sql"]);
    expect(
      validatePatchPaths(
        `diff --git a/n.ts b/n.ts\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x\n`,
      ),
    ).toEqual(["n.ts"]);
  });
  it("parses headers in linear time even for hostile lines", () => {
    const t = Date.now();
    try {
      validatePatchPaths(`diff --git a/! b/!${" b/!".repeat(50_000)}\n`);
    } catch {
      /* accepted or rejected does not matter here; only the running time does */
    }
    expect(Date.now() - t).toBeLessThan(500);
  });
  it("rejects traversal, .git, secrets, odd characters and quoted paths", () => {
    for (const bad of [
      "../x",
      "a/../../x",
      ".git/hooks/pre-commit",
      "sub/.git/config",
      ".env",
      "keys/server.pem",
      "a//b",
      "./x",
    ])
      expect(() => validatePatchPaths(mk(bad))).toThrow(PatchRejectedError);
    expect(() =>
      validatePatchPaths(
        'diff --git "a/x y" "b/x y"\n--- "a/x y"\n+++ "b/x y"\n@@ -1 +1 @@\n-a\n+b\n',
      ),
    ).toThrow("unsupported");
    expect(() => validatePatchPaths(mk('we"ird'))).toThrow("unsupported characters");
  });
  it("fails closed on unknown headers, odd modes, binaries, preambles and empty patches", () => {
    expect(() => validatePatchPaths(mk("l", "new file mode 120000\n"))).toThrow("not allowed");
    expect(() => validatePatchPaths(mk("l", "new mode 160000\n"))).toThrow("not allowed");
    expect(() => validatePatchPaths(mk("l", "index abc..def 120000\n"))).toThrow("not allowed");
    expect(() => validatePatchPaths(mk("l", "something unexpected\n"))).toThrow(
      "unsupported patch header",
    );
    expect(() => validatePatchPaths("diff --git a/x b/x\nGIT binary patch\nliteral 1\n")).toThrow(
      "unsupported patch header",
    );
    expect(() => validatePatchPaths(`--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`)).toThrow(
      "must start with",
    );
    expect(() => validatePatchPaths(`junk\n${mk("x")}`)).toThrow("must start with");
  });
});

describe("verifyStagedChanges", () => {
  const entry = (mode: string, status: string, path: string) =>
    `:100644 ${mode} aaaaaaa bbbbbbb ${status}\0${path}\0`;
  it("accepts the declared set and rejects symlinks, secrets and undeclared paths in what git really staged", () => {
    expect(verifyStagedChanges(entry("100644", "M", "a.ts"), new Set(["a.ts"]))).toEqual(["a.ts"]);
    expect(verifyStagedChanges(entry("000000", "D", "a.ts"), new Set(["a.ts"]))).toEqual(["a.ts"]);
    expect(() => verifyStagedChanges(entry("120000", "M", "a.ts"), new Set(["a.ts"]))).toThrow(
      "not allowed",
    );
    expect(() => verifyStagedChanges(entry("100644", "M", ".env"), new Set([".env"]))).toThrow(
      "secret",
    );
    expect(() => verifyStagedChanges(entry("100644", "M", "other.ts"), new Set(["a.ts"]))).toThrow(
      "undeclared",
    );
  });
});

describe("GitBranchDeployer", () => {
  it("creates a branch with the patch in an isolated worktree and leaves the working tree untouched", async () => {
    const plan = planWith(await patchFor("stack.ts", "10", "timeout = 20;\n"));
    const r = await new GitBranchDeployer({ repoPath: repo }).apply(plan, auth(plan));
    expect(r.status).toBe("succeeded");
    expect(sh(repo, "show", "cloud-agent/chg1:stack.ts")).toBe("timeout = 20;");
    expect(await readFile(join(repo, "stack.ts"), "utf8")).toBe("timeout = 10;\n");
    expect(sh(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(sh(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(sh(repo, "log", "-1", "--format=%an", "cloud-agent/chg1")).toBe("Cloud Agent");
  });

  it("refuses a moved HEAD, an existing branch, bad patches and mismatched authorization", async () => {
    const plan = planWith(await patchFor("stack.ts", "10", "timeout = 20;\n"));
    const a = auth(plan);
    await writeFile(join(repo, "other.txt"), "x");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "move");
    expect((await new GitBranchDeployer({ repoPath: repo }).apply(plan, a)).detail).toContain(
      "differs from the plan's source revision",
    );
    sh(repo, "reset", "-q", "--hard", head);
    sh(repo, "branch", "cloud-agent/chg1");
    expect((await new GitBranchDeployer({ repoPath: repo }).apply(plan, a)).detail).toContain(
      "already exists",
    );
    sh(repo, "branch", "-D", "cloud-agent/chg1");
    const bad = planWith("diff --git a/../x b/../x\n--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+b\n");
    expect(
      (await new GitBranchDeployer({ repoPath: repo }).apply(bad, auth(bad))).detail,
    ).toContain("patch rejected");
    const wrong = { ...a, planHash: "0".repeat(64) } as Authorization;
    expect((await new GitBranchDeployer({ repoPath: repo }).apply(plan, wrong)).detail).toContain(
      "does not match",
    );
    const nonApplying = planWith(
      `diff --git a/stack.ts b/stack.ts\n--- a/stack.ts\n+++ b/stack.ts\n@@ -1 +1 @@\n-nope\n+yes\n`,
    );
    const r = await new GitBranchDeployer({ repoPath: repo }).apply(nonApplying, auth(nonApplying));
    expect(r.status).toBe("failed");
    expect(sh(repo, "branch", "--list", "cloud-agent/*")).toBe("");
  });

  it("pushes only when enabled (never forced) and opens a PR through the injected runner", async () => {
    const remote = await mkdtemp(join(tmpdir(), "remote-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    sh(repo, "remote", "add", "origin", remote);
    const plan = planWith(await patchFor("stack.ts", "10", "timeout = 20;\n"));
    const noPush = await new GitBranchDeployer({ repoPath: repo }).apply(plan, auth(plan));
    expect(noPush.detail).not.toContain("pushed");
    expect(execFileSync("git", ["-C", remote, "branch", "--list"], { encoding: "utf8" })).toBe("");
    sh(repo, "branch", "-D", "cloud-agent/chg1");
    const calls: string[][] = [];
    const r = await new GitBranchDeployer({
      repoPath: repo,
      push: true,
      pullRequest: {
        base: "main",
        run: async (_f, a) => {
          calls.push(a);
          return { stdout: "https://example.test/pr/1\n" };
        },
      },
    }).apply(plan, auth(plan));
    expect(r.detail).toContain("pushed to origin");
    expect(r.detail).toContain("https://example.test/pr/1");
    expect(execFileSync("git", ["-C", remote, "branch", "--list"], { encoding: "utf8" })).toContain(
      "cloud-agent/chg1",
    );
    expect(calls[0]).toEqual(
      expect.arrayContaining(["pr", "create", "--head", "cloud-agent/chg1"]),
    );
  });
});
