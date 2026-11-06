import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ModelPort, ModelRequest } from "@cloud-agent/agent";
import { restaurantPort } from "@cloud-agent/discovery";
import { runCli } from "./app.js";
import type { CliDeps } from "./deps.js";

const ROLE = "arn:aws:iam::123456789012:role/CloudAgentReadOnly";
let out: string[];
let errs: string[];
let deps: CliDeps;
let model: ModelPort;

beforeEach(async () => {
  out = [];
  errs = [];
  model = {
    async converse(req: ModelRequest) {
      const used = req.messages.length > 1;
      return {
        stopReason: "tool_use",
        content: used
          ? [
              {
                type: "toolUse",
                id: "2",
                name: "submit_answer",
                input: {
                  answer: "Reservations enter through ReservationsApi.",
                  citedObservationIds: [],
                  hypotheses: [],
                  limitations: [],
                },
              },
            ]
          : [{ type: "toolUse", id: "1", name: "get_system_overview", input: {} }],
      };
    },
  };
  deps = {
    home: await mkdtemp(join(tmpdir(), "ca-")),
    actor: "test",
    now: () => new Date(),
    out: (t) => out.push(t),
    err: (t) => errs.push(t),
    readFile: async () => "",
    readPort: async () => restaurantPort(),
    model: () => model,
  };
});

const text = () => out.join("\n");

describe("cloud-agent CLI", () => {
  it("connects, discovers, inspects and lists", async () => {
    expect(
      await runCli(
        [
          "connect",
          "--stack",
          "restaurant-app-prod",
          "--region",
          "us-east-1",
          "--role-arn",
          ROLE,
          "--system",
          "restaurant-app",
        ],
        deps,
      ),
    ).toBe(0);
    expect(text()).toContain("7 resources");
    out.length = 0;
    expect(await runCli(["systems", "list"], deps)).toBe(0);
    expect(text()).toContain("restaurant-app");
    out.length = 0;
    await runCli(["systems", "inspect", "restaurant-app"], deps);
    expect(text()).toContain("--invokes-->");
    expect(text()).toContain("[inferred: environment variable QUEUE_URL");
    expect(text()).toContain("Gaps and limitations");
  });

  it("answers with limitations and records the question in a verifiable audit trail", async () => {
    await runCli(
      [
        "connect",
        "--stack",
        "restaurant-app-prod",
        "--region",
        "us-east-1",
        "--role-arn",
        ROLE,
        "--system",
        "restaurant-app",
      ],
      deps,
    );
    out.length = 0;
    expect(
      await runCli(
        ["ask", "--system", "restaurant-app", "How", "do", "reservations", "start?"],
        deps,
      ),
    ).toBe(0);
    expect(text()).toContain("Reservations enter through ReservationsApi.");
    expect(text()).toContain("No evidence was cited");
    out.length = 0;
    expect(await runCli(["audit"], deps)).toBe(0);
    expect(text()).toMatch(
      /connect[\s\S]*discover[\s\S]*ask[\s\S]*Audit chain verified \(3 records\)/,
    );
  });

  it("reports missing discovery data without calling the model", async () => {
    await runCli(
      [
        "connect",
        "--stack",
        "restaurant-app-prod",
        "--region",
        "us-east-1",
        "--role-arn",
        ROLE,
        "--system",
        "restaurant-app",
        "--no-discover",
      ],
      deps,
    );
    deps.model = () => {
      throw new Error("model must not be created");
    };
    out.length = 0;
    expect(await runCli(["ask", "--system", "restaurant-app", "hi"], deps)).toBe(0);
    expect(text()).toContain("no discovery data");
  });

  it("fails cleanly on bad input and unknown systems", async () => {
    expect(
      await runCli(
        ["connect", "--stack", "s", "--region", "us-east-1", "--role-arn", "not-an-arn"],
        deps,
      ),
    ).toBe(1);
    expect(errs.join()).toContain("--role-arn must be an IAM role ARN");
    errs.length = 0;
    expect(await runCli(["systems", "inspect", "nope"], deps)).toBe(1);
    expect(errs.join()).toContain("no connection for system nope");
    expect(await runCli(["connect", "--region", "us-east-1", "--role-arn", ROLE], deps)).toBe(1);
  });

  it("surfaces a credential/scope mismatch instead of discovering", async () => {
    deps.readPort = async () =>
      ({
        ...restaurantPort(),
        context: { accountId: "999999999999", region: "us-east-1" },
      }) as never;
    expect(
      await runCli(
        ["connect", "--stack", "restaurant-app-prod", "--region", "us-east-1", "--role-arn", ROLE],
        deps,
      ),
    ).toBe(1);
    expect(errs.join()).toContain("credentials resolve to 999999999999");
  });

  it("does not expose any mutation command yet", async () => {
    for (const c of ["plan", "changes", "apply", "deploy"])
      expect(await runCli([c], deps)).not.toBe(0);
  });
});
