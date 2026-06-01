/**
 * MockProvider — 测试用模拟 Provider。
 *
 * 模式匹配响应，用于单元测试和集成测试。
 */

import type {
  LLMProvider,
  LLMMessageParam,
  LLMResponse,
  LLMStreamChunk,
  StreamOptions,
} from "../interfaces/llm-provider";
import { estimateTokens } from "../types/common";
import { DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS } from "../types/common";

export interface MockProviderConfig {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFn?: (messages: readonly LLMMessageParam[]) => string;
  readonly defaultResponse?: string;
  readonly shouldFail?: boolean;
  readonly latencyMs?: number;
}

export class MockProvider implements LLMProvider {
  readonly providerType = "mock";
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  private readonly responseFn: ((messages: readonly LLMMessageParam[]) => string) | undefined;
  private readonly defaultResponse: string;
  private readonly shouldFail: boolean;
  private readonly latencyMs: number;

  readonly callHistory: Array<{
    readonly messages: readonly LLMMessageParam[];
    readonly timestamp: number;
  }> = [];

  private pendingResolvers: Array<() => void> = [];

  constructor(config: MockProviderConfig = {}) {
    this.model = config.model ?? "mock-model";
    this.temperature = config.temperature ?? DEFAULT_TEMPERATURE;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.responseFn = config.responseFn;
    this.defaultResponse = config.defaultResponse ?? "Mock response";
    this.shouldFail = config.shouldFail ?? false;
    this.latencyMs = config.latencyMs ?? 0;
  }

  async invoke(messages: readonly LLMMessageParam[]): Promise<LLMResponse> {
    this.callHistory.push({ messages, timestamp: Date.now() });

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    if (this.shouldFail) {
      this.pendingResolvers.forEach((r) => r());
      this.pendingResolvers = [];
      throw new Error("Mock provider configured to fail");
    }

    const content = this.responseFn
      ? this.responseFn(messages)
      : this.defaultResponse;

    this.pendingResolvers.forEach((r) => r());
    this.pendingResolvers = [];

    return {
      content,
      stopReason: "end_turn",
      model: this.model,
      tokenUsage: {
        inputTokens: estimateTokens(messages.map((m) => m.content).join("")),
        outputTokens: estimateTokens(content),
      },
    };
  }

  async *stream(
    messages: readonly LLMMessageParam[],
    _options?: StreamOptions,
  ): AsyncGenerator<LLMStreamChunk> {
    this.callHistory.push({ messages, timestamp: Date.now() });

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    if (this.shouldFail) {
      yield { type: "error", error: "Mock provider configured to fail" };
      return;
    }

    const content = this.responseFn
      ? this.responseFn(messages)
      : this.defaultResponse;

    // 模拟流式输出：逐字符发送
    for (const char of content) {
      yield { type: "content", content: char };
    }

    yield {
      type: "stop",
      stopReason: "end_turn",
      tokenUsage: {
        inputTokens: estimateTokens(messages.map((m) => m.content).join("")),
        outputTokens: estimateTokens(content),
      },
    };
  }

  /** 模拟带 tool_use 的流式响应 */
  async *streamWithToolUse(
    _messages: readonly LLMMessageParam[],
    toolCalls: ReadonlyArray<{
      readonly toolUseId: string;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    }>,
    textContent?: string,
  ): AsyncGenerator<LLMStreamChunk> {
    this.callHistory.push({ messages: _messages, timestamp: Date.now() });

    if (textContent) {
      for (const char of textContent) {
        yield { type: "content", content: char };
      }
    }

    for (const tc of toolCalls) {
      yield {
        type: "tool_use",
        toolUseId: tc.toolUseId,
        toolName: tc.toolName,
        input: tc.input,
      };
    }

    yield {
      type: "stop",
      stopReason: "tool_use",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
      },
    };
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  async healthCheck(): Promise<boolean> {
    return !this.shouldFail;
  }

  /** 清空调用历史 */
  clearHistory(): void {
    this.callHistory.length = 0;
  }

  /** 等待调用次数达到预期值（替代 setTimeout 的可靠等待） */
  async waitForCallCount(expectedCount: number, timeoutMs = 2000): Promise<void> {
    if (this.callHistory.length < expectedCount) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(
            `waitForCallCount timed out: expected ${expectedCount}, got ${this.callHistory.length}`,
          ));
        }, timeoutMs);

        const check = () => {
          if (this.callHistory.length >= expectedCount) {
            clearTimeout(timer);
            resolve();
          } else {
            this.pendingResolvers.push(check);
          }
        };

        check();
      });
    }

    // 让出事件循环，确保适配器的 safeInvoke 及 .then() 回调等微任务执行完毕
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
