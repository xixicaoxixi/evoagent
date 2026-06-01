/**
 * Loop 状态对象 — agentQueryLoop 迭代间传递的可变状态。
 *
 * 基于通用 Agent 设计模式的 Loop 状态类型设计。
 * 每次迭代开始时解构，结束时通过 `state = { ... }` 整体更新。
 */

import type { Message } from "../../types/message";
import type { Continue } from "./types";
import type { PermissionChainConfig, PermissionChainResult } from "../../tools/permission-chain";
import type { RejectionCounter } from "../../tools/rejection-counter";
import type { QuotaConfig } from "../../context/quota";
import type { PruneConfig } from "../../context/prune";
import type { PrePruneConfig } from "../../context/pre-prune";
import type { InvocationPriority } from "../../types/common";
import type { ToolDiscoveryService } from "../../tools/tool-discovery";

// ─── SteerControl — 外部控制 Loop 的可变引用 ───

export interface SteerControl {
  /** 待注入的 steer 消息，工具执行完成后检查并注入下一轮对话 */
  pendingSteer: string | null;
  /** 代际计数器，/stop 或 /new 时递增，旧流结果检查 generation 是否过期 */
  generation: number;
}

export function createSteerControl(): SteerControl {
  return { pendingSteer: null, generation: 0 };
}

// ─── LoopState ───

export interface LoopState {
  /** 消息历史（跨迭代累积） */
  readonly messages: readonly Message[];

  /** 当前轮次（从 1 开始） */
  readonly turnCount: number;

  /** 上一轮的 Continue 原因（首轮为 undefined） */
  readonly transition: Continue | undefined;

  /** Token 预算剩余量 */
  readonly budgetRemaining: number;

  /** Token 预算总量 */
  readonly budgetTotal: number;

  /** 累计 Token 使用量 */
  readonly totalInputTokens: number;

  /** 累计输出 Token 使用量 */
  readonly totalOutputTokens: number;

  /** 最大输出 Token 覆盖（用于 max_output_tokens 恢复） */
  readonly maxOutputTokensOverride: number | undefined;

  /** max_output_tokens 恢复尝试次数 */
  readonly maxOutputTokensRecoveryCount: number;

  /** 是否已尝试过 reactive compact */
  readonly hasAttemptedReactiveCompact: boolean;

  /** 当前使用的模型 */
  readonly currentModel: string;

  /** AbortSignal */
  readonly abortSignal: AbortSignal | undefined;

  /** S1: 当前断路器状态（跨迭代传播） */
  readonly rejectionCounter: RejectionCounter | undefined;

  /** Step 9: 循环启动时捕获的代际值，用于检测过期 */
  readonly initialGeneration: number;

  /** Step 9: SteerControl 引用 */
  readonly steerControl: SteerControl | undefined;
}

// ─── LoopParams（agentQueryLoop 输入参数） ───

export interface LoopParams {
  /** 初始消息列表 */
  readonly messages: readonly Message[];

  /** System Prompt */
  readonly systemPrompt: string;

  /** 追加 System Prompt */
  readonly appendSystemPrompt?: string;

  /** 可用工具列表 */
  readonly tools: ReadonlyArray<import("../../interfaces/tool").Tool>;

  /** LLM Provider */
  readonly provider: import("../../interfaces/llm-provider").LLMProvider;

  /** 权限检查回调 */
  readonly canUseTool: import("../../interfaces/tool").CanUseToolFn;

  /** 工具调用上下文 */
  readonly toolUseContext: import("../../interfaces/tool").ToolUseContext;

  /** 最大轮次 */
  readonly maxTurns: number;

  /** Token 预算 */
  readonly tokenBudget: number;

  /** 备用模型 */
  readonly fallbackModel?: string;

  /** AbortSignal */
  readonly abortSignal?: AbortSignal;

  /** 单个工具执行超时（毫秒），默认 120000 */
  readonly toolTimeoutMs?: number;

  /** S1: 权限检查链配置（提供时使用 evaluateToolAccess 替代 canUseTool） */
  readonly permissionChainConfig?: PermissionChainConfig;

  /** S1: 初始断路器状态（跨迭代传播） */
  readonly rejectionCounter?: RejectionCounter;

  /** S2: 工具结果配额配置 */
  readonly quotaConfig?: QuotaConfig;

  /** S2: 历史裁剪配置 */
  readonly pruneConfig?: PruneConfig;

  /** S5: 工具输出预剪枝配置 */
  readonly prePruneConfig?: PrePruneConfig;

  /** D.3: 调用优先级（传播到 LLM 适配器） */
  readonly priority?: InvocationPriority;

  /** E.2/S3: 工具发现服务（提供时启用懒加载） */
  readonly discoveryService?: ToolDiscoveryService;

  /** Step 9: SteerControl 引用（提供时启用 steer 注入和代际检查） */
  readonly steerControl?: SteerControl;

  /** 调用级 maxTokens 覆盖（提供时传递给 provider.stream()） */
  readonly maxTokens?: number;
}

// ─── 工厂函数 ───

export function createLoopState(params: LoopParams): LoopState {
  return {
    messages: params.messages,
    turnCount: 1,
    transition: undefined,
    budgetRemaining: params.tokenBudget,
    budgetTotal: params.tokenBudget,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    maxOutputTokensOverride: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    currentModel: params.provider.model,
    abortSignal: params.abortSignal,
    rejectionCounter: params.rejectionCounter,
    initialGeneration: params.steerControl?.generation ?? 0,
    steerControl: params.steerControl,
  };
}

export function updateLoopState(
  prev: LoopState,
  updates: Partial<LoopState>,
): LoopState {
  return { ...prev, ...updates };
}
