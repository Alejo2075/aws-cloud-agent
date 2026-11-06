import { z } from "zod";
import { wrapUntrusted } from "@cloud-agent/evidence";
import { findResource } from "@cloud-agent/graph";
import { RepoAccessError, detectIac, mapResourcesToSource } from "@cloud-agent/tools-git";
import { defineTool } from "./tools.js";
import type { AgentTool, ToolContext, ToolResult } from "./tools.js";

const noRepo = (): ToolResult => ({
  data: {
    error:
      "no source repository is linked to this connection; source-level questions cannot be answered from evidence",
  },
  observations: [],
});

async function handlerFor(ctx: ToolContext, resourceId: string): Promise<string | undefined> {
  for (const o of (await ctx.evidence.list()).filter((x) => x.resource === resourceId)) {
    const p = (await ctx.evidence.getPayload(o.evidenceRef)) as { summary?: { handler?: unknown } };
    if (typeof p.summary?.handler === "string") return p.summary.handler;
  }
  return undefined;
}

export const inspectRepository = defineTool({
  name: "inspect_repository",
  description:
    "Detect the linked repository's IaC tool (CDK, SAM, CloudFormation, Terraform), its revision and whether the working tree is dirty.",
  access: "read",
  input: z.object({}),
  async run(ctx) {
    if (!ctx.repo) return noRepo();
    const [iac, rev] = await Promise.all([detectIac(ctx.repo), ctx.repo.revision()]);
    const obs = await ctx.evidence.record(
      { source: "RepositoryInspection", limitations: iac.notes, confidence: "medium" },
      { iac, rev },
      ctx.now,
    );
    return { data: { observationId: obs.id, ...iac, ...rev }, observations: [obs] };
  },
});

export const findSourceForResource = defineTool({
  name: "find_source_for_resource",
  description:
    "Heuristically locate the IaC definition and handler source for a resource. Results include the basis and confidence of each match.",
  access: "read",
  input: z.object({ resource: z.string().min(1) }),
  async run(ctx, input) {
    if (!ctx.repo) return noRepo();
    const r = findResource(ctx.graph, input.resource);
    if (!r) return { data: { error: `no resource matches ${input.resource}` }, observations: [] };
    const handler = await handlerFor(ctx, r.id);
    const refs = await mapResourcesToSource(
      ctx.repo,
      { ...ctx.graph, resources: [r] },
      handler ? { [r.id]: handler } : {},
    );
    const obs = await ctx.evidence.record(
      {
        source: "SourceMapping",
        resource: r.id,
        confidence: refs.length ? "medium" : "low",
        limitations: refs.length
          ? ["mapping is heuristic text matching"]
          : ["no matching source found"],
      },
      refs,
      ctx.now,
    );
    return { data: { observationId: obs.id, matches: refs }, observations: [obs] };
  },
});

export const readSourceFile = defineTool({
  name: "read_source_file",
  description:
    "Read up to 200 lines of a file in the linked repository. Secret-bearing files and paths outside the repository are refused.",
  access: "read",
  input: z.object({
    path: z.string().min(1),
    startLine: z.number().int().min(1).default(1),
    maxLines: z.number().int().min(1).max(200).default(120),
  }),
  async run(ctx, input) {
    if (!ctx.repo) return noRepo();
    try {
      const f = await ctx.repo.readText(input.path, input.startLine, input.maxLines);
      const rev = await ctx.repo.revision();
      const obs = await ctx.evidence.record(
        {
          source: "RepositoryFile",
          resource: input.path,
          confidence: "high",
          limitations: rev.dirty
            ? ["working tree has uncommitted changes; file may differ from the deployed revision"]
            : [],
        },
        { path: input.path, startLine: input.startLine, ...rev },
        ctx.now,
      );
      return {
        data: {
          observationId: obs.id,
          path: input.path,
          totalLines: f.totalLines,
          truncated: f.truncated,
          content: wrapUntrusted(`repo:${input.path}`, f.text),
        },
        observations: [obs],
      };
    } catch (e) {
      if (e instanceof RepoAccessError) return { data: { error: e.message }, observations: [] };
      throw e;
    }
  },
});

export const repoTools = [inspectRepository, findSourceForResource, readSourceFile] as AgentTool[];
