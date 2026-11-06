import { ZodType } from "zod";
import type { AgentTool } from "./tools.js";
import { graphTools } from "./tools.js";
import { opsTools } from "./ops-tools.js";
import { repoTools } from "./repo-tools.js";

const RESERVED = new Set(["submit_answer", "submit_plan"]);
const NAME = /^[a-z][a-z0-9_]{2,47}$/;

export class ToolRegistryError extends Error {}

/**
 * Extension point for third-party tools. Plugins can only add read-only tools: the registry rejects
 * any other access level, reserved or duplicate names, and tools without a Zod input schema.
 * It does not load code; callers import plugins themselves and register the resulting tools.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(builtins: AgentTool[] = []) {
    for (const t of builtins) this.tools.set(t.name, t);
  }

  register(tool: AgentTool): this {
    if (!NAME.test(tool.name))
      throw new ToolRegistryError(
        `invalid tool name "${tool.name}" (lowercase letters, digits, underscores; 3-48 chars)`,
      );
    if (RESERVED.has(tool.name))
      throw new ToolRegistryError(`tool name "${tool.name}" is reserved`);
    if (this.tools.has(tool.name))
      throw new ToolRegistryError(`tool "${tool.name}" is already registered`);
    if ((tool.access as string) !== "read")
      throw new ToolRegistryError(
        `tool "${tool.name}" is not read-only; plugins cannot register mutating tools`,
      );
    if (!(tool.input instanceof ZodType))
      throw new ToolRegistryError(`tool "${tool.name}" must declare a Zod input schema`);
    if (!tool.description.trim())
      throw new ToolRegistryError(`tool "${tool.name}" needs a description`);
    this.tools.set(tool.name, tool);
    return this;
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }
}

/** Registry preloaded with every built-in read tool. */
export function defaultToolRegistry(opts: { ops?: boolean; repo?: boolean } = {}): ToolRegistry {
  return new ToolRegistry([
    ...graphTools,
    ...(opts.ops ? opsTools : []),
    ...(opts.repo ? repoTools : []),
  ]);
}
