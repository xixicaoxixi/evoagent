import type {
  LLMProvider,
  LLMMessageParam,
  LLMResponse,
  LLMStreamChunk,
  StreamOptions,
  ToolCall,
  ToolDefinition,
  ContentPart,
} from "../interfaces/llm-provider";
import { extractContentText } from "../interfaces/llm-provider";
import { estimateTokens } from "../types/common";
import { DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS } from "../types/common";
import { getProviderDefaults } from "../types/provider-defaults";

export type AnthropicEffort = "minimal" | "low" | "medium" | "high";

export interface ThinkingBudget {
  readonly type: "enabled" | "disabled";
  readonly budgetTokens?: number;
}

export interface AnthropicProviderConfig {
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly adaptiveThinking?: boolean;
  readonly effort?: AnthropicEffort;
  readonly structuredOutputs?:
    | boolean
    | { readonly name: string; readonly schema: Record<string, unknown> };
  readonly thinkingBudget?: ThinkingBudget;
  readonly timeoutMs?: number;
  readonly apiVersion?: string;
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
          type: "image",
          source: {
            type: "url",
            url: part.image_url.url,
          },
        };
      default:
        return { type: "text", text: "" };
    }
  });
}

function convertMessages(messages: readonly LLMMessageParam[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === "tool_result") {
      return {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.toolUseId ?? "",
          content: msg.toolResultContent ?? "",
        }],
      };
    }

    if (typeof msg.content === "string") {
      return { role: msg.role === "tool_use" ? "assistant" : msg.role, content: msg.content };
    }

    return {
      role: msg.role === "tool_use" ? "assistant" : msg.role,
      content: convertContentParts(msg.content),
    };
  });
}

function convertTools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.inputSchema,
  }));
}

function parseToolCalls(content: unknown): ToolCall[] | undefined {
  if (!Array.isArray(content)) return undefined;

  const toolCalls = content
    .filter((item) => typeof item === "object" && item !== null && (item as { type?: string }).type === "tool_use")
    .map((item) => {
      const tool = item as { id?: string; name?: string; input?: Record<string, unknown> };
      return {
        id: tool.id ?? "",
        name: tool.name ?? "",
        input: tool.input ?? {},
      };
    });

  return toolCalls.length > 0 ? toolCalls : undefined;
}

export class AnthropicProvider implements LLMProvider {
  readonly providerType = "anthropic";
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly adaptiveThinking: boolean;
  private readonly effort: AnthropicEffort | undefined;
  private readonly structuredOutputs: boolean | { readonly name: string; readonly schema: Record<string, unknown> };
  private readonly thinkingBudget: ThinkingBudget | undefined;
  private readonly timeoutMs: number;
  private readonly apiVersion: string;
  private readonly tools: readonly ToolDefinition[] | undefined;

  constructor(config: AnthropicProviderConfig = {}) {
    const defaults = getProviderDefaults("anthropic");
    this.model = config.model ?? defaults.model ?? "claude-sonnet-4-6";
    this.apiKey = resolveApiKey(config.apiKey);
    this.baseUrl = config.baseUrl ?? defaults.baseUrl ?? "https://api.anthropic.com";
    this.temperature = config.temperature ?? defaults.temperature ?? DEFAULT_TEMPERATURE;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.adaptiveThinking = config.adaptiveThinking ?? false;
    this.effort = config.effort;
    this.structuredOutputs = config.structuredOutputs ?? false;
    this.thinkingBudget = config.thinkingBudget;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.apiVersion = config.apiVersion ?? "2025-04-14";
    this.tools = config.tools;
  }

