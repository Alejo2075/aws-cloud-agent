import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finalizePlan } from "@cloud-agent/changes";
import { LocalWorkerValidator, scrubbedEnv } from "./index.js";

const plan = finalizePlan({
  changeId: "c1",
  systemId: "s",
  environment: "e",
  accountId: "123456789012",
  region: "us-east-1",
  requestedBy: "a",
  intent: "i",
  sourceRevision: "r",
  graphBuiltAt: "2026-11-06T00:00:00.000Z",
  actions: [{ kind: "update-config", resourceId: "x", description: "d" }],
  steps: ["s"],
  verification: [{ id: "v", description: "d", kind: "test" }],
  rollback: { strategy: "revert", reversible: true, requiresBackup: false },
});
const node = (name: string, code: string) => ({ name, file: process.execPath, args: ["-e", code] });

describe("LocalWorkerValidator", () => {
  it("passes when all allowed commands pass and never mutates the original checkout", async () => {
    const repo = await mkdtemp(join(tmpdir(), "v-"));
    await writeFile(join(repo, "a.txt"), "orig");
    const v = new LocalWorkerValidator({
      repoPath: repo,
      allowed: [node("write", "require('fs').writeFileSync('a.txt','changed')")],
    });
    expect((await v.validate(plan)).passed).toBe(true);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("orig");
  });
  it("fails fast, reports output, and enforces timeouts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "v-"));
    const fail = await new LocalWorkerValidator({
      repoPath: repo,
      allowed: [
        node("t", "console.error('boom');process.exit(3)"),
        node("never", "process.exit(0)"),
      ],
    }).validate(plan);
    expect(fail.passed).toBe(false);
    expect(fail.report).toContain("exit 3");
    expect(fail.report).not.toContain("never");
    const slow = await new LocalWorkerValidator({
      repoPath: repo,
      timeoutMs: 200,
      allowed: [node("sleep", "setTimeout(()=>{},5000)")],
    }).validate(plan);
    expect(slow.report).toContain("TIMEOUT");
  });
  it("refuses to report success with no commands, and hides AWS credentials from children", async () => {
    const repo = await mkdtemp(join(tmpdir(), "v-"));
    expect(
      (await new LocalWorkerValidator({ repoPath: repo, allowed: [] }).validate(plan)).passed,
    ).toBe(false);
    process.env["AWS_SECRET_ACCESS_KEY"] = "x";
    process.env["AWS_PROFILE"] = "personal";
    expect(Object.keys(scrubbedEnv()).some((k) => k.startsWith("AWS_"))).toBe(false);
    const r = await new LocalWorkerValidator({
      repoPath: repo,
      allowed: [
        node("env", "process.exit(Object.keys(process.env).some(k=>k.startsWith('AWS_'))?1:0)"),
      ],
    }).validate(plan);
    expect(r.passed).toBe(true);
  });
});
