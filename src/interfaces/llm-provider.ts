/**
 * LLMProvider 接口。
 *
 * 抽象 LLM 提供商，支持 invoke（同步）和 stream（流式）两种调用模式。
 * RULES_2-4: 接口 + 注册表模式。
 *
 * Session A.2 升级：
 * - 多模态 ContentPart 支持（text / image_url / video_url）
 * - thinking/reasoning 内容支持
 * - ToolCall 接口定义
 * - TokenUsage 增加 reasoningTokens
 * - LLMStreamChunkThinking 流式块
 * - StopReason 字面量联合类型
 * - tool_use / tool_result 消息角色
 */

// ─── 多模态内容部分 ───

/** 图片详情级别 */
export type ImageDetail = "auto" | "low" | "high";

/** 多模态内容部分（Discriminated Union） */
export type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image_url";
      readonly image_url: { readonly url: string; readonly detail?: ImageDetail };
    }
  | { readonly type: "video_url"; readonly video_url: { readonly url: string } };

// ─── Tool Call ───

/** 工具调用描述 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** 工具定义（用于请求中的 tools 参数） */
export interface ToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

// ─── Stop Reason ───

/** 停止原因字面量联合类型 */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "stop_sequence"
  | "model_context_window_exceeded"
  | string;

// ─── LLM 消息格式（API 层） ───

/** LLM 消息角色 */
export type LLMMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool_use"
  | "tool_result";

/** LLM 消息参数（支持多模态 + tool calling） */
export interface LLMMessageParam {
  readonly role: LLMMessageRole;
  readonly content: string | readonly ContentPart[];
  /** tool_use 消息的工具调用 ID */
  readonly toolUseId?: string;
  /** tool_use 消息的工具名称 */
  readonly toolName?: string;
  /** tool_use 消息的工具输入 */
  readonly toolInput?: Record<string, unknown>;
  /** tool_result 消息的执行结果 */
  readonly toolResultContent?: string;
  /** tool_result 消息是否为错误 */
  readonly isToolError?: boolean;
  /** assistant 消息的 thinking/reasoning 内容 */
  readonly thinkingContent?: string;
}

// ─── Token 使用统计 ───

/** Token 使用统计（含 reasoning tokens） */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
}

// ─── LLM 响应 ───

/** LLM 同步响应 */
export interface LLMResponse {
  readonly content: string;
  readonly thinkingContent?: string;
  readonly stopReason: StopReason;
  readonly model: string;
  readonly tokenUsage: TokenUsage;
  readonly toolCalls?: readonly ToolCall[];
}

// ─── 流式响应块（Discriminated Union） ───

/** 流式文本内容块 */
export interface LLMStreamChunkContent {
  readonly type: "content";
  readonly content: string;
}

/** 流式 thinking/reasoning 内容块 */
export interface LLMStreamChunkThinking {
  readonly type: "thinking";
  readonly content: string;
}

/** 流式工具调用块 */
export interface LLMStreamChunkToolUse {
  readonly type: "tool_use";
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

/** 流式停止块 */
export interface LLMStreamChunkStop {
  readonly type: "stop";
  readonly stopReason?: StopReason;
  readonly tokenUsage?: TokenUsage;
}

/** 流式错误块 */
export interface LLMStreamChunkError {
  readonly type: "error";
  readonly error: string;
}

/** 流式响应块联合类型 */
export type LLMStreamChunk =
  | LLMStreamChunkContent
  | LLMStreamChunkThinking
  | LLMStreamChunkToolUse
  | LLMStreamChunkStop
  | LLMStreamChunkError;

// ─── Stream Options ───

export interface StreamOptions {
  readonly tools?: readonly ToolDefinition[];
  readonly maxTokens?: number;
}

// ─── LLMProvider 接口 ───

export interface LLMProvider {
  readonly providerType: string;

  readonly model: string;

  readonly temperature: number;

  readonly maxTokens: number;

  invoke(messages: readonly LLMMessageParam[]): Promise<LLMResponse>;

  stream(
    messages: readonly LLMMessageParam[],
    options?: StreamOptions,
  ): AsyncGenerator<LLMStreamChunk>;

  countTokens(text: string): number;

  healthCheck(): Promise<boolean>;
}

// ─── Provider 配置 ───

/** Provider 通用配置 */
export interface ProviderConfig {
  readonly providerType?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

// ─── 辅助函数 ───

/** 从 content（string | ContentPart[]）中提取纯文本 */
export function extractContentText(
  content: string | readonly ContentPart[],
): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { readonly type: "text"; readonly text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}
