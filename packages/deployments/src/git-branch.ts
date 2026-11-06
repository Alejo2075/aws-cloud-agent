import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Authorization, ChangePlan, DeployResult, Deployer } from "@cloud-agent/changes";
import { isSecretFile } from "@cloud-agent/tools-git";

const exec = promisify(execFile);
const BRANCH = /^cloud-agent\/[\w.-]{1,80}$/;

export class PatchRejectedError extends Error {}

/** Every path a unified diff touches; rejects anything that could leave the repo or hit secrets. */
export function validatePatchPaths(patch: string): string[] {
  if (/^GIT binary patch/m.test(patch))
    throw new PatchRejectedError("binary patches are not allowed");
  if (/^(new|old) file mode 120000/m.test(patch) || /^new file mode 160000/m.test(patch))
    throw new PatchRejectedError("symlink and submodule changes are not allowed");
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const m =
      /^(?:diff --git a\/(.+) b\/(.+)|--- a\/(.+)|\+\+\+ b\/(.+)|rename (?:from|to) (.+))$/.exec(
        line,
      );
    if (!m) continue;
    for (const p of m.slice(1).filter((x): x is string => !!x)) paths.add(p);
  }
  if (!paths.size) throw new PatchRejectedError("patch touches no files");
  for (const p of paths) {
    const segs = p.split("/");
    if (p.startsWith("/") || segs.includes("..") || segs[0] === ".git" || segs.includes(".git"))
      throw new PatchRejectedError(`patch path not allowed: ${p}`);
    if (isSecretFile(p)) throw new PatchRejectedError(`patch touches a secret-bearing file: ${p}`);
  }
  return [...paths];
}

function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (b) => (out += b));
    c.stderr.on("data", (b) => (err += b));
    c.on("error", reject);
    c.on("close", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(`git ${args[0]} failed: ${err.trim().slice(0, 500)}`)),
    );
    c.stdin.end(input ?? "");
  });
}

export interface BranchOptions {
  repoPath: string;
  /** Pushing is outward-facing: off unless explicitly enabled by the operator. */
  push?: boolean;
  remote?: string;
  pullRequest?: {
    base: string;
    run?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  };
}

/**
 * Applies a plan's patches to a NEW branch in an isolated worktree, so the user's working tree is never touched.
 * It needs a policy-minted Authorization, only works from the exact revision the plan was made against,
 * never force-pushes, and never writes to an existing branch.
 */
export class GitBranchDeployer implements Deployer {
  constructor(private readonly o: BranchOptions) {}

  async apply(plan: ChangePlan, auth: Authorization): Promise<DeployResult> {
    if (auth.planHash !== plan.planHash || auth.changeId !== plan.changeId)
      return { status: "failed", detail: "authorization does not match plan" };
    if (!plan.edits.length) return { status: "failed", detail: "plan has no edits to apply" };
    const branch = `cloud-agent/${plan.changeId}`;
    if (!BRANCH.test(branch))
      return { status: "failed", detail: "change id cannot be used in a branch name" };
    let work: string | undefined;
    let created = false;
    let ok = false;
    try {
      const head = await git(this.o.repoPath, ["rev-parse", "HEAD"]);
      if (plan.sourceRevision !== head)
        return {
          status: "failed",
          detail: `repository HEAD ${head} differs from the plan's source revision ${plan.sourceRevision}`,
        };
      for (const e of plan.edits) validatePatchPaths(e.patch);
      if (await git(this.o.repoPath, ["branch", "--list", branch]))
        return {
          status: "failed",
          detail: `branch ${branch} already exists; refusing to modify it`,
        };

      work = join(await mkdtemp(join(tmpdir(), "ca-branch-")), "wt");
      await git(this.o.repoPath, ["worktree", "add", "-q", "-b", branch, work, head]);
      created = true;
      for (const e of plan.edits) {
        await git(work, ["apply", "--check", "--whitespace=nowarn", "-"], e.patch);
        await git(work, ["apply", "--whitespace=nowarn", "-"], e.patch);
      }
      await git(work, ["add", "-A"]);
      await git(work, [
        "-c",
        "user.name=Cloud Agent",
        "-c",
        "user.email=cloud-agent@users.noreply.github.com",
        "commit",
        "-q",
        "-m",
        `cloud-agent: ${plan.intent.slice(0, 60)}\n\nChange ${plan.changeId}, plan ${plan.planHash}`,
      ]);
      const commit = await git(work, ["rev-parse", "HEAD"]);
      let detail = `created branch ${branch} at ${commit.slice(0, 12)}`;
      if (this.o.push) {
        await git(this.o.repoPath, ["push", "--set-upstream", this.o.remote ?? "origin", branch]);
        detail += `; pushed to ${this.o.remote ?? "origin"}`;
        if (this.o.pullRequest) {
          const run =
            this.o.pullRequest.run ??
            ((f: string, a: string[]) => exec(f, a, { cwd: this.o.repoPath }));
          const r = await run("gh", [
            "pr",
            "create",
            "--base",
            this.o.pullRequest.base,
            "--head",
            branch,
            "--title",
            `Cloud Agent: ${plan.intent.slice(0, 60)}`,
            "--body",
            `Change ${plan.changeId}\nPlan hash: ${plan.planHash}\nRisk: ${plan.riskClass}\n\nProposed by Cloud Agent after explicit approval. Review before merging.`,
          ]);
          detail += `; PR ${r.stdout.trim()}`;
        }
      }
      ok = true;
      return { status: "succeeded", detail };
    } catch (e) {
      return {
        status: "failed",
        detail: `${e instanceof PatchRejectedError ? "patch rejected: " : ""}${(e as Error).message}`,
      };
    } finally {
      if (work) {
        await git(this.o.repoPath, ["worktree", "remove", "--force", work]).catch(() => undefined);
        await rm(join(work, ".."), { recursive: true, force: true }).catch(() => undefined);
      }
      // A failed run must not leave a half-built branch behind (unless it was already pushed).
      if (created && !ok)
        await git(this.o.repoPath, ["branch", "-D", branch]).catch(() => undefined);
    }
  }
}
