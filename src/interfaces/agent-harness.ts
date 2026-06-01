/**
 * AgentHarness 接口。
 *
 * 可插拔的 Agent 运行时，提供 Agent 生命周期管理。
 * RULES_2-4: 接口 + 注册表模式。
 * 参考 `代码片段_Agent运行时与编排补充.md` 片段 #1。
 */

import type { Message } from "../types/message";
import type { Tool } from "./tool";
import type { LLMProvider } from "./llm-provider";

// ─── Agent 配置 ───

export interface AgentConfig {
  readonly agentId: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly maxTurns?: number;
  readonly tokenBudget?: number;
  readonly timeoutMs?: number;
}

// ─── Agent 执行结果 ───

export interface AgentResult {
  readonly messages: readonly Message[];
  readonly totalTokens: number;
  readonly turnCount: number;
  readonly stopReason: string;
  readonly durationMs: number;
}

// ─── Harness 支持上下文 ───

export interface AgentHarnessSupportContext {
  readonly provider: string;
  readonly modelId?: string;
  readonly requestedRuntime?: string;
}

// ─── Harness 支持结果 ───

export type AgentHarnessSupport =
  | { readonly supported: true; readonly priority?: number; readonly reason?: string }
  | { readonly supported: false; readonly reason?: string };

// ─── Harness 重置参数 ───

export interface AgentHarnessResetParams {
  readonly agentId?: string;
  readonly reason?: "new" | "reset" | "idle" | "compaction" | "deleted" | "unknown";
}

// ─── AgentHarness 接口（增强版） ───

export interface AgentHarness {
  /** Harness 唯一标识 */
  readonly id: string;

  /** Harness 显示名称 */
  readonly label: string;

  /** 能力协商：检查是否支持给定的运行时上下文 */
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;

  /** 运行 Agent（完整生命周期） */
  run(
    input: string,
    config: AgentConfig,
    tools: readonly Tool[],
    provider: LLMProvider,
  ): Promise<AgentResult>;

  /** 停止正在运行的 Agent */
  abort(agentId: string): boolean;

  /** 检查 Agent 是否正在运行 */
  isRunning(agentId: string): boolean;

  /** 压缩 Agent 会话（可选） */
  compact?(agentId: string): Promise<Message[] | undefined>;

  /** 重置 Agent 会话（可选） */
  reset?(params: AgentHarnessResetParams): Promise<void> | void;

  /** 销毁 Harness 并释放资源（可选） */
  dispose?(): Promise<void> | void;
}

// ─── 已注册的 Harness 条目 ───

export interface RegisteredAgentHarness {
  readonly harness: AgentHarness;
  readonly ownerPluginId?: string;
}
