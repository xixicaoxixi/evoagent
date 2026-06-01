import type {
  LLMProvider,
  LLMMessageParam,
  LLMResponse,
  LLMStreamChunk,
  StreamOptions,
  ToolCall,
  ToolDefinition,
  ContentPart,
  TokenUsage,
} from "../interfaces/llm-provider";
import { extractContentText } from "../interfaces/llm-provider";
import { estimateTokens, getModelCapabilities } from "../types/common";
import { DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS } from "../types/common";
import { extractStatusCode } from "../observability/chat-diagnostics";
import { getProviderDefaults, type ProviderDefaults } from "../types/provider-defaults";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

const FIXED_TEMPERATURE_MODELS: Readonly<Record<string, number>> = {
  "kimi-k2.5": 1,
  "kimi-k2.6": 1,
};

function getFixedTemperature(model: string): number | undefined {
  return FIXED_TEMPERATURE_MODELS[model];
}

export interface OpenAIProviderConfig {
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly toolSearch?: boolean;
  readonly allowedTools?: readonly string[];
  readonly timeoutMs?: number;
  readonly tools?: readonly ToolDefinition[];
}

function resolveApiKey(apiKey: unknown): string {
  if (typeof apiKey === "string") return apiKey;
  if (typeof apiKey === "object" && apiKey !== null) {
    const ref = apiKey as { source?: string; id?: string };
    if (ref.source === "env" && typeof ref.id === "string") {
      return process.env[ref.id] ?? "";
    }
  }
  return "";
}

function convertContentParts(parts: readonly ContentPart[]): unknown[] {
  return parts.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image_url":
        return {
          type: "image_url",
          image_url: {
            url: part.image_url.url,
            ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
          },
        };
      case "video_url":
        return {
          type: "video_url",
          video_url: { url: part.video_url.url },
        };
      default:
        return { type: "text", text: "" };
    }
  });
}

function convertMessages(
  messages: readonly LLMMessageParam[],
): unknown[] {
  return messages.map((msg) => {
    const base: Record<string, unknown> = { role: msg.role };

    if (msg.role === "tool_use") {
      base.role = "assistant";
      base.content = null;
      base.tool_calls = [{
        id: msg.toolUseId ?? "",
        type: "function",
        function: {
          name: msg.toolName ?? "",
          arguments: JSON.stringify(msg.toolInput ?? {}),
        },
      }];
    } else if (msg.role === "tool_result") {
      base.role = "tool";
      base.tool_call_id = msg.toolUseId ?? "";
      base.content = msg.toolResultContent ?? "";
    } else if (typeof msg.content === "string") {
      base.content = msg.content;
    } else {
      base.content = convertContentParts(msg.content);
    }

    if (msg.thinkingContent) {
      base.thinking = msg.thinkingContent;
    }

    return base;
  });
}

function convertTools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
    },
  }));
}

export class OpenAIProvider implements LLMProvider {
  readonly providerType = "openai";
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly reasoningEffort: ReasoningEffort | undefined;
  private readonly toolSearch: boolean;
  private readonly allowedTools: readonly string[] | undefined;
  private readonly timeoutMs: number;
  private tools: readonly ToolDefinition[] | undefined;

  private readonly isReasonerModel: boolean;

  constructor(config: OpenAIProviderConfig = {}) {
    const providerDefaults = getProviderDefaults("openai");
    const inferredDefaults = config.model ? getModelProviderDefaults(config.model) : providerDefaults;
    this.model = config.model ?? inferredDefaults.model ?? providerDefaults.model ?? "gpt-5.4";
    this.apiKey = resolveApiKey(config.apiKey);
    this.baseUrl = config.baseUrl ?? inferredDefaults.baseUrl ?? providerDefaults.baseUrl ?? "https://api.openai.com/v1";
    this.temperature = config.temperature ?? inferredDefaults.temperature ?? providerDefaults.temperature ?? DEFAULT_TEMPERATURE;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.reasoningEffort = config.reasoningEffort;
    this.toolSearch = config.toolSearch ?? false;
    this.allowedTools = config.allowedTools;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tools = config.tools;
    this.isReasonerModel = /^(deepseek-r1|deepseek-reasoner|deepseek-v4|o[1-9]|kimi-k2-thinking)/.test(this.model);
  }

