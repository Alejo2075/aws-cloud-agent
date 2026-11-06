import type { IacKind } from "@cloud-agent/contracts";
import type { RepoReader } from "./repo.js";

export interface IacDetection {
  kind: IacKind;
  roots: string[];
  evidence: string[];
  notes: string[];
}

/** Detect which IaC tool owns the deployed resources. Several can coexist; CDK wins over raw CFN output. */
export async function detectIac(repo: RepoReader): Promise<IacDetection> {
  const { files, truncated } = await repo.listFiles();
  const dir = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".");
  const found: Record<Exclude<IacKind, "unknown">, string[]> = {
    "aws-cdk": [],
    "aws-sam": [],
    cloudformation: [],
    terraform: [],
  };
  for (const f of files) {
    const base = f.split("/").pop()!;
    if (base === "cdk.json") found["aws-cdk"].push(f);
    else if (base === "samconfig.toml" || base === "template.yaml" || base === "template.yml")
      found["aws-sam"].push(f);
    else if (base.endsWith(".tf")) found.terraform.push(f);
  }
  for (const f of files) {
    if (
      !/\.(ya?ml|json|template)$/.test(f) ||
      found["aws-sam"].includes(f) ||
      /(package|tsconfig|cdk)\.json$/.test(f)
    )
      continue;
    try {
      const { text } = await repo.readText(f, 1, 40);
      if (
        /AWSTemplateFormatVersion|Resources:\s*$/m.test(text) &&
        /Type:\s*['"]?AWS::|"Type"\s*:\s*"AWS::/.test(text)
      )
        found.cloudformation.push(f);
    } catch {
      /* unreadable files are not evidence */
    }
  }
  // A SAM template is CloudFormation with a Transform; keep it classified as SAM only when marked.
  const kinds = (Object.keys(found) as Array<keyof typeof found>).filter((k) => found[k].length);
  const kind: IacKind = found["aws-cdk"].length
    ? "aws-cdk"
    : found["aws-sam"].length
      ? "aws-sam"
      : found.terraform.length
        ? "terraform"
        : found.cloudformation.length
          ? "cloudformation"
          : "unknown";
  const notes = [];
  if (kinds.length > 1)
    notes.push(
      `multiple IaC tools detected (${kinds.join(", ")}); ownership of individual resources is uncertain`,
    );
  if (truncated) notes.push("repository listing truncated; detection may be incomplete");
  if (kind === "unknown")
    notes.push("no IaC definitions found; changes cannot be made through a source of truth");
  return {
    kind,
    roots: [...new Set(found[kind === "unknown" ? "terraform" : kind].map(dir))],
    evidence: kinds.flatMap((k) => found[k]).slice(0, 10),
    notes,
  };
}
