/**
 * 钩子引擎 — 五阶段管线执行器。
 *
 * RULES_2-20: 观察者 + 错误隔离。
 *
 * 五阶段管线：
 * 1. 匹配 — 查找事件对应的钩子
 * 2. 策略 — 优先级排序 + 冲突解决
 * 3. 过滤 — 启用/禁用判断
 * 4. 执行 — 按序调用 + 错误隔离
 * 5. 报告 — 收集结果
 */

import type { HookRegistry, HookDefinition } from "./registry";
import type { EventEmitter, BaseEvent, EventEmitResult } from "../event-emitter";

// ─── 钩子执行结果 ───

export interface HookExecutionResult {
  readonly eventKey: string;
  totalHooks: number;
  executedCount: number;
  skippedCount: number;
  errorCount: number;
  results: HookResultEntry[];
}

export interface HookResultEntry {
  readonly hookId: string;
  readonly source: string;
  readonly success: boolean;
  readonly error?: unknown;
  readonly durationMs: number;
}

// ─── 钩子引擎接口 ───

export interface HookEngine {
  /** 触发钩子（两级分发 + 错误隔离） */
  trigger(
    event: string,
    action: string | undefined,
    args: readonly unknown[],
  ): Promise<HookExecutionResult>;

  /** 触发系统事件（通过 EventEmitter） */
  emitEvent(event: BaseEvent): Promise<EventEmitResult>;

  /** 全局启用/禁用 */
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;

  /** 获取底层注册表 */
  getRegistry(): HookRegistry;

  /** 获取事件发射器 */
  getEventEmitter(): EventEmitter;
}

// ─── 钩子引擎配置 ───

export interface HookEngineConfig {
  readonly enabled?: boolean;
  readonly maxExecutionTimeMs?: number;
}

// ─── 默认值 ───

const DEFAULT_MAX_EXECUTION_TIME_MS = 30_000;

// ─── 创建钩子引擎 ───

export function createHookEngine(
  registry: HookRegistry,
  eventEmitter: EventEmitter,
  config?: HookEngineConfig,
): HookEngine {
  let enabled = config?.enabled ?? true;
  const maxExecutionTimeMs =
    config?.maxExecutionTimeMs ?? DEFAULT_MAX_EXECUTION_TIME_MS;

  /** 阶段 1+2+3: 匹配 + 策略 + 过滤 */
  function resolveHooks(
    event: string,
    action: string | undefined,
  ): readonly HookDefinition[] {
    // 收集 type 级别钩子
    const typeHooks = registry.getByEvent(event);

    // 收集 type:action 级别钩子
    const actionHooks =
      action !== undefined
        ? registry.getByEventAction(event, action)
        : [];

    // 去重（同 ID 不重复执行）
    const seen = new Set<string>();
    const result: HookDefinition[] = [];

    for (const hook of typeHooks) {
      if (!seen.has(hook.id)) {
        seen.add(hook.id);
        result.push(hook);
      }
    }

    for (const hook of actionHooks) {
      if (!seen.has(hook.id)) {
        seen.add(hook.id);
        result.push(hook);
      }
    }

    return result;
  }

  /** 阶段 4+5: 执行 + 报告 */
  async function trigger(
    event: string,
    action: string | undefined,
    args: readonly unknown[],
  ): Promise<HookExecutionResult> {
    const result: HookExecutionResult = {
      eventKey: action !== undefined ? `${event}:${action}` : event,
      totalHooks: 0,
      executedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      results: [],
    };

    if (!enabled) return result;

    const hooks = resolveHooks(event, action);
    result.totalHooks = hooks.length;

    const startTime = Date.now();

    for (const hook of hooks) {
      // 超时检查
      if (Date.now() - startTime > maxExecutionTimeMs) {
        result.skippedCount += hooks.length - result.executedCount - result.errorCount;
        break;
      }

      const hookStart = Date.now();
      try {
        await hook.handler(...args);
        result.executedCount++;
        result.results.push({
          hookId: hook.id,
          source: hook.source,
          success: true,
          durationMs: Date.now() - hookStart,
        });
      } catch (err) {
        result.errorCount++;
        result.results.push({
          hookId: hook.id,
          source: hook.source,
          success: false,
          error: err,
          durationMs: Date.now() - hookStart,
        });
        // 错误隔离：不抛出，继续执行后续钩子
      }
    }

    return result;
  }

  /** 通过 EventEmitter 触发系统事件 */
  async function emitEvent(event: BaseEvent): Promise<EventEmitResult> {
    if (!enabled) {
      return {
        totalHandlers: 0,
        invokedCount: 0,
        errorCount: 0,
        errors: [],
      };
    }
    return eventEmitter.emit(event);
  }

  function setEnabled(value: boolean): void {
    enabled = value;
  }

  function isEnabled(): boolean {
    return enabled;
  }

  function getRegistry(): HookRegistry {
    return registry;
  }

  function getEventEmitter(): EventEmitter {
    return eventEmitter;
  }

  return {
    trigger,
    emitEvent,
    setEnabled,
    isEnabled,
    getRegistry,
    getEventEmitter,
  };
}