  setTools(tools: readonly ToolDefinition[]): void {
    this.tools = tools.length > 0 ? tools : undefined;
  }

  async invoke(messages: readonly LLMMessageParam[]): Promise<LLMResponse> {
    let content = "";
    let thinkingContent = "";
    let toolCalls: ToolCall[] | undefined;
    let stopReason = "end_turn";
    let tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of this.stream(messages)) {
      if (chunk.type === "content") {
        content += chunk.content;
      } else if (chunk.type === "thinking") {
        thinkingContent += chunk.content;
      } else if (chunk.type === "tool_use") {
        if (!toolCalls) toolCalls = [];
        toolCalls.push({ id: chunk.toolUseId, name: chunk.toolName, input: chunk.input });
      } else if (chunk.type === "stop") {
        stopReason = chunk.stopReason ?? "end_turn";
        if (chunk.tokenUsage) {
          tokenUsage = chunk.tokenUsage;
        }
      } else if (chunk.type === "error") {
        throw new Error(chunk.error);
      }
    }

    return {
      content,
      ...(thinkingContent ? { thinkingContent } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      stopReason,
      model: this.model,
      tokenUsage,
    };
  }

  async *stream(
    messages: readonly LLMMessageParam[],
    options?: StreamOptions,
  ): AsyncGenerator<LLMStreamChunk> {
    const fixedTemp = getFixedTemperature(this.model);
    const temperature = fixedTemp ?? this.temperature;
    const effectiveMaxTokens = options?.maxTokens ?? this.maxTokens;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: convertMessages(messages),
      stream: true,
      ...(!this.isReasonerModel ? { temperature } : {}),
      max_tokens: effectiveMaxTokens,
      stream_options: { include_usage: true },
    };

    if (this.reasoningEffort) {
      body.reasoning = { effort: this.reasoningEffort };
    }

    if (this.toolSearch) {
      body.tool_search = { type: "auto" };
    }

    if (this.allowedTools && this.allowedTools.length > 0) {
      body.allowed_tools = this.allowedTools;
    }

    const effectiveTools = options?.tools ?? this.tools;
    if (effectiveTools && effectiveTools.length > 0) {
      body.tools = convertTools(effectiveTools);
    }

    const estimatedInputSize = messages.reduce(
      (sum, m) => sum + extractContentText(m.content).length, 0,
    );
    const dynamicTimeout = estimatedInputSize > 10_000
      ? Math.min(this.timeoutMs * 2, 1_200_000)
      : this.timeoutMs;

