/**
 * 事件系统核心 — 类型安全的事件发射器。
 *
 * RULES_2-20: 观察者 + 错误隔离。
 * - 两级分发：type + type:action 匹配
 * - 错误隔离：单个处理器异常不影响其他处理器
 * - 优先级排序：数值越小优先级越高
 */

// ─── 事件类型 ───

/** 事件处理器类型 */
export type EventHandler<T = unknown> = (event: T) => Promise<void> | void;

/** 事件处理器注册条目 */
export interface HandlerEntry<T = unknown> {
  readonly handler: EventHandler<T>;
  readonly priority: number;
  readonly source: string;
  readonly once: boolean;
}

// ─── 事件接口 ───

/** 基础事件接口 */
export interface BaseEvent {
  readonly type: string;
  readonly timestamp: number;
}

/** 带动作的事件接口 */
export interface ActionEvent extends BaseEvent {
  readonly action: string;
}

// ─── 系统事件定义 ───

/** 事件来源枚举 */
export type EventSource =
  | "system"
  | "plugin"
  | "hook"
  | "tool"
  | "agent"
  | "evolution"
  | "mcp";

// ─── 事件发射器接口 ───

export interface EventEmitter<TEvent extends BaseEvent = BaseEvent> {
  /** 注册事件处理器 */
  on(
    eventKey: string,
    handler: EventHandler<TEvent>,
    options?: EventHandlerOptions,
  ): () => void;

  /** 注册一次性事件处理器 */
  once(
    eventKey: string,
    handler: EventHandler<TEvent>,
    options?: EventHandlerOptions,
  ): () => void;

  /** 触发事件（两级分发 + 错误隔离） */
  emit(event: TEvent): Promise<EventEmitResult>;

  /** 移除事件处理器 */
  off(eventKey: string, handler: EventHandler<TEvent>): boolean;

  /** 移除指定来源的所有处理器 */
  offBySource(source: string): number;

  /** 检查是否有指定事件的监听器 */
  hasListeners(eventKey: string): boolean;

  /** 获取指定事件的监听器数量 */
  listenerCount(eventKey: string): number;

  /** 获取所有事件键 */
  eventKeys(): readonly string[];

  /** 移除所有处理器 */
  clear(): void;
}

// ─── 事件发射结果 ───

export interface EventEmitResult {
  totalHandlers: number;
  invokedCount: number;
  errorCount: number;
  errors: EventEmitError[];
}

export interface EventEmitError {
  readonly eventKey: string;
  readonly source: string;
  readonly error: unknown;
}

// ─── 事件处理器选项 ───

export interface EventHandlerOptions {
  readonly priority?: number;
  readonly source?: string;
}

// ─── 默认值 ───

const DEFAULT_PRIORITY = 100;
const DEFAULT_SOURCE = "system";

// ─── 创建事件发射器 ───

export function createEventEmitter<
  TEvent extends BaseEvent = BaseEvent,
