/**
 * Store<T> 泛型接口。
 *
 * 基于极简设计模式的轻量 Store 实现。
 * RULES_2-4: 接口 + 注册表模式。
 */

// ─── Listener 类型 ───

export type Listener = () => void;

export type OnChange<T> = (args: {
  newState: T;
  oldState: T;
}) => void;

// ─── Store<T> 接口 ───

export interface Store<T> {
  /** 获取当前状态 */
  getState(): T;

  /** 更新状态（通过 updater 函数） */
  setState(updater: (prev: T) => T): void;

  /** 订阅状态变更，返回取消订阅函数 */
  subscribe(listener: Listener): () => void;
}

// ─── Store 创建工厂类型 ───

export type StoreFactory = {
  createStore<T>(
    initialState: T,
    onChange?: OnChange<T>,
  ): Store<T>;
};
