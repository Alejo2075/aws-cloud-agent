import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ToolRegistry } from "./registry.js";
import { defineTool } from "./tools.js";
import type { AgentTool } from "./tools.js";

export const PluginConfig = z.object({
  plugins: z
    .array(
      z.object({
        path: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        /** "process" runs the plugin in a permission-restricted child process (see sandbox.ts). */
        isolation: z.enum(["in-process", "process"]).default("in-process"),
      }),
    )
    .default([]),
});
export type PluginConfig = z.infer<typeof PluginConfig>;
export type PluginConfigInput = z.input<typeof PluginConfig>;

/** What a plugin module receives: the host's zod and defineTool, so schemas are the same instances the registry checks. */
export interface PluginApi {
  z: typeof z;
  defineTool: typeof defineTool;
}

export interface LoadResult {
  loaded: Array<{ path: string; tools: string[] }>;
  errors: Array<{ path: string; error: string }>;
}

export const sha256File = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/**
 * Loads operator-approved plugins. Each entry must be an absolute path whose current sha256 equals the pinned one;
 * the module must export `createTools(api)` returning read-only tools. A plugin is registered all-or-nothing.
 *
 * SECURITY: a plugin is arbitrary code running in this process with your privileges (the registry limits what
 * the *agent* may call, not what plugin code can do). Only pin code you have reviewed. The hash covers the entry
 * file only, so ship plugins as a single bundled file.
 */
export async function loadPlugins(
  configInput: PluginConfigInput,
  registry: ToolRegistry,
): Promise<LoadResult> {
  const config = PluginConfig.parse(configInput);
  const result: LoadResult = { loaded: [], errors: [] };
  for (const entry of config.plugins.filter((p) => p.isolation === "in-process")) {
    try {
      if (!isAbsolute(entry.path)) throw new Error("plugin path must be absolute");
      const actual = await sha256File(entry.path);
      if (actual !== entry.sha256)
        throw new Error(
          `sha256 mismatch (pinned ${entry.sha256.slice(0, 12)}…, file is ${actual.slice(0, 12)}…); the plugin changed since it was approved`,
        );
      const mod = (await import(pathToFileURL(entry.path).href)) as {
        createTools?: (api: PluginApi) => AgentTool[] | Promise<AgentTool[]>;
      };
      if (typeof mod.createTools !== "function")
        throw new Error("plugin must export createTools(api)");
      const tools = await mod.createTools({ z, defineTool });
      const trial = new ToolRegistry(registry.list());
      for (const t of tools) trial.register(t);
      for (const t of tools) registry.register(t);
      result.loaded.push({ path: entry.path, tools: tools.map((t) => t.name) });
    } catch (e) {
      result.errors.push({ path: entry.path, error: (e as Error).message });
    }
  }
  return result;
}
