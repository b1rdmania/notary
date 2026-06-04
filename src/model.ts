import Anthropic from "@anthropic-ai/sdk";

/**
 * Runs a skill's prompt against Claude. This is the only place notary talks to
 * a model, and it is injectable into the runner so tests never need a network
 * or an API key. Bring your own key via ANTHROPIC_API_KEY.
 */

export interface ModelCall {
  /** The skill's prompt body, used as the system prompt. */
  system: string;
  /** The user input (e.g. the document to act on). */
  input: string;
}

export interface ModelResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export type ModelRunner = (call: ModelCall) => Promise<ModelResult>;

const DEFAULT_MODEL = process.env.NOTARY_MODEL ?? "claude-sonnet-4-6";

export const anthropicRunner: ModelRunner = async ({ system, input }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. notary runs skills with your own key.",
    );
  }
  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: input }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return {
    text,
    model: res.model,
    usage: {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    },
  };
};
