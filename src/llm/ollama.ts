import type {
  LLMProvider,
  LLMMessageParam,
  LLMResponse,
  LLMStreamChunk,
  StreamOptions,
} from "../interfaces/llm-provider";
import { extractContentText } from "../interfaces/llm-provider";
import { estimateTokens } from "../types/common";
import { DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS } from "../types/common";
import { getProviderDefaults } from "../types/provider-defaults";

export interface OllamaProviderConfig {
  readonly model?: string;
  readonly baseUrl?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

function convertMessages(messages: readonly LLMMessageParam[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: extractContentText(message.content),
  }));
}

export class OllamaProvider implements LLMProvider {
  readonly providerType = "ollama";
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  private readonly baseUrl: string;

  constructor(config: OllamaProviderConfig = {}) {
    const defaults = getProviderDefaults("ollama");
    this.model = config.model ?? defaults.model ?? "llama3";
    this.baseUrl = config.baseUrl ?? defaults.baseUrl ?? "http://localhost:11434";
    this.temperature = config.temperature ?? DEFAULT_TEMPERATURE;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async invoke(messages: readonly LLMMessageParam[]): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: convertMessages(messages),
        stream: false,
        options: {
          temperature: this.temperature,
          num_predict: this.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${error}`);
    }

    const data = await response.json() as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const content = data.message?.content ?? "";
    return {
      content,
      stopReason: "end_turn",
      model: this.model,
      tokenUsage: {
        inputTokens: data.prompt_eval_count ?? estimateTokens(messages.map((m) => extractContentText(m.content)).join("")),
        outputTokens: data.eval_count ?? estimateTokens(content),
      },
    };
  }

  async *stream(messages: readonly LLMMessageParam[], _options?: StreamOptions): AsyncGenerator<LLMStreamChunk> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: convertMessages(messages),
        stream: true,
        options: {
          temperature: this.temperature,
          num_predict: this.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      yield { type: "error", error: `Ollama API error (${response.status}): ${error}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "error", error: "No response body for streaming" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let promptEvalCount = 0;
    let evalCount = 0;
    let accumulatedContent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed) as {
            message?: { content?: string };
            done?: boolean;
            prompt_eval_count?: number;
            eval_count?: number;
          };

          if (parsed.message?.content) {
            accumulatedContent += parsed.message.content;
            yield { type: "content", content: parsed.message.content };
          }

          if (typeof parsed.prompt_eval_count === "number") {
            promptEvalCount = parsed.prompt_eval_count;
          }
          if (typeof parsed.eval_count === "number") {
            evalCount = parsed.eval_count;
          }

          if (parsed.done) {
            yield {
              type: "stop",
              tokenUsage: {
                inputTokens: promptEvalCount || estimateTokens(messages.map((m) => extractContentText(m.content)).join("")),
                outputTokens: evalCount || estimateTokens(accumulatedContent),
              },
            };
            return;
          }
        } catch {
        }
      }
    }
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { method: "GET" });
      return response.ok;
    } catch {
      return false;
    }
  }
}
