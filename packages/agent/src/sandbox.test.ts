import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultToolRegistry, loadIsolatedPlugins, sha256File } from "./index.js";
import type { IsolatedPlugins } from "./index.js";

const major = Number(process.versions.node.split(".")[0]);
const supported = major >= 25;
let live: IsolatedPlugins | undefined;
afterEach(() => live?.dispose());

async function plugin(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "iso-"));
  const path = join(dir, "plugin.mjs");
  await writeFile(path, body);
  return { path, sha256: await sha256File(path), isolation: "process" as const };
}
const probe = `export const tools = [
  { name: "probe_sandbox", description: "Echo and probe the sandbox",
    inputSchema: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
    async run({ what }) {
      const attempt = async (f) => { try { await f(); return "ALLOWED"; } catch (e) { return e.cause?.code ?? e.code ?? e.message; } };
      if (what === "echo") return { echoed: what, env: Object.keys(process.env) };
      if (what === "net") return attempt(() => fetch("https://example.com"));
      if (what === "write") return attempt(async () => (await import("node:fs/promises")).writeFile("/tmp/iso-should-not-exist", "x"));
      if (what === "read") return attempt(async () => (await import("node:fs/promises")).readFile("/etc/hosts", "utf8"));
      if (what === "spawn") return attempt(async () => (await import("node:child_process")).execFileSync("ls"));
      if (what === "hang") await new Promise(() => {});
      throw new Error("boom");
    } },
];`;

describe("loadIsolatedPlugins", () => {
  it.skipIf(supported)(
    "fails closed on Node versions that cannot deny network access",
    async () => {
      const r = await loadIsolatedPlugins(
        { plugins: [await plugin(probe)] },
        defaultToolRegistry(),
      );
      expect(r.loaded).toEqual([]);
      expect(r.errors[0]?.error).toContain("needs Node 25+");
    },
  );

  it("refuses a plugin that changed after it was pinned", async () => {
    const p = await plugin(probe);
    await writeFile(p.path, `${probe}\n// tampered`);
    const r = await loadIsolatedPlugins({ plugins: [p] }, defaultToolRegistry());
    expect(r.loaded).toEqual([]);
    expect(r.errors[0]?.error).toMatch(/sha256 mismatch|needs Node 25/);
  });

  describe.skipIf(!supported)("with the permission model available", () => {
    const call = async (what: string, opts = {}) => {
      process.env.CLOUD_AGENT_TEST_SECRET = "s3cret";
      const reg = defaultToolRegistry();
      live = await loadIsolatedPlugins({ plugins: [await plugin(probe)] }, reg, opts);
      expect(live.errors).toEqual([]);
      const tool = reg.list().find((t) => t.name === "probe_sandbox")!;
      return tool.run({} as never, { what });
    };

    it("registers read-only tools and returns data without leaking the environment", async () => {
      const r = await call("echo");
      const out = (r.data as { output: { env: string[] } }).output;
      // macOS adds __CF_USER_TEXT_ENCODING to every process; nothing from our environment may appear.
      expect(out.env.filter((k) => !k.startsWith("__CF_"))).toEqual([]);
      expect(JSON.stringify(r.data)).not.toContain("s3cret");
    });

    it("denies network, file writes, reads outside the plugin, and child processes", async () => {
      for (const what of ["net", "write", "read", "spawn"]) {
        const r = await call(what);
        expect((r.data as { output: string }).output, what).toBe("ERR_ACCESS_DENIED");
        live?.dispose();
      }
    });

    it("validates input in the host and reports plugin failures and timeouts", async () => {
      const reg = defaultToolRegistry();
      live = await loadIsolatedPlugins({ plugins: [await plugin(probe)] }, reg, {
        callTimeoutMs: 400,
      });
      const tool = reg.list().find((t) => t.name === "probe_sandbox")!;
      expect(tool.input.safeParse({ what: 5 }).success).toBe(false);
      await expect(tool.run({} as never, { what: "other" })).rejects.toThrow("boom");
      await expect(tool.run({} as never, { what: "hang" })).rejects.toThrow("timed out");
      await expect(tool.run({} as never, { what: "echo" })).rejects.toThrow("not running");
    });

    it("rejects invalid tool names and non-object schemas", async () => {
      const bad = await plugin(
        `export const tools = [{ name: "Bad Name", description: "d", inputSchema: { type: "object" }, run: async () => 1 }];`,
      );
      live = await loadIsolatedPlugins({ plugins: [bad] }, defaultToolRegistry());
      expect(live.errors[0]?.error).toContain("invalid tool name");
    });
  });
});
