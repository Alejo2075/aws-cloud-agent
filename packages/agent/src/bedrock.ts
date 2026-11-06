import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { ContentBlock as BrBlock, Message } from "@aws-sdk/client-bedrock-runtime";
import type { ContentBlock, ModelPort, ModelRequest, ModelResponse } from "./model.js";

export interface BedrockOptions {
  modelId: string;
  region: string;
  maxTokens?: number;
  client?: BedrockRuntimeClient;
}

const toBedrock = (b: ContentBlock): BrBlock =>
  b.type === "text"
    ? { text: b.text }
    : b.type === "toolUse"
      ? { toolUse: { toolUseId: b.id, name: b.name, input: b.input as never } }
      : {
          toolResult: {
            toolUseId: b.id,
            status: b.isError ? "error" : "success",
            content: [{ text: b.text }],
          },
        };

export class BedrockModelPort implements ModelPort {
  private readonly client: BedrockRuntimeClient;
  constructor(private readonly opts: BedrockOptions) {
    this.client = opts.client ?? new BedrockRuntimeClient({ region: opts.region });
  }

  async converse(req: ModelRequest): Promise<ModelResponse> {
    const messages: Message[] = req.messages.map((m) => ({
      role: m.role,
      content: m.content.map(toBedrock),
    }));
    const r = await this.client.send(
      new ConverseCommand({
        modelId: this.opts.modelId,
        system: [{ text: req.system }],
        messages,
        inferenceConfig: { maxTokens: this.opts.maxTokens ?? 2048, temperature: 0 },
        toolConfig: {
          tools: req.tools.map((t) => ({
            toolSpec: {
              name: t.name,
              description: t.description,
              inputSchema: { json: t.inputSchema as never },
            },
          })),
        },
      }),
    );
    const content: ContentBlock[] = (r.output?.message?.content ?? []).flatMap(
      (b): ContentBlock[] => {
        if (b.text) return [{ type: "text", text: b.text }];
        if (b.toolUse?.name && b.toolUse.toolUseId)
          return [
            {
              type: "toolUse",
              id: b.toolUse.toolUseId,
              name: b.toolUse.name,
              input: b.toolUse.input,
            },
          ];
        return [];
      },
    );
    const stopReason =
      r.stopReason === "tool_use"
        ? "tool_use"
        : r.stopReason === "end_turn"
          ? "end_turn"
          : r.stopReason === "max_tokens"
            ? "max_tokens"
            : "other";
    return { content, stopReason };
  }
}