>(): EventEmitter<TEvent> {
  // 事件键 → 处理器列表（按优先级排序）
  const handlers = new Map<string, HandlerEntry<TEvent>[]>();

  /** 获取或创建处理器列表 */
  function getOrCreateList(eventKey: string): HandlerEntry<TEvent>[] {
    let list = handlers.get(eventKey);
    if (list === undefined) {
      list = [];
      handlers.set(eventKey, list);
    }
    return list;
  }

  /** 按优先级插入处理器（数值越小越靠前） */
  function insertSorted(
    list: HandlerEntry<TEvent>[],
    entry: HandlerEntry<TEvent>,
  ): void {
    // 二分查找插入位置
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (list[mid]!.priority <= entry.priority) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    list.splice(low, 0, entry);
  }

  /** 注册处理器 */
  function on(
    eventKey: string,
    handler: EventHandler<TEvent>,
    options?: EventHandlerOptions,
  ): () => void {
    const entry: HandlerEntry<TEvent> = {
      handler,
      priority: options?.priority ?? DEFAULT_PRIORITY,
      source: options?.source ?? DEFAULT_SOURCE,
      once: false,
    };

    const list = getOrCreateList(eventKey);
    insertSorted(list, entry);

    // 返回取消注册函数
    return () => {
      const idx = list.indexOf(entry);
      if (idx >= 0) {
        list.splice(idx, 1);
      }
    };
  }

  /** 注册一次性处理器 */
  function once(
    eventKey: string,
    handler: EventHandler<TEvent>,
    options?: EventHandlerOptions,
  ): () => void {
    const entry: HandlerEntry<TEvent> = {
      handler,
      priority: options?.priority ?? DEFAULT_PRIORITY,
      source: options?.source ?? DEFAULT_SOURCE,
      once: true,
    };

    const list = getOrCreateList(eventKey);
    insertSorted(list, entry);

    // 返回取消注册函数
    return () => {
      const idx = list.indexOf(entry);
      if (idx >= 0) {
        list.splice(idx, 1);
      }
    };
  }

  /** 触发事件（两级分发 + 错误隔离） */
  async function emit(event: TEvent): Promise<EventEmitResult> {
    const result: EventEmitResult = {
      totalHandlers: 0,
      invokedCount: 0,
      errorCount: 0,
      errors: [],
    };

    // 两级分发：
    // 1. 匹配通用事件类型（如 "command"）
    // 2. 匹配具体事件+动作（如 "command:new"）
    const typeKey = event.type;
    const specificKey = "action" in event
      ? `${event.type}:${(event as ActionEvent).action}`
      : null;

    // 收集处理器（去重）
    const seenHandlers = new Set<EventHandler<TEvent>>();
    const entries: Array<{ entry: HandlerEntry<TEvent>; key: string }> = [];

    // 先收集通用类型处理器
    const typeHandlers = handlers.get(typeKey);
    if (typeHandlers !== undefined) {
      for (const entry of typeHandlers) {
        if (!seenHandlers.has(entry.handler)) {
          seenHandlers.add(entry.handler);
          entries.push({ entry, key: typeKey });
        }
      }
    }

    // 再收集具体动作处理器（高优先级，后追加保证同优先级时后注册的先执行）
    if (specificKey !== null) {
      const specificHandlers = handlers.get(specificKey);
      if (specificHandlers !== undefined) {
        for (const entry of specificHandlers) {
          if (!seenHandlers.has(entry.handler)) {
            seenHandlers.add(entry.handler);
            entries.push({ entry, key: specificKey });
          }
        }
      }
    }

    result.totalHandlers = entries.length;

    // 按序调用处理器（已按优先级排序）
    for (const { entry, key } of entries) {
      // 一次性处理器：调用后移除
      if (entry.once) {
        const list = handlers.get(key);
        if (list !== undefined) {
          const idx = list.indexOf(entry);
          if (idx >= 0) {
            list.splice(idx, 1);
          }
        }
      }

      try {
        result.invokedCount++;
        await entry.handler(event);
      } catch (err) {
        result.errorCount++;
        result.errors.push({
          eventKey: key,
          source: entry.source,
          error: err,
        });
        // 错误隔离：不抛出，继续执行后续处理器
      }
    }

    return result;
  }

  /** 移除处理器 */
  function off(eventKey: string, handler: EventHandler<TEvent>): boolean {
    const list = handlers.get(eventKey);
    if (list === undefined) return false;

    const idx = list.findIndex((e) => e.handler === handler);
    if (idx < 0) return false;

    list.splice(idx, 1);
    return true;
  }

  /** 移除指定来源的所有处理器 */
  function offBySource(source: string): number {
    let removed = 0;
    for (const [key, list] of handlers) {
      const before = list.length;
      const filtered = list.filter((e) => e.source !== source);
      handlers.set(key, filtered);
      removed += before - filtered.length;
    }
    return removed;
  }

  /** 检查是否有监听器 */
  function hasListeners(eventKey: string): boolean {
    const list = handlers.get(eventKey);
    return list !== undefined && list.length > 0;
  }

  /** 获取监听器数量 */
  function listenerCount(eventKey: string): number {
    const list = handlers.get(eventKey);
    return list?.length ?? 0;
  }

  /** 获取所有事件键 */
  function eventKeys(): readonly string[] {
    return [...handlers.keys()];
  }

  /** 清除所有处理器 */
  function clear(): void {
    handlers.clear();
  }

  return {
    on,
    once,
    emit,
    off,
    offBySource,
    hasListeners,
    listenerCount,
    eventKeys,
    clear,
  };
}
