/**
 * createStore<T> — 轻量级泛型响应式状态容器。
 *
 * 基于极简设计模式的轻量 Store 实现（34 行极简设计）。
 * setState 通过 Object.is 做浅比较避免无意义更新。
 * RULES_2-3: 小文件 <500 行。
 */

import type { Listener, OnChange, Store } from "../interfaces/store";

/**
 * 创建一个响应式 Store。
 *
 * @typeParam T - 状态类型
 * @param initialState - 初始状态
 * @param onChange - 状态变更回调（在通知订阅者之前触发）
 * @returns Store 实例
 */
export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState;
  const listeners = new Set<Listener>();

  return {
    getState: (): T => state,

    setState: (updater: (prev: T) => T): void => {
      const prev = state;
      const next = updater(prev);
      if (Object.is(next, prev)) return;
      state = next;
      onChange?.({ newState: next, oldState: prev });
      for (const listener of listeners) listener();
    },

    subscribe: (listener: Listener): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
