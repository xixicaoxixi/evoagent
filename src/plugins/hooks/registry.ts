/**
 * 钩子注册表 — 钩子定义的注册、查询和管理。
 *
 * RULES_2-4: 接口 + 注册表模式。
 * 支持五级来源优先级和双向声明覆盖控制。
 */

// ─── 钩子来源类型 ───

export type HookSource =
  | "builtin"
  | "plugin"
  | "managed"
  | "workspace"
  | "user";

// ─── 钩子定义 ───

export interface HookDefinition {
  /** 钩子唯一标识 */
  readonly id: string;
  /** 钩子事件类型 */
  readonly event: string;
  /** 钩子动作（可选，用于 type:action 两级分发） */
  readonly action?: string;
  /** 处理器函数 */
  readonly handler: (...args: readonly unknown[]) => Promise<unknown>;
  /** 来源 */
  readonly source: HookSource;
  /** 优先级（数值越小越先执行） */
  readonly priority: number;
  /** 是否启用 */
  readonly enabled: boolean;
  /** 描述 */
  readonly description?: string;
}

// ─── 来源优先级策略 ───

export interface HookSourcePolicy {
  /** 优先级数值（数值越大优先级越高） */
  readonly precedence: number;
  /** 是否信任本地代码 */
  readonly trustedLocalCode: boolean;
  /** 默认启用模式 */
  readonly defaultEnableMode: "default-on" | "explicit-opt-in";
  /** 可覆盖的来源列表 */
  readonly canOverride: readonly HookSource[];
  /** 可被覆盖的来源列表 */
  readonly canBeOverriddenBy: readonly HookSource[];
}

// ─── 五级来源优先级常量 ───

export const HOOK_SOURCE_POLICIES: Readonly<
  Record<HookSource, HookSourcePolicy>
> = {
  builtin: {
    precedence: 10,
    trustedLocalCode: true,
    defaultEnableMode: "default-on",
    canOverride: ["builtin"],
    canBeOverriddenBy: ["plugin", "managed", "workspace", "user"],
  },
  plugin: {
    precedence: 20,
    trustedLocalCode: true,
    defaultEnableMode: "default-on",
    canOverride: ["builtin", "plugin"],
    canBeOverriddenBy: ["managed", "workspace", "user"],
  },
  managed: {
    precedence: 30,
    trustedLocalCode: true,
    defaultEnableMode: "default-on",
    canOverride: ["builtin", "plugin", "managed"],
    canBeOverriddenBy: ["workspace", "user"],
  },
  user: {
    precedence: 40,
    trustedLocalCode: true,
    defaultEnableMode: "default-on",
    canOverride: ["builtin", "plugin", "managed", "user"],
    canBeOverriddenBy: ["workspace"],
  },
  workspace: {
    precedence: 50,
    trustedLocalCode: true,
    defaultEnableMode: "explicit-opt-in",
    canOverride: ["workspace"],
    canBeOverriddenBy: ["workspace"],
  },
} as const;

// ─── 钩子注册表接口 ───

export interface HookRegistry {
  /** 注册钩子 */
  register(hook: HookDefinition): boolean;
  /** 注销钩子 */
  unregister(id: string): boolean;
  /** 获取钩子 */
  get(id: string): HookDefinition | undefined;
  /** 按事件查询钩子（按优先级排序） */
  getByEvent(event: string): readonly HookDefinition[];
  /** 按事件+动作查询 */
  getByEventAction(event: string, action: string): readonly HookDefinition[];
  /** 按来源查询 */
  getBySource(source: HookSource): readonly HookDefinition[];
  /** 启用/禁用钩子 */
  setEnabled(id: string, enabled: boolean): boolean;
  /** 检查覆盖关系 */
  canOverride(
    challenger: HookSource,
    incumbent: HookSource,
  ): boolean;
  /** 获取所有钩子 */
  listAll(): readonly HookDefinition[];
  /** 获取钩子数量 */
  count(): number;
  /** 清除所有钩子 */
  clear(): void;
}

// ─── 创建钩子注册表 ───

export function createHookRegistry(): HookRegistry {
  const hooks = new Map<string, HookDefinition>();

  /** 按优先级排序的查询结果 */
  function sortByPriority(
    list: readonly HookDefinition[],
  ): readonly HookDefinition[] {
    return [...list].sort((a, b) => {
      // 先按来源优先级降序（precedence 高的先执行）
      const precDiff =
        HOOK_SOURCE_POLICIES[b.source].precedence -
        HOOK_SOURCE_POLICIES[a.source].precedence;
      if (precDiff !== 0) return precDiff;
      // 同来源按钩子优先级升序（priority 数值小的先执行）
      return a.priority - b.priority;
    });
  }

  function register(hook: HookDefinition): boolean {
    if (hooks.has(hook.id)) return false;
    hooks.set(hook.id, hook);
    return true;
  }

  function unregister(id: string): boolean {
    return hooks.delete(id);
  }

  function get(id: string): HookDefinition | undefined {
    return hooks.get(id);
  }

  function getByEvent(event: string): readonly HookDefinition[] {
    const result: HookDefinition[] = [];
    for (const hook of hooks.values()) {
      if (hook.event === event && hook.enabled && hook.action === undefined) {
        result.push(hook);
      }
    }
    return sortByPriority(result);
  }

  function getByEventAction(
    event: string,
    action: string,
  ): readonly HookDefinition[] {
    const result: HookDefinition[] = [];
    for (const hook of hooks.values()) {
      if (hook.event === event && hook.enabled && hook.action === action) {
        result.push(hook);
      }
    }
    return sortByPriority(result);
  }

  function getBySource(source: HookSource): readonly HookDefinition[] {
    const result: HookDefinition[] = [];
    for (const hook of hooks.values()) {
      if (hook.source === source) {
        result.push(hook);
      }
    }
    return result;
  }

  function setEnabled(id: string, enabled: boolean): boolean {
    const hook = hooks.get(id);
    if (hook === undefined) return false;
    // 不可变：创建新对象替换
    const updated: HookDefinition = {
      ...hook,
      enabled,
    };
    hooks.set(id, updated);
    return true;
  }

  function canOverride(
    challenger: HookSource,
    incumbent: HookSource,
  ): boolean {
    const challengerPolicy = HOOK_SOURCE_POLICIES[challenger];
    return challengerPolicy.canOverride.includes(incumbent);
  }

  function listAll(): readonly HookDefinition[] {
    return [...hooks.values()];
  }

  function count(): number {
    return hooks.size;
  }

  function clear(): void {
    hooks.clear();
  }

  return {
    register,
    unregister,
    get,
    getByEvent,
    getByEventAction,
    getBySource,
    setEnabled,
    canOverride,
    listAll,
    count,
    clear,
  };
}
