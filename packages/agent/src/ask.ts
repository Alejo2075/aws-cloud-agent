import { z } from "zod";
import type { EvidenceBackedAnswer, Observation, SystemGraph } from "@cloud-agent/contracts";
import { freshness, wrapUntrusted } from "@cloud-agent/evidence";
import type { EvidenceStore } from "@cloud-agent/evidence";
import type { ContentBlock, ModelMessage, ModelPort, ToolSpec } from "./model.js";
import { SUBMIT_TOOL, SYSTEM_PROMPT } from "./prompt.js";
import { graphTools } from "./tools.js";
import type { AgentTool } from "./tools.js";

export interface AskOptions {
  question: string;
  graph: SystemGraph | undefined;
  evidence: EvidenceStore;
  model: ModelPort;
  tools?: AgentTool[];
  now?: Date;
  maxTurns?: number;
  maxToolCalls?: number;
  /** Bounded prior Q&A for follow-ups; plain text only. */
  history?: Array<{ question: string; answer: string }>;
  onToolCall?: (event: { tool: string; input: unknown; ok: boolean }) => void;
}

const Submit = z.object({
  answer: z.string(),
  citedObservationIds: z.array(z.string()).default([]),
  hypotheses: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
});

function toJsonSchema(t: AgentTool): ToolSpec {
  const schema = z.toJSONSchema(t.input) as Record<string, unknown>;
  delete schema["$schema"];
  return { name: t.name, description: t.description, inputSchema: schema };
}

/** Missing discovery data is a first-class answer state: no model call, no invented content. */
export function noDataAnswer(): EvidenceBackedAnswer {
  return {
    answer:
      "I have no discovery data for this system, so I cannot answer from evidence. Run a discovery refresh first.",
    observations: [],
    hypotheses: [],
    limitations: ["No System Graph exists for this connection."],
  };
}

export async function askSystem(opts: AskOptions): Promise<EvidenceBackedAnswer> {
  if (!opts.graph) return noDataAnswer();
  const graph = opts.graph;
  const now = opts.now ?? new Date();
  const tools = opts.tools ?? graphTools;
  for (const t of tools)
    if (t.access !== "read")
      throw new Error(`tool ${t.name} is not read-only and cannot be used by ask`);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = [...tools.map(toJsonSchema), SUBMIT_TOOL as unknown as ToolSpec];
  const maxTurns = opts.maxTurns ?? 8;
  const maxToolCalls = opts.maxToolCalls ?? 20;

  const exposed = new Map<string, Observation>();
  const calls = new Map<string, number>();
  let toolCalls = 0;

  const messages: ModelMessage[] = [];
  for (const h of (opts.history ?? []).slice(-3)) {
    messages.push({ role: "user", content: [{ type: "text", text: h.question }] });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: h.answer.slice(0, 2000) }],
    });
  }
  messages.push({ role: "user", content: [{ type: "text", text: opts.question }] });

  const finish = (s: z.infer<typeof Submit>): EvidenceBackedAnswer => {
    const limitations = [...s.limitations];
    const cited = s.citedObservationIds.filter((id) => exposed.has(id));
    const dropped = s.citedObservationIds.length - cited.length;
    if (dropped)
      limitations.push(`${dropped} citation(s) did not match any tool output and were removed.`);
    if (!cited.length) limitations.push("No evidence was cited; treat this answer as unverified.");
    if (freshness(graph.builtAt, now) !== "fresh")
      limitations.push(`Discovery data is from ${graph.builtAt} and may be stale.`);
    for (const g of graph.gaps) limitations.push(`Known gap: ${g}`);
    return {
      answer: s.answer,
      observations: [...new Set(cited)].map((id) => exposed.get(id)!),
      hypotheses: s.hypotheses,
      limitations: [...new Set(limitations)],
    };
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await opts.model.converse({ system: SYSTEM_PROMPT, messages, tools: specs });
    messages.push({ role: "assistant", content: res.content });
    const uses = res.content.filter(
      (b): b is Extract<ContentBlock, { type: "toolUse" }> => b.type === "toolUse",
    );

    const submit = uses.find((u) => u.name === SUBMIT_TOOL.name);
    if (submit) {
      const parsed = Submit.safeParse(submit.input);
      if (parsed.success) return finish(parsed.data);
      messages.push({
        role: "user",
        content: [
          {
            type: "toolResult",
            id: submit.id,
            text: `invalid submit_answer: ${parsed.error.message}`,
            isError: true,
          },
        ],
      });
      continue;
    }
    if (!uses.length) {
      const text = res.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n")
        .trim();
      return finish({
        answer: text || "The model returned no answer.",
        citedObservationIds: [],
        hypotheses: [],
        limitations: ["The model did not use the structured answer format."],
      });
    }

    const results: ContentBlock[] = [];
    for (const use of uses) {
      const key = `${use.name}:${JSON.stringify(use.input)}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      const tool = byName.get(use.name);
      let text: string;
      let isError = false;
      if (!tool) {
        text = `unknown tool ${use.name}`;
        isError = true;
      } else if (++toolCalls > maxToolCalls || (calls.get(key) ?? 0) > 2) {
        text = "tool call budget or repetition limit reached; answer with what you have";
        isError = true;
      } else {
        const input = tool.input.safeParse(use.input);
        if (!input.success) {
          text = `invalid input: ${input.error.message}`;
          isError = true;
        } else {
          try {
            const r = await tool.run({ graph, evidence: opts.evidence, now }, input.data);
            for (const o of r.observations) exposed.set(o.id, o);
            text = wrapUntrusted(`tool:${tool.name}`, JSON.stringify(r.data));
          } catch (e) {
            text = `tool failed: ${(e as Error).message}`;
            isError = true;
          }
        }
      }
      opts.onToolCall?.({ tool: use.name, input: use.input, ok: !isError });
      results.push({ type: "toolResult", id: use.id, text, isError });
    }
    messages.push({ role: "user", content: results });
  }
  return finish({
    answer: "I could not complete the analysis within the turn budget.",
    citedObservationIds: [],
    hypotheses: [],
    limitations: ["Turn budget exhausted before a final answer."],
  });
}
