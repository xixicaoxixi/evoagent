/**
 * 多层级配置合并策略引擎。
 *
 * 不同组件类型采用不同的合并策略：
 * - Rules: 叠加合并（stack）— 更具体规则优先，同名规则取更具体版本
 * - Skills: 按名称覆盖（overlay）— managed > user > project > workspace
 * - Hooks: 合并执行（merge）— 同一事件的多个 hooks 全部执行
 *
 * RULES_2-21: 配置管线 — 加载 → 验证 → 物化 → 快照 → 热更新。
 */

import type {
  MergeStrategy,
  ConfigLayer,
} from "../schemas/config";
import { LAYER_PRIORITY } from "../schemas/config";

// ─── 可合并配置项 ───

/** 带层级信息的配置项 */
export interface LayeredConfigItem<T> {
  /** 配置内容 */
  readonly value: T;
  /** 配置来源层级 */
  readonly layer: ConfigLayer;
  /** 配置唯一标识（用于 overlay 策略的去重） */
  readonly key?: string;
}

/** 合并结果 */
export interface MergeResult<T> {
  /** 合并后的值 */
  readonly value: T;
  /** 参与合并的层级 */
  readonly layers: readonly ConfigLayer[];
  /** 合并策略 */
  readonly strategy: MergeStrategy;
}

// ─── 配置合并器接口 ───

export interface ConfigMerger {
  /**
   * 使用指定策略合并配置项。
   */
  merge<T>(
    items: readonly LayeredConfigItem<T>[],
    strategy: MergeStrategy,
  ): MergeResult<T>;

  /**
   * 使用 overlay 策略合并（按 key 去重，高优先级覆盖低优先级）。
   */
  overlay<T>(
    items: readonly LayeredConfigItem<T>[],
  ): MergeResult<T>;

  /**
   * 使用 stack 策略合并（所有项叠加，按优先级排序）。
   */
  stack<T>(
    items: readonly LayeredConfigItem<T>[],
  ): MergeResult<T>;

  /**
   * 使用 merge 策略合并（同 key 的值深度合并）。
   */
  mergeByKey<T>(
    items: readonly LayeredConfigItem<T>[],
    mergeFn: (a: T, b: T) => T,
  ): MergeResult<T>;

  /**
   * 获取两个层级的优先级比较结果。
   *
   * @returns 负数表示 a 优先级更高，正数表示 b 优先级更高，0 表示相同
   */
  compareLayerPriority(a: ConfigLayer, b: ConfigLayer): number;
}

// ─── 创建配置合并器 ───

export function createConfigMerger(): ConfigMerger {
  function compareLayerPriority(a: ConfigLayer, b: ConfigLayer): number {
    return LAYER_PRIORITY[a] - LAYER_PRIORITY[b];
  }

  function merge<T>(
    items: readonly LayeredConfigItem<T>[],
    strategy: MergeStrategy,
  ): MergeResult<T> {
    switch (strategy) {
      case "overlay":
        return overlay(items);
      case "stack":
        return stack(items);
      case "merge":
        // merge 策略需要 mergeFn，这里使用默认的数组拼接
        return mergeByKey(items, (a, b) => {
          if (Array.isArray(a) && Array.isArray(b)) {
            return [...a, ...b] as unknown as T;
          }
          return b; // 默认取后者
        });
    }
  }

  /**
   * Overlay 策略：按 key 去重，高优先级层级覆盖低优先级层级。
   *
   * 适用于 Skills — managed > user > project > workspace。
   */
  function overlay<T>(
    items: readonly LayeredConfigItem<T>[],
  ): MergeResult<T> {
    if (items.length === 0) {
      return { value: [] as unknown as T, layers: [], strategy: "overlay" };
    }

    // 按 key 分组，保留优先级最高的
    const grouped = new Map<string, LayeredConfigItem<T>>();
    const keylessItems: LayeredConfigItem<T>[] = [];

    // 按优先级排序（高优先级在前）
    const sorted = [...items].sort(
      (a, b) => compareLayerPriority(a.layer, b.layer),
    );

    for (const item of sorted) {
      if (item.key !== undefined) {
        // 有 key 的项：高优先级覆盖低优先级
        const existing = grouped.get(item.key);
        if (existing === undefined) {
          grouped.set(item.key, item);
        }
        // 已存在则跳过（高优先级已先处理）
      } else {
        // 无 key 的项：全部保留
        keylessItems.push(item);
      }
    }

    // 收集结果
    const resultValues: T[] = [];
    const layers = new Set<ConfigLayer>();

    for (const item of grouped.values()) {
      resultValues.push(item.value);
      layers.add(item.layer);
    }
    for (const item of keylessItems) {
      resultValues.push(item.value);
      layers.add(item.layer);
    }

    return {
      value: resultValues as unknown as T,
      layers: [...layers].sort(compareLayerPriority),
      strategy: "overlay",
    };
  }

  /**
   * Stack 策略：所有项叠加，按优先级排序。
   *
   * 适用于 Rules — 所有层级的规则都加载，更具体的排在前面。
   */
  function stack<T>(
    items: readonly LayeredConfigItem<T>[],
  ): MergeResult<T> {
    if (items.length === 0) {
      return { value: [] as unknown as T, layers: [], strategy: "stack" };
    }

    // 按优先级排序（高优先级在前）
    const sorted = [...items].sort(
      (a, b) => compareLayerPriority(a.layer, b.layer),
    );

    const resultValues = sorted.map((item) => item.value);
    const layers = [...new Set(sorted.map((item) => item.layer))].sort(
      compareLayerPriority,
    );

    return {
      value: resultValues as unknown as T,
      layers,
      strategy: "stack",
    };
  }

  /**
   * Merge 策略：同 key 的值深度合并。
   *
   * 适用于 Hooks — 同一事件的多个 hooks 全部执行。
   */
  function mergeByKey<T>(
    items: readonly LayeredConfigItem<T>[],
    mergeFn: (a: T, b: T) => T,
  ): MergeResult<T> {
    if (items.length === 0) {
      return { value: [] as unknown as T, layers: [], strategy: "merge" };
    }

    // 按 key 分组
    const grouped = new Map<string, LayeredConfigItem<T>[]>();
    const keylessItems: LayeredConfigItem<T>[] = [];

    for (const item of items) {
      if (item.key !== undefined) {
        const existing = grouped.get(item.key);
        if (existing !== undefined) {
          existing.push(item);
        } else {
          grouped.set(item.key, [item]);
        }
      } else {
        keylessItems.push(item);
      }
    }

    // 合并同 key 的值
    const resultValues: T[] = [];
    const layers = new Set<ConfigLayer>();

    for (const [, group] of grouped) {
      // 按优先级排序
      const sorted = [...group].sort(
        (a, b) => compareLayerPriority(a.layer, b.layer),
      );

      let merged = sorted[0]!.value;
      for (let i = 1; i < sorted.length; i++) {
        merged = mergeFn(merged, sorted[i]!.value);
      }

      resultValues.push(merged);
      for (const item of sorted) {
        layers.add(item.layer);
      }
    }

    for (const item of keylessItems) {
      resultValues.push(item.value);
      layers.add(item.layer);
    }

    return {
      value: resultValues as unknown as T,
      layers: [...layers].sort(compareLayerPriority),
      strategy: "merge",
    };
  }

  return { merge, overlay, stack, mergeByKey, compareLayerPriority };
}
