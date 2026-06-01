/**
 * ContextEngine 接口。
 *
 * 可插拔的上下文管理引擎，支持 ingest/assemble/compact 三个核心操作。
 * RULES_2-4: 接口 + 注册表模式。
 * RULES_2-13: 多级递进（Micro → Auto → Reactive → API）。
 */

import type { Message } from "../types/message";

// ─── 上下文压缩结果 ───

export interface CompactResult {
  readonly messages: readonly Message[];
  readonly tokenCount: number;
  readonly compressionRatio: number;
  readonly qualityScore: number;
}

// ─── 上下文组装结果 ───

export interface AssembledContext {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly totalTokens: number;
  readonly isCompacted: boolean;
}

// ─── ContextEngine 接口 ───

export interface ContextEngine {
  /** 引擎名称 */
  readonly name: string;

  /** 引擎优先级（数字越小优先级越高） */
  readonly priority: number;

  /** 注入新消息到上下文 */
  ingest(message: Message): void;

  /** 组装最终上下文（用于发送给 LLM） */
  assemble(options: {
    readonly maxTokens: number;
    readonly systemPrompt?: string;
  }): Promise<AssembledContext>;

  /** 压缩上下文（减少 Token 使用） */
  compact(options: {
    readonly targetTokens: number;
    readonly reason: "micro" | "auto" | "reactive";
  }): Promise<CompactResult>;

  /** 获取当前 Token 计数 */
  getTokenCount(): number;

  /** 获取消息数量 */
  getMessageCount(): number;

  /** 清空上下文 */
  clear(): void;

  /** 获取所有消息（只读） */
  getMessages(): readonly Message[];

  /** 注入知识到上下文（可选） */
  injectKnowledge?(content: string): void;
}

// ─── ContextEngine 注册表 ───

export interface ContextEngineRegistry {
  register(engine: ContextEngine): void;
  resolve(name: string): ContextEngine | undefined;
  getDefault(): ContextEngine | undefined;
  listAll(): readonly ContextEngine[];
}
