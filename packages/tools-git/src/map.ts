import type { SourceRef, SystemGraph } from "@cloud-agent/contracts";
import type { RepoReader } from "./repo.js";

const CODE_EXT = ["ts", "js", "mjs", "py", "java", "go", "rb"];

/**
 * Heuristically link graph resources to source. Two signals only:
 *  1. IaC files mentioning the CloudFormation logical id or physical name (definition site)
 *  2. Lambda handler strings ("src/app.handler") resolved to files in the repo
 * Every mapping carries its basis and a confidence; nothing is asserted without a textual match.
 */
export async function mapResourcesToSource(
  repo: RepoReader,
  graph: SystemGraph,
  handlers: Record<string, string> = {},
): Promise<SourceRef[]> {
  const { files } = await repo.listFiles();
  const { revision } = await repo.revision();
  const iacFiles = files.filter(
    (f) => /\.(ts|js|py|ya?ml|json|tf|template)$/.test(f) && !/\.d\.ts$|\.test\.|\/test\//.test(f),
  );
  const cache = new Map<string, string[]>();
  const lines = async (f: string) => {
    if (!cache.has(f))
      cache.set(f, (await repo.readText(f, 1, 5000).catch(() => ({ text: "" }))).text.split("\n"));
    return cache.get(f)!;
  };
  const refs: SourceRef[] = [];
  const base = { ...(revision && { revision }) };
  for (const r of graph.resources) {
    const needles = [r.logicalId, r.arn?.split(/[:/]/).pop()].filter(
      (x): x is string => !!x && x.length >= 4,
    );
    let best: SourceRef | undefined;
    for (const f of iacFiles) {
      const ls = await lines(f);
      for (const needle of needles) {
        const idx = ls.findIndex((l) => l.includes(needle));
        if (idx < 0) continue;
        const isLogical = needle === r.logicalId;
        const cand: SourceRef = {
          resourceId: r.id,
          file: f,
          line: idx + 1,
          kind: "iac-definition",
          ...base,
          basis: `${isLogical ? "logical id" : "resource name"} "${needle}" appears in file`,
          confidence: isLogical ? "medium" : "low",
        };
        if (!best || (cand.confidence === "medium" && best.confidence === "low")) best = cand;
      }
    }
    if (best) refs.push(best);
    const handler = handlers[r.id];
    if (handler) {
      const modulePath = handler.slice(0, handler.lastIndexOf(".")).replace(/^\.\//, "");
      const hit = files.find((f) =>
        CODE_EXT.some((e) => f === `${modulePath}.${e}` || f.endsWith(`/${modulePath}.${e}`)),
      );
      if (hit)
        refs.push({
          resourceId: r.id,
          file: hit,
          kind: "handler-source",
          ...base,
          basis: `handler "${handler}" resolves to this file`,
          confidence: "medium",
        });
    }
  }
  return refs;
}
