import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangePlan, Validator } from "@cloud-agent/changes";

export interface AllowedCommand {
  name: string;
  file: string;
  args: string[];
}

export interface RunnerOptions {
  /** Checkout to copy; the original is never modified. */
  repoPath: string;
  allowed: AllowedCommand[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const SKIP = new Set([".git", "node_modules", "cdk.out", "dist"]);

/** Environment passed to child processes: no AWS credentials, tokens, or profiles. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "LANG", "TMPDIR", "NODE_ENV"];
  return Object.fromEntries(keep.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));
}

function runOnce(cmd: AllowedCommand, cwd: string, timeoutMs: number, maxBytes: number) {
  return new Promise<{ code: number | null; output: string; timedOut: boolean }>((resolve) => {
    const child = spawn(cmd.file, cmd.args, { cwd, env: scrubbedEnv(), shell: false });
    let output = "";
    let timedOut = false;
    const add = (b: Buffer) => {
      if (output.length < maxBytes) output += b.toString("utf8").slice(0, maxBytes - output.length);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `failed to start: ${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/**
 * Development-grade validator: runs a fixed allowlist of commands in a throwaway copy of the repo with a scrubbed
 * environment. It is NOT a security sandbox (no network or filesystem isolation); production use needs an
 * ephemeral isolated worker such as CodeBuild, which is documented but not implemented here.
 */
export class LocalWorkerValidator implements Validator {
  constructor(private readonly opts: RunnerOptions) {}

  async validate(plan: ChangePlan) {
    const dir = await mkdtemp(join(tmpdir(), `ca-validate-${plan.changeId}-`));
    try {
      await cp(this.opts.repoPath, dir, {
        recursive: true,
        filter: (src) => !SKIP.has(src.split("/").pop() ?? ""),
      });
      const lines: string[] = [];
      let passed = true;
      for (const cmd of this.opts.allowed) {
        const r = await runOnce(
          cmd,
          dir,
          this.opts.timeoutMs ?? 120_000,
          this.opts.maxOutputBytes ?? 20_000,
        );
        const ok = r.code === 0 && !r.timedOut;
        passed &&= ok;
        lines.push(
          `## ${cmd.name}: ${ok ? "PASS" : r.timedOut ? "TIMEOUT" : `FAIL (exit ${r.code})`}\n${r.output.trim().slice(-2000)}`,
        );
        if (!ok) break;
      }
      if (!this.opts.allowed.length)
        return {
          passed: false,
          report: "no validation commands configured; refusing to report success",
        };
      return { passed, report: lines.join("\n\n") };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Offline Terraform checks (no backend, no provider credentials, never `plan`/`apply`, so nothing
 * can reach real state or AWS). Changes to Terraform code travel through the branch/PR path.
 */
export function terraformChecks(): AllowedCommand[] {
  return [
    {
      name: "terraform init (no backend)",
      file: "terraform",
      args: ["init", "-backend=false", "-input=false", "-no-color"],
    },
    { name: "terraform validate", file: "terraform", args: ["validate", "-no-color"] },
    {
      name: "terraform fmt -check",
      file: "terraform",
      args: ["fmt", "-check", "-recursive", "-no-color"],
    },
  ];
}
