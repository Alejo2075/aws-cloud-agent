import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { z } from "zod";
import { sha256File } from "./plugins.js";
import { PluginConfig } from "./plugins.js";
import type { LoadResult, PluginConfigInput } from "./plugins.js";
import type { ToolRegistry } from "./registry.js";
import type { AgentTool } from "./tools.js";

const HOST = fileURLToPath(new URL("./sandbox-host.js", import.meta.url));
const NAME = /^[a-z][a-z0-9_]{2,40}$/;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MIN_NODE_MAJOR = 25;

export interface SandboxOptions {
  callTimeoutMs?: number;
  startTimeoutMs?: number;
  /** Test seam; defaults to the running Node binary. */
  execPath?: string;
}

export interface IsolatedPlugins extends LoadResult {
  /** Stops every plugin process. Call when the CLI/API is done. */
  dispose(): void;
}

interface ReadyMsg {
  type: "ready";
  capabilities: Record<string, boolean>;
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
}

class PluginProcess {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }
  >();
  exited = false;
  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {}

  static async start(path: string, o: Required<SandboxOptions>) {
    const child = spawn(
      o.execPath,
      ["--permission", `--allow-fs-read=${HOST}`, `--allow-fs-read=${path}`, HOST, path],
      // Empty environment: no credentials, no AWS_* variables, no PATH to search.
      { env: {}, cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] },
    );
    const proc = new PluginProcess(child, o.callTimeoutMs);
    const ready = await new Promise<ReadyMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("plugin did not start in time"));
      }, o.startTimeoutMs);
      const fail = (m: string) => {
        clearTimeout(timer);
        reject(new Error(m));
      };
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-400)));
      child.on("error", (e) => fail(e.message));
      child.on("exit", (code) => {
        proc.onExit();
        fail(`plugin process exited (${code ?? "signal"}) before it was ready: ${stderr.trim()}`);
      });
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        let m: { type?: string; message?: string; id?: number; data?: unknown };
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        if (m.type === "ready") {
          clearTimeout(timer);
          resolve(m as unknown as ReadyMsg);
        } else if (m.type === "error") fail(`plugin failed to load: ${m.message ?? ""}`);
        else proc.onMessage(m);
      });
    });
    return { proc, ready };
  }

  private onMessage(m: { type?: string; id?: number; data?: unknown; message?: string }) {
    const p = m.id === undefined ? undefined : this.pending.get(m.id);
    if (!p || m.id === undefined) return;
    clearTimeout(p.timer);
    this.pending.delete(m.id);
    if (m.type === "result") p.resolve(m.data);
    else p.reject(new Error(m.message ?? "plugin tool failed"));
  }

  private onExit() {
    this.exited = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("plugin process exited"));
      this.pending.delete(id);
    }
  }

  call(tool: string, input: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error("plugin process is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        reject(new Error(`plugin tool timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ type: "call", id, tool, input })}\n`);
    });
  }

  kill() {
    this.exited = true;
    this.child.kill("SIGKILL");
  }
}

/**
 * Loads plugins that run in a separate Node process under the permission model: no network, no child
 * processes, no workers, no native addons, no file writes, reads limited to the pinned file, and an empty
 * environment. The plugin sees only the validated tool input and returns plain data; it gets no graph,
 * evidence or credentials. Tools are registered read-only and their output is size-capped.
 *
 * Needs Node 25+ (earlier versions cannot deny network access) and fails closed otherwise. Plugins must be a
 * single bundled file exporting `tools`: [{ name, description, inputSchema (JSON Schema), run(input) }].
 */
export async function loadIsolatedPlugins(
  configInput: PluginConfigInput,
  registry: ToolRegistry,
  opts: SandboxOptions = {},
): Promise<IsolatedPlugins> {
  const config = PluginConfig.parse(configInput);
  const o: Required<SandboxOptions> = {
    callTimeoutMs: opts.callTimeoutMs ?? 10_000,
    startTimeoutMs: opts.startTimeoutMs ?? 5_000,
    execPath: opts.execPath ?? process.execPath,
  };
  const result: LoadResult = { loaded: [], errors: [] };
  const procs: PluginProcess[] = [];
  for (const entry of config.plugins.filter((p) => p.isolation === "process")) {
    try {
      if (Number(process.versions.node.split(".")[0]) < MIN_NODE_MAJOR)
        throw new Error(
          `process isolation needs Node ${MIN_NODE_MAJOR}+ to deny network access (running ${process.versions.node}); refusing to load`,
        );
      if (!isAbsolute(entry.path)) throw new Error("plugin path must be absolute");
      // Hash and run the same resolved file, so a symlink swapped in between cannot substitute other code.
      const real = await realpath(entry.path);
      const actual = await sha256File(real);
      if (actual !== entry.sha256)
        throw new Error("sha256 mismatch; the plugin changed since it was approved");
      const { proc, ready } = await PluginProcess.start(real, o);
      procs.push(proc);
      const bad = Object.entries(ready.capabilities).filter(([, on]) => on !== false);
      if (bad.length) {
        proc.kill();
        throw new Error(
          `sandbox is not enforced (${bad.map(([k]) => k).join(", ")} still allowed); refusing to load`,
        );
      }
      const tools: AgentTool[] = ready.tools.map((t) => {
        if (!NAME.test(t.name)) throw new Error(`invalid tool name ${JSON.stringify(t.name)}`);
        const schema = t.inputSchema as { type?: string } | undefined;
        if (!schema || schema.type !== "object")
          throw new Error(`tool ${t.name}: inputSchema must be a JSON Schema object`);
        const input = z.fromJSONSchema(schema as never);
        return {
          name: t.name,
          description: String(t.description).slice(0, 500),
          access: "read" as const,
          input,
          async run(_ctx, raw) {
            const out = await proc.call(t.name, raw);
            const json = JSON.stringify(out ?? null);
            if (Buffer.byteLength(json) > MAX_OUTPUT_BYTES)
              throw new Error(`plugin output exceeds ${MAX_OUTPUT_BYTES} bytes`);
            return { data: { plugin: entry.path, output: out }, observations: [] };
          },
        };
      });
      for (const t of tools) registry.register(t);
      result.loaded.push({ path: entry.path, tools: tools.map((t) => t.name) });
    } catch (e) {
      result.errors.push({ path: entry.path, error: (e as Error).message });
    }
  }
  return { ...result, dispose: () => procs.forEach((p) => p.kill()) };
}
