import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finalizePlan } from "@cloud-agent/changes";
import type { Verifier } from "@cloud-agent/changes";
import { mockClient } from "aws-sdk-client-mock";
import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  StartBuildCommand,
} from "@aws-sdk/client-codebuild";
import {
  CodeBuildValidator,
  LocalWorkerValidator,
  createMetricVerifier,
  scrubbedEnv,
} from "./index.js";

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

describe("CodeBuildValidator (mocked)", () => {
  const cb = mockClient(CodeBuildClient);
  const mk = () =>
    new CodeBuildValidator({
      client: new CodeBuildClient({ region: "us-east-1" }),
      projectName: "p",
      sleep: async () => undefined,
      maxPolls: 3,
    });

  it("pins the build to the plan revision and passes only identifiers", async () => {
    cb.reset();
    cb.on(StartBuildCommand).resolves({ build: { id: "b1" } });
    cb.on(BatchGetBuildsCommand)
      .resolvesOnce({ builds: [{ id: "b1", buildStatus: "IN_PROGRESS" }] })
      .resolves({
        builds: [
          {
            id: "b1",
            buildStatus: "SUCCEEDED",
            phases: [{ phaseType: "BUILD", phaseStatus: "SUCCEEDED" }],
          },
        ],
      });
    const r = await mk().validate(plan);
    expect(r.passed).toBe(true);
    const input = cb.commandCalls(StartBuildCommand)[0]!.args[0].input;
    expect(input.sourceVersion).toBe("r");
    expect(input.environmentVariablesOverride?.map((v) => v.name)).toEqual([
      "CLOUD_AGENT_CHANGE_ID",
      "CLOUD_AGENT_PLAN_HASH",
    ]);
  });
  it("fails on a failed build, a timeout, and a dirty-tree plan without starting a build", async () => {
    cb.reset();
    cb.on(StartBuildCommand).resolves({ build: { id: "b2" } });
    cb.on(BatchGetBuildsCommand).resolves({ builds: [{ id: "b2", buildStatus: "FAILED" }] });
    expect((await mk().validate(plan)).passed).toBe(false);
    cb.reset();
    cb.on(StartBuildCommand).resolves({ build: { id: "b3" } });
    cb.on(BatchGetBuildsCommand).resolves({ builds: [{ id: "b3", buildStatus: "IN_PROGRESS" }] });
    expect((await mk().validate(plan)).report).toContain("did not finish");
    cb.reset();
    const dirty = finalizePlan({ ...plan, sourceRevision: "abc+dirty" });
    expect((await mk().validate(dirty)).report).toContain("uncommitted");
    expect(cb.calls()).toHaveLength(0);
  });
});

describe("terraformChecks", () => {
  it("never plans or applies and blocks module downloads", async () => {
    const { terraformChecks } = await import("./index.js");
    const all = terraformChecks().flatMap((c) => c.args);
    expect(all).not.toContain("plan");
    expect(all).not.toContain("apply");
    expect(all).toEqual(expect.arrayContaining(["-backend=false", "-get=false"]));
  });
  it("refuses to run terraform in the non-sandboxed local validator", async () => {
    const { terraformChecks } = await import("./index.js");
    expect(
      () => new LocalWorkerValidator({ repoPath: "/tmp", allowed: terraformChecks() }),
    ).toThrow("isolated worker");
    expect(
      () =>
        new LocalWorkerValidator({
          repoPath: "/tmp",
          allowed: [{ name: "x", file: "/usr/local/bin/tofu", args: [] }],
        }),
    ).toThrow("isolated worker");
  });
});

describe("createMetricVerifier", () => {
  const check = {
    type: "metric" as const,
    resourceId: "fn",
    metric: "Errors",
    stat: "Sum" as const,
    comparator: "lte" as const,
    threshold: 0,
    windowMinutes: 15,
  };
  const plan = (checks: unknown[]) =>
    ({
      verification: checks,
    }) as unknown as Parameters<Verifier["verify"]>[0];
  const rest: Verifier = {
    verify: async (p) => p.verification.map((v) => ({ id: v.id, passed: false, detail: "manual" })),
  };
  const mk = (summary: unknown, resolves = true) =>
    createMetricVerifier({
      now: () => new Date("2026-11-06T12:00:00Z"),
      rest,
      source: {
        resolve: (id) => (resolves ? { id } : undefined),
        query: async () => ({ summary }) as never,
      },
    });
  const crit = { id: "m", description: "no errors", kind: "metric" as const, check };

  it("passes and fails on the threshold and delegates other criteria", async () => {
    const ok = await mk({ count: 3, sum: 0 }).verify(
      plan([crit, { id: "x", description: "d", kind: "manual" }]),
    );
    expect(ok.map((r) => [r.id, r.passed])).toEqual([
      ["m", true],
      ["x", false],
    ]);
    const bad = await mk({ count: 3, sum: 4 }).verify(plan([crit]));
    expect(bad[0]).toMatchObject({ passed: false });
    expect(bad[0]?.detail).toContain("= 4");
  });

  it("fails closed with no data, unknown resources and query errors", async () => {
    expect((await mk({ count: 0 }).verify(plan([crit])))[0]?.detail).toContain("cannot verify");
    expect((await mk({ count: 1, sum: 0 }, false).verify(plan([crit])))[0]?.passed).toBe(false);
    const boom = createMetricVerifier({
      now: () => new Date(),
      rest,
      source: {
        resolve: (id) => ({ id }),
        query: async () => {
          throw new Error("denied");
        },
      },
    });
    expect((await boom.verify(plan([crit])))[0]?.detail).toContain("denied");
  });
});
