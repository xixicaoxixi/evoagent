/**
 * Branded Types — 不同语义 ID 的类型安全标识符。
 *
 * RULES_1-4: 不同语义 ID 用 Branded Types，防止 ID 混用。
 * 使用 `string & { readonly __brand: "XxxId" }` 模式实现名义类型。
 */

/** 任务唯一标识符 */
export type TaskId = string & { readonly __brand: "TaskId" };

/** 进化规则唯一标识符 */
export type RuleId = string & { readonly __brand: "RuleId" };

/** Agent 实例唯一标识符 */
export type AgentId = string & { readonly __brand: "AgentId" };

/** 会话唯一标识符 */
export type SessionId = string & { readonly __brand: "SessionId" };

/** 消息唯一标识符 */
export type MessageId = string & { readonly __brand: "MessageId" };

/** P2P 网络节点唯一标识符 */
export type PeerId = string & { readonly __brand: "PeerId" };

/** 错误记录唯一标识符 */
export type ErrorId = string & { readonly __brand: "ErrorId" };

/** 快照唯一标识符 */
export type SnapshotId = string & { readonly __brand: "SnapshotId" };

/** 执行计划唯一标识符 */
export type PlanId = string & { readonly __brand: "PlanId" };

/** 知识条目唯一标识符 */
export type KnowledgeId = string & { readonly __brand: "KnowledgeId" };

// ─── Brand 工厂函数 ───

/** 创建 Branded Type 的工具函数（运行时无开销，仅类型断言） */
export function brand<T extends string>(
  value: string,
  _brand: T,
): string & { readonly __brand: T } {
  return value as string & { readonly __brand: T };
}

// ─── 便捷构造器 ───

export const TaskId = {
  create: (value: string): TaskId => brand(value, "TaskId"),
  fromUUID: (): TaskId => brand(crypto.randomUUID(), "TaskId"),
} as const;

export const RuleId = {
  create: (value: string): RuleId => brand(value, "RuleId"),
  fromUUID: (): RuleId => brand(crypto.randomUUID(), "RuleId"),
} as const;

export const AgentId = {
  create: (value: string): AgentId => brand(value, "AgentId"),
  fromUUID: (): AgentId => brand(crypto.randomUUID(), "AgentId"),
} as const;

export const SessionId = {
  create: (value: string): SessionId => brand(value, "SessionId"),
  fromUUID: (): SessionId => brand(crypto.randomUUID(), "SessionId"),
} as const;

export const MessageId = {
  create: (value: string): MessageId => brand(value, "MessageId"),
  fromUUID: (): MessageId => brand(crypto.randomUUID(), "MessageId"),
} as const;

export const PeerId = {
  create: (value: string): PeerId => brand(value, "PeerId"),
  fromUUID: (): PeerId => brand(crypto.randomUUID(), "PeerId"),
} as const;

export const ErrorId = {
  create: (value: string): ErrorId => brand(value, "ErrorId"),
  fromUUID: (): ErrorId => brand(crypto.randomUUID(), "ErrorId"),
} as const;

export const SnapshotId = {
  create: (value: string): SnapshotId => brand(value, "SnapshotId"),
  fromUUID: (): SnapshotId => brand(crypto.randomUUID(), "SnapshotId"),
} as const;

export const PlanId = {
  create: (value: string): PlanId => brand(value, "PlanId"),
  fromUUID: (): PlanId => brand(crypto.randomUUID(), "PlanId"),
} as const;

export const KnowledgeId = {
  create: (value: string): KnowledgeId => brand(value, "KnowledgeId"),
  fromUUID: (): KnowledgeId => brand(crypto.randomUUID(), "KnowledgeId"),
} as const;
