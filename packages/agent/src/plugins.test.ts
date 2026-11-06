import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultToolRegistry, loadPlugins, sha256File } from "./index.js";

async function plugin(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "plug-"));
  const path = join(dir, "plugin.mjs");
  await writeFile(path, body);
  return { path, sha256: await sha256File(path) };
}
const good = `export function createTools({ z, defineTool }) {
  return [defineTool({ name: "ticket_lookup", description: "Look up a ticket", access: "read", input: z.object({ id: z.string() }), run: async () => ({ data: { ok: true }, observations: [] }) })];
}`;

describe("loadPlugins", () => {
  it("loads a pinned plugin and registers its read-only tools", async () => {
    const reg = defaultToolRegistry();
    const r = await loadPlugins({ plugins: [await plugin(good)] }, reg);
    expect(r.errors).toEqual([]);
    expect(r.loaded[0]!.tools).toEqual(["ticket_lookup"]);
    expect(reg.list().some((t) => t.name === "ticket_lookup")).toBe(true);
  });
  it("refuses a plugin whose file changed after it was pinned", async () => {
    const p = await plugin(good);
    await writeFile(p.path, `${good}\n// tampered`);
    const r = await loadPlugins({ plugins: [p] }, defaultToolRegistry());
    expect(r.errors[0]!.error).toContain("sha256 mismatch");
    expect(r.loaded).toEqual([]);
  });
  it("rejects relative paths, missing exports and mutating tools, all-or-nothing", async () => {
    const reg = defaultToolRegistry();
    const mixed = await plugin(`export function createTools({ z, defineTool }) {
      const mk = (name, access) => defineTool({ name, description: "d", access, input: z.object({}), run: async () => ({ data: {}, observations: [] }) });
      return [mk("fine_tool", "read"), mk("danger_tool", "write")];
    }`);
    const none = await plugin("export const x = 1;");
    const r = await loadPlugins(
      { plugins: [{ path: "relative.mjs", sha256: "0".repeat(64) }, none, mixed] },
      reg,
    );
    expect(r.errors.map((e) => e.error)).toEqual([
      expect.stringContaining("absolute"),
      expect.stringContaining("createTools"),
      expect.stringContaining("not read-only"),
    ]);
    expect(reg.list().some((t) => t.name === "fine_tool")).toBe(false);
  });
});
