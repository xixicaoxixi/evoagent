/**
 * 系统预定义事件类型。
 *
 * Discriminated Union 事件体系，覆盖 Agent 生命周期、工具调用、
 * 进化引擎、插件系统等核心事件。
 */

import type { BaseEvent, ActionEvent } from "./event-emitter";

// ─── 事件类型枚举 ───

export type SystemEventType =
  | "agent"
  | "tool"
  | "evolution"
  | "plugin"
  | "session"
  | "config"
  | "hook";

// ─── Agent 事件 ───

export interface AgentEvent extends ActionEvent {
  readonly type: "agent";
  readonly agentId: string;
  readonly sessionId?: string;
}

export type AgentAction =
  | "created"
  | "started"
  | "completed"
  | "failed"
  | "aborted"
  | "idle";

// ─── Tool 事件 ───

export interface ToolEvent extends ActionEvent {
  readonly type: "tool";
  readonly toolName: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly durationMs?: number;
  readonly success?: boolean;
}

export type ToolAction =
  | "before_call"
  | "after_call"
  | "error"
  | "registered"
  | "unregistered";

// ─── Evolution 事件 ───

export interface EvolutionEvent extends ActionEvent {
  readonly type: "evolution";
  readonly ruleId?: string;
  readonly fromStatus?: string;
  readonly toStatus?: string;
}

export type EvolutionAction =
  | "rule_created"
  | "rule_promoted"
  | "rule_deprecated"
  | "rule_rolled_back"
  | "trigger_checked"
  | "snapshot_created"
  | "snapshot_restored";

// ─── Plugin 事件 ───

export interface PluginEvent extends ActionEvent {
  readonly type: "plugin";
  readonly pluginName: string;
  readonly source?: string;
}

export type PluginAction =
  | "registered"
  | "unregistered"
  | "activated"
  | "deactivated"
  | "error";

// ─── Session 事件 ───

export interface SessionEvent extends ActionEvent {
  readonly type: "session";
  readonly sessionId: string;
}

export type SessionAction =
  | "created"
  | "cleared"
  | "compacted"
  | "message_added";

// ─── Config 事件 ───

export interface ConfigEvent extends ActionEvent {
  readonly type: "config";
  readonly key?: string;
}

export type ConfigAction =
  | "loaded"
  | "updated"
  | "hot_reloaded";

// ─── Hook 事件 ───

export interface HookEvent extends ActionEvent {
  readonly type: "hook";
  readonly hookName: string;
}

export type HookAction =
  | "registered"
  | "triggered"
  | "error";

// ─── 系统事件联合类型 ───

export type SystemEvent =
  | AgentEvent
  | ToolEvent
  | EvolutionEvent
  | PluginEvent
  | SessionEvent
  | ConfigEvent
  | HookEvent;

// ─── 事件工厂函数 ───

export function createAgentEvent(
  action: AgentAction,
  agentId: string,
  extra?: { sessionId?: string },
): AgentEvent {
  return {
    type: "agent",
    action,
    agentId,
    timestamp: Date.now(),
    ...(extra?.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
  };
}

export function createToolEvent(
  action: ToolAction,
  toolName: string,
  extra?: {
    sessionId?: string;
    agentId?: string;
    durationMs?: number;
    success?: boolean;
  },
): ToolEvent {
  return {
    type: "tool",
    action,
    toolName,
    timestamp: Date.now(),
    ...(extra?.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
    ...(extra?.agentId !== undefined ? { agentId: extra.agentId } : {}),
    ...(extra?.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    ...(extra?.success !== undefined ? { success: extra.success } : {}),
  };
}

export function createEvolutionEvent(
  action: EvolutionAction,
  extra?: {
    ruleId?: string;
    fromStatus?: string;
    toStatus?: string;
  },
): EvolutionEvent {
  return {
    type: "evolution",
    action,
    timestamp: Date.now(),
    ...(extra?.ruleId !== undefined ? { ruleId: extra.ruleId } : {}),
    ...(extra?.fromStatus !== undefined
      ? { fromStatus: extra.fromStatus }
      : {}),
    ...(extra?.toStatus !== undefined ? { toStatus: extra.toStatus } : {}),
  };
}

export function createPluginEvent(
  action: PluginAction,
  pluginName: string,
  extra?: { source?: string },
): PluginEvent {
  return {
    type: "plugin",
    action,
    pluginName,
    timestamp: Date.now(),
    ...(extra?.source !== undefined ? { source: extra.source } : {}),
  };
}

export function createSessionEvent(
  action: SessionAction,
  sessionId: string,
): SessionEvent {
  return {
    type: "session",
    action,
    sessionId,
    timestamp: Date.now(),
  };
}

export function createConfigEvent(
  action: ConfigAction,
  extra?: { key?: string },
): ConfigEvent {
  return {
    type: "config",
    action,
    timestamp: Date.now(),
    ...(extra?.key !== undefined ? { key: extra.key } : {}),
  };
}

export function createHookEvent(
  action: HookAction,
  hookName: string,
): HookEvent {
  return {
    type: "hook",
    action,
    hookName,
    timestamp: Date.now(),
  };
}
