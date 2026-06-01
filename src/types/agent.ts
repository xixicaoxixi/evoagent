/**
 * Agent 状态机类型 — Discriminated Union。
 *
 * RULES_1-3: 多态用 Discriminated Union（type 字段区分）。
 * Agent 生命周期: CREATED → INITIALIZING → RUNNING → COMPLETED | FAILED → DESTROYED
 */

// ─── AgentStatus 枚举 ───

export const AgentStatus = {
  CREATED: "CREATED",
  INITIALIZING: "INITIALIZING",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  DESTROYED: "DESTROYED",
} as const;

export type AgentStatus =
  (typeof AgentStatus)[keyof typeof AgentStatus];

// ─── Agent 状态机（Discriminated Union） ───

export interface AgentStateCreated {
  readonly type: "CREATED";
  readonly agentId: string;
  readonly createdAt: number;
}

export interface AgentStateInitializing {
  readonly type: "INITIALIZING";
  readonly agentId: string;
  readonly createdAt: number;
  readonly initializedAt: number;
}

export interface AgentStateRunning {
  readonly type: "RUNNING";
  readonly agentId: string;
  readonly createdAt: number;
  readonly startedAt: number;
  readonly currentTaskId: string;
}

export interface AgentStateCompleted {
  readonly type: "COMPLETED";
  readonly agentId: string;
  readonly createdAt: number;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly result: unknown;
}

export interface AgentStateFailed {
  readonly type: "FAILED";
  readonly agentId: string;
  readonly createdAt: number;
  readonly startedAt: number;
  readonly failedAt: number;
  readonly error: string;
}

export interface AgentStateDestroyed {
  readonly type: "DESTROYED";
  readonly agentId: string;
  readonly createdAt: number;
  readonly destroyedAt: number;
}

/** Agent 状态联合类型 — 所有状态通过 `type` 字段区分 */
export type AgentState =
  | AgentStateCreated
  | AgentStateInitializing
  | AgentStateRunning
  | AgentStateCompleted
  | AgentStateFailed
  | AgentStateDestroyed;

// ─── 合法状态转换表 ───

const VALID_TRANSITIONS: Readonly<Record<AgentStatus, readonly AgentStatus[]>> = {
  CREATED: ["INITIALIZING", "DESTROYED"],
  INITIALIZING: ["RUNNING", "FAILED", "DESTROYED"],
  RUNNING: ["COMPLETED", "FAILED", "DESTROYED"],
  COMPLETED: ["DESTROYED"],
  FAILED: ["DESTROYED"],
  DESTROYED: [],
};

/** 检查状态转换是否合法 */
export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── TaskStatus 枚举 ───

export const TaskStatus = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  PARTIAL: "PARTIAL",
} as const;

export type TaskStatus =
  (typeof TaskStatus)[keyof typeof TaskStatus];

// ─── ProcessingResult 枚举 ───

export const ProcessingResult = {
  ACCEPT: "ACCEPT",
  ACCEPT_PARTIAL: "ACCEPT_PARTIAL",
  REJECT: "REJECT",
  ARCHIVE_AS_FLAWED: "ARCHIVE_AS_FLAWED",
  CHALLENGE: "CHALLENGE",
} as const;

export type ProcessingResult =
  (typeof ProcessingResult)[keyof typeof ProcessingResult];
