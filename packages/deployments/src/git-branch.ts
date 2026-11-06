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

const ALLOWED_MODES = new Set(["100644", "100755"]);

function checkPath(p: string): void {
  if (!p || /["\\\0\n\r\t]/.test(p))
    throw new PatchRejectedError(`unsupported characters in patch path: ${JSON.stringify(p)}`);
  const segs = p.split("/");
  if (p.startsWith("/") || segs.some((x) => x === ".." || x === "." || x === "" || x === ".git"))
    throw new PatchRejectedError(`patch path not allowed: ${p}`);
  if (isSecretFile(p)) throw new PatchRejectedError(`patch touches a secret-bearing file: ${p}`);
}

function checkMode(mode: string): void {
  if (!ALLOWED_MODES.has(mode))
    throw new PatchRejectedError(
      `file mode ${mode} is not allowed (symlinks, submodules and special modes are rejected)`,
    );
}

/**
 * Fail-closed parser for the header region of every file in a unified diff. Lines inside hunks always start
 * with ' ', '+', '-' or '\\', so anything else after `diff --git` is a header and must be a form we understand;
 * unknown, quoted or odd headers reject the whole patch. Returns every path the patch declares it touches.
 */
export function validatePatchPaths(patch: string): string[] {
  const lines = patch.split("\n");
  if (!lines[0]?.startsWith("diff --git "))
    throw new PatchRejectedError("patch must start with a `diff --git` header");
  const paths = new Set<string>();
  let inHeader = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // Linear parse (no backtracking regex): `diff --git a/<old> b/<new>`; real paths come from the checks below.
      const rest = line.slice("diff --git ".length);
      const sep = rest.indexOf(" b/");
      if (!rest.startsWith("a/") || sep < 2)
        throw new PatchRejectedError(`unsupported diff header: ${line.slice(0, 80)}`);
      const oldPath = rest.slice(2, sep);
      const newPath = rest.slice(sep + 3);
      checkPath(oldPath);
      checkPath(newPath);
      paths.add(oldPath).add(newPath);
      inHeader = true;
      continue;
    }
    if (!inHeader) continue;
    if (line.startsWith("@@")) {
      inHeader = false;
      continue;
    }
    if (line === "") continue;
    let m: RegExpExecArray | null;
    if (
      (m = /^(?:old|new) mode (\d{6})$/.exec(line)) ||
      (m = /^(?:new|deleted) file mode (\d{6})$/.exec(line))
    )
      checkMode(m[1]!);
    else if ((m = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d{6}))?$/.exec(line))) {
      if (m[1]) checkMode(m[1]);
    } else if (
      /^similarity index \d{1,3}%$/.test(line) ||
      /^dissimilarity index \d{1,3}%$/.test(line)
    )
      continue;
    else if ((m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line))) {
      checkPath(m[1]!);
      paths.add(m[1]!);
    } else if ((m = /^(?:--- a\/(.+)|\+\+\+ b\/(.+))$/.exec(line))) {
      const p = (m[1] ?? m[2])!;
      checkPath(p);
      paths.add(p);
    } else if (line === "--- /dev/null" || line === "+++ /dev/null") continue;
    else throw new PatchRejectedError(`unsupported patch header line: ${line.slice(0, 80)}`);
  }
  if (!paths.size) throw new PatchRejectedError("patch touches no files");
  return [...paths];
}

/** Re-checks what git actually staged: the real changed set must be inside the declared set and pass every rule. */
export function verifyStagedChanges(raw: string, declared: Set<string>): string[] {
  const tokens = raw.split("\0").filter(Boolean);
  const changed: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(tokens[i]!);
    if (!meta) throw new PatchRejectedError(`unexpected staged entry: ${tokens[i]!.slice(0, 60)}`);
    const path = tokens[i + 1]!;
    checkPath(path);
    if (meta[3] !== "D") checkMode(meta[2]!);
    if (!declared.has(path))
      throw new PatchRejectedError(`staged change to undeclared path: ${path}`);
    changed.push(path);
  }
  return changed;
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
    // git may exit before reading stdin (e.g. a failing `apply --check`); the exit code reports that, not EPIPE.
    c.stdin.on("error", () => undefined);
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
      const declared = new Set(plan.edits.flatMap((e) => validatePatchPaths(e.patch)));
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
      verifyStagedChanges(
        await git(work, ["diff", "--cached", "--raw", "--no-renames", "-z"]),
        declared,
      );
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