    const controller = new AbortController();
    const connectionTimeout = setTimeout(() => controller.abort(), 30_000);
    let chunkTimeout: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => controller.abort(), dynamicTimeout,
    );

    let firstChunkReceived = false;

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!firstChunkReceived) {
        firstChunkReceived = true;
        clearTimeout(connectionTimeout);
      }

      if (!response.ok) {
        const error = await response.text();
        yield {
          type: "error",
          error: `OpenAI API error (${response.status}): ${error}`,
        } as LLMStreamChunk;
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body for streaming");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let finalUsage: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | undefined;
      let accumulatedContent = "";
      const toolCallAccumulators = new Map<string, {
        toolUseId: string;
        toolName: string;
        argumentsBuffer: string;
      }>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        clearTimeout(chunkTimeout);
        chunkTimeout = setTimeout(() => controller.abort(), 120_000);

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            for (const [, acc] of toolCallAccumulators) {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(acc.argumentsBuffer) as Record<string, unknown>;
              } catch {
                input = { raw: acc.argumentsBuffer };
              }
              yield {
                type: "tool_use",
                toolUseId: acc.toolUseId,
                toolName: acc.toolName,
                input,
              };
            }
            toolCallAccumulators.clear();

            yield {
              type: "stop",
              tokenUsage: {
                inputTokens: finalUsage?.prompt_tokens ?? estimateTokens(messages.map((m) => extractContentText(m.content)).join("")),
                outputTokens: finalUsage?.completion_tokens ?? estimateTokens(accumulatedContent),
              },
            };
            return;
          }

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  reasoning_content?: string;
                  tool_calls?: Array<{
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string | null;
              }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                completion_tokens_details?: { reasoning_tokens?: number };
              };
            };

            if (parsed.usage) {
              finalUsage = parsed.usage;
            }

            const choice = parsed.choices?.[0];
            const delta = choice?.delta;

            if (delta?.reasoning_content) {
              yield { type: "thinking", content: delta.reasoning_content };
            }

            if (delta?.content) {
              accumulatedContent += delta.content;
              yield { type: "content", content: delta.content };
            }

            const toolCalls = delta?.tool_calls;
            if (toolCalls && toolCalls.length > 0) {
              for (const tc of toolCalls) {
                const accKey = tc.id ?? tc.function?.name ?? "";
                if (tc.function?.name) {
                  toolCallAccumulators.set(accKey, {
                    toolUseId: tc.id ?? "",
                    toolName: tc.function.name,
                    argumentsBuffer: tc.function.arguments ?? "",
                  });
                } else if (tc.function?.arguments && toolCallAccumulators.has(accKey)) {
                  const acc = toolCallAccumulators.get(accKey)!;
                  acc.argumentsBuffer += tc.function.arguments;
                } else if (tc.id && tc.function?.arguments) {
                  const existing = toolCallAccumulators.get(tc.id);
                  if (existing) {
                    existing.argumentsBuffer += tc.function.arguments;
                  }
                }
              }
            }

            if (choice?.finish_reason) {
              for (const [, acc] of toolCallAccumulators) {
                let input: Record<string, unknown> = {};
                try {
                  input = JSON.parse(acc.argumentsBuffer) as Record<string, unknown>;
                } catch {
                  input = { raw: acc.argumentsBuffer };
                }
                yield {
                  type: "tool_use",
                  toolUseId: acc.toolUseId,
                  toolName: acc.toolName,
                  input,
                };
              }
              toolCallAccumulators.clear();

              yield {
                type: "stop",
                stopReason: choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
                tokenUsage: {
                  inputTokens: finalUsage?.prompt_tokens ?? estimateTokens(messages.map((m) => extractContentText(m.content)).join("")),
                  outputTokens: finalUsage?.completion_tokens ?? estimateTokens(accumulatedContent),
                  ...(finalUsage?.completion_tokens_details?.reasoning_tokens != null ? { reasoningTokens: finalUsage.completion_tokens_details.reasoning_tokens } : {}),
                },
              };
              return;
            }
          } catch (parseError) {
            yield {
              type: "error",
              error: parseError instanceof Error ? parseError.message : String(parseError),
            } as LLMStreamChunk;
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        yield {
          type: "error",
          error: `LLM request timed out after ${dynamicTimeout}ms. Consider reducing maxTokens or splitting the request.`,
        } as LLMStreamChunk;
        return;
      }
      throw err;
    } finally {
      clearTimeout(connectionTimeout);
      clearTimeout(chunkTimeout);
    }
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

function getModelProviderDefaults(model: string): ProviderDefaults {
  if (/^kimi/i.test(model) || /^moonshot/i.test(model)) {
    return getProviderDefaults("kimi");
  }
  if (/^deepseek/i.test(model)) {
    return getProviderDefaults("deepseek");
  }
  if (/^glm/i.test(model)) {
    return getProviderDefaults("glm");
  }
  return getProviderDefaults("openai");
}

export function classifyOpenAIError(error: unknown): {
  readonly category: "auth" | "rate_limit" | "server" | "network" | "client" | "unknown";
  readonly statusCode?: number;
  readonly retriable: boolean;
  readonly message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode = extractStatusCode(message);
  const category =
    statusCode === 401 || statusCode === 403 ? "auth"
    : statusCode === 429 ? "rate_limit"
    : statusCode !== undefined && statusCode >= 500 ? "server"
    : statusCode !== undefined && statusCode >= 400 ? "client"
    : /fetch failed|network|timeout|aborted/i.test(message) ? "network"
    : "unknown";

  return {
    category,
    ...(statusCode !== undefined ? { statusCode } : {}),
    retriable: category === "rate_limit" || category === "server" || category === "network",
    message,
  };
}

export function supportsModelCapability(model: string, capability: keyof ReturnType<typeof getModelCapabilities>): boolean {
  return getModelCapabilities(model)[capability];
}