  async invoke(messages: readonly LLMMessageParam[]): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: convertMessages(messages),
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    };

    if (this.adaptiveThinking || this.effort || this.thinkingBudget !== undefined) {
      body.thinking = {
        type: "enabled",
        ...(this.effort ? { effort: this.effort } : {}),
        ...(this.thinkingBudget?.budgetTokens !== undefined ? { budget_tokens: this.thinkingBudget.budgetTokens } : {}),
      };
    }

    if (this.structuredOutputs === true) {
      body.response_format = { type: "json_schema" };
    } else if (typeof this.structuredOutputs === "object") {
      body.response_format = { type: "json_schema", json_schema: this.structuredOutputs };
    }

    if (this.tools && this.tools.length > 0) {
      body.tools = convertTools(this.tools);
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        "anthropic-version": this.apiVersion,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${error}`);
    }

    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string; thinking?: string }>;
      stop_reason?: string;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const content = data.content ?? [];
    const text = content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("");
    const thinkingContent = content.filter((item) => item.type === "thinking").map((item) => item.thinking ?? "").join("") || undefined;
    const toolCalls = parseToolCalls(data.content);

    return {
      content: text,
      ...(thinkingContent ? { thinkingContent } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      stopReason: data.stop_reason === "max_tokens" ? "max_tokens"
        : data.stop_reason === "tool_use" ? "tool_use"
        : "end_turn",
      model: data.model ?? this.model,
      tokenUsage: {
        inputTokens: data.usage?.input_tokens ?? estimateTokens(messages.map((m) => extractContentText(m.content)).join("")),
        outputTokens: data.usage?.output_tokens ?? estimateTokens(text + (thinkingContent ?? "")),
      },
    };
  }

  async *stream(messages: readonly LLMMessageParam[], options?: StreamOptions): AsyncGenerator<LLMStreamChunk> {
    const effectiveMaxTokens = options?.maxTokens ?? this.maxTokens;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: convertMessages(messages),
      max_tokens: effectiveMaxTokens,
      temperature: this.temperature,
      stream: true,
    };

    if (this.adaptiveThinking || this.effort || this.thinkingBudget !== undefined) {
      body.thinking = {
        type: "enabled",
        ...(this.effort ? { effort: this.effort } : {}),
        ...(this.thinkingBudget?.budgetTokens !== undefined ? { budget_tokens: this.thinkingBudget.budgetTokens } : {}),
      };
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
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
          "anthropic-version": this.apiVersion,
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
        yield { type: "error", error: `Anthropic API error (${response.status}): ${error}` } as LLMStreamChunk;
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        yield { type: "error", error: "No response body for streaming" } as LLMStreamChunk;
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let finalUsage: { input_tokens?: number; output_tokens?: number } | undefined;

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
          try {
            const parsed = JSON.parse(data) as {
              type?: string;
              delta?: {
                type?: string;
                text?: string;
                thinking?: string;
                stop_reason?: string;
              };
              message?: {
                stop_reason?: string;
              };
              usage?: { input_tokens?: number; output_tokens?: number };
            };

            if (parsed.usage) {
              finalUsage = parsed.usage;
            }

            if (parsed.type === "content_block_delta") {
              const delta = parsed.delta;
              if (delta?.type === "thinking" && delta.thinking) {
                yield { type: "thinking", content: delta.thinking };
              } else if (delta?.type === "text_delta" && delta.text) {
                yield { type: "content", content: delta.text };
              }
            }

            if (parsed.type === "message_delta") {
              const stopReason = parsed.delta?.stop_reason ?? parsed.message?.stop_reason ?? "end_turn";
              yield {
                type: "stop",
                stopReason: stopReason === "max_tokens" ? "max_tokens"
                  : stopReason === "tool_use" ? "tool_use"
                  : "end_turn",
                tokenUsage: {
                  inputTokens: finalUsage?.input_tokens ?? estimateTokens(messages.map((m) => extractContentText(m.content)).join("")),
                  outputTokens: finalUsage?.output_tokens ?? 0,
                },
              };
              return;
            }

            if (parsed.type === "message_stop") {
              yield {
                type: "stop",
                tokenUsage: {
                  inputTokens: finalUsage?.input_tokens ?? estimateTokens(messages.map((m) => extractContentText(m.content)).join("")),
                  outputTokens: finalUsage?.output_tokens ?? 0,
                },
              };
              return;
            }
          } catch (parseError) {
            yield { type: "error", error: parseError instanceof Error ? parseError.message : String(parseError) } as LLMStreamChunk;
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
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "OPTIONS",
        headers: {
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
          "anthropic-version": this.apiVersion,
        },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok || response.status === 405;
    } catch {
      return false;
    }
  }
}
