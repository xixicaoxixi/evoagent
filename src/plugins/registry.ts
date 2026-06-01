/**
 * 插件注册表实现 — PluginRegistry 接口的具体实现。
 *
 * RULES_2-4: 接口 + 注册表模式。
 * 支持插件生命周期管理（注册 → 验证 → 激活 → 注销）。
 */

import type {
  PluginEntry,
  PluginRegistry,
  PluginMetadata,
} from "../interfaces/plugin";
import type { Tool } from "../interfaces/tool";
import type { PluginHook } from "../interfaces/plugin";
import { validatePluginContract, type PluginValidationResult } from "./sdk";
import type { ConfigMerger } from "../config/merge";

// ─── 插件状态 ───

export type PluginState = "registered" | "activated" | "deactivated" | "error";

// ─── 插件注册条目 ───

export interface PluginRegistration {
  readonly plugin: PluginEntry;
  readonly state: PluginState;
  readonly registeredAt: number;
  readonly activatedAt?: number;
  readonly error?: string;
}

// ─── 插件注册表配置 ───

export interface PluginRegistryConfig {
  readonly maxPlugins?: number;
  readonly autoActivate?: boolean;
  readonly configMerger?: ConfigMerger;
}

// ─── 默认值 ───

const DEFAULT_MAX_PLUGINS = 100;
const DEFAULT_AUTO_ACTIVATE = true;

// ─── 命名空间相关类型 ───

/** 命名空间冲突警告 */
export interface NamespaceConflict {
  readonly existingPlugin: string;
  readonly existingSkill: string;
  readonly newPlugin: string;
  readonly newSkill: string;
  readonly fullName: string;
}

/** 命名空间解析结果 */
export interface NamespaceResolution {
  /** 完整名称（plugin:skill） */
  readonly fullName: string;
  /** 插件名称 */
  readonly pluginName: string;
  /** Skill 名称 */
  readonly skillName: string;
  /** 是否使用了命名空间 */
  readonly hasNamespace: boolean;
}

// ─── 创建插件注册表 ───

export function createPluginRegistryImpl(
  config?: PluginRegistryConfig,
): PluginRegistryExtended {
  const maxPlugins = config?.maxPlugins ?? DEFAULT_MAX_PLUGINS;
  const autoActivate = config?.autoActivate ?? DEFAULT_AUTO_ACTIVATE;
  const plugins = new Map<string, PluginRegistration>();

  // ─── 命名空间状态 ───

  /** 命名空间 Skill 注册表（fullName → skill） */
  const namespacedSkills = new Map<string, unknown>();
  /** 命名空间 Skill 反向索引（skillName → [pluginName]） */
  const skillNameIndex = new Map<string, string[]>();
  /** 命名空间冲突记录 */
  const conflicts: NamespaceConflict[] = [];

  /** 验证插件 */
  function validate(plugin: PluginEntry): PluginValidationResult {
    return validatePluginContract(plugin.metadata);
  }

  /** 注册插件 */
  function register(plugin: PluginEntry): void {
    // 验证契约
    const validation = validate(plugin);
    if (!validation.valid) {
      throw new Error(
        `Plugin validation failed: ${validation.errors.join("; ")}`,
      );
    }

    // 检查重复
    if (plugins.has(plugin.metadata.name)) {
      throw new Error(`Plugin "${plugin.metadata.name}" is already registered`);
    }

    // 检查上限
    if (plugins.size >= maxPlugins) {
      throw new Error(
        `Plugin limit reached (${maxPlugins}). Cannot register "${plugin.metadata.name}"`,
      );
    }

    const registration: PluginRegistration = {
      plugin,
      state: "registered",
      registeredAt: Date.now(),
    };

    plugins.set(plugin.metadata.name, registration);

    // 自动激活
    if (autoActivate) {
      activatePlugin(plugin.metadata.name);
    }
  }

  /** 激活插件 */
  function activatePlugin(name: string): boolean {
    const registration = plugins.get(name);
    if (registration === undefined) return false;
    if (registration.state === "activated") return true;

    if (registration.plugin.activate !== undefined) {
      try {
        // 异步激活 — 在同步上下文中启动但不等待
        registration.plugin.activate().then(
          () => {
            const current = plugins.get(name);
            if (current !== undefined && current.state !== "error") {
              plugins.set(name, {
                ...current,
                state: "activated",
                activatedAt: Date.now(),
              });
            }
          },
          (err: unknown) => {
            plugins.set(name, {
              ...registration,
              state: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
      } catch {
        // 同步异常
        plugins.set(name, {
          ...registration,
          state: "error",
          error: "activate() threw synchronously",
        });
        return false;
      }
    } else {
      // 无 activate 方法，直接标记为已激活
      plugins.set(name, {
        ...registration,
        state: "activated",
        activatedAt: Date.now(),
      });
    }

    return true;
  }

  /** 注销插件 */
  function unregister(name: string): boolean {
    const registration = plugins.get(name);
    if (registration === undefined) return false;

    // 先停用
    if (registration.state === "activated" && registration.plugin.deactivate !== undefined) {
      try {
        registration.plugin.deactivate();
      } catch {
        // 停用失败不阻止注销
      }
    }

    return plugins.delete(name);
  }

  /** 获取插件 */
  function get(name: string): PluginEntry | undefined {
    return plugins.get(name)?.plugin;
  }

  /** 获取注册条目（含状态） */
  function getRegistration(
    name: string,
  ): PluginRegistration | undefined {
    return plugins.get(name);
  }

  /** 列出所有插件 */
  function listAll(): readonly PluginEntry[] {
    return [...plugins.values()].map((r) => r.plugin);
  }

  /** 按来源筛选 */
  function listBySource(
    source: PluginEntry["metadata"]["source"],
  ): readonly PluginEntry[] {
    return [...plugins.values()]
      .filter((r) => r.plugin.metadata.source === source)
      .map((r) => r.plugin);
  }

  /** 获取插件状态 */
  function getState(name: string): PluginState | undefined {
    return plugins.get(name)?.state;
  }

  /** 获取插件数量 */
  function count(): number {
    return plugins.size;
  }

  /** 清除所有插件 */
  async function clearAll(): Promise<void> {
    // 先停用所有已激活的插件
    for (const registration of plugins.values()) {
      if (
        registration.state === "activated" &&
        registration.plugin.deactivate !== undefined
      ) {
        try {
          await registration.plugin.deactivate();
        } catch {
          // 忽略停用错误
        }
      }
    }
    plugins.clear();
  }

  // ─── 命名空间方法 ───

  function registerNamespacedSkill(
    pluginName: string,
    skillName: string,
    skill: unknown,
  ): NamespaceConflict | undefined {
    const fullName = `${pluginName}:${skillName}`;

    // 检查命名冲突（同名 Skill 被不同插件注册）
    const existingPlugins = skillNameIndex.get(skillName);
    let conflict: NamespaceConflict | undefined;

    if (existingPlugins !== undefined && existingPlugins.length > 0) {
      for (const existingPlugin of existingPlugins) {
        if (existingPlugin !== pluginName) {
          conflict = {
            existingPlugin,
            existingSkill: skillName,
            newPlugin: pluginName,
            newSkill: skillName,
            fullName,
          };
          conflicts.push(conflict);
        }
      }
    }

    // 注册 Skill
    namespacedSkills.set(fullName, skill);

    // 更新反向索引
    if (existingPlugins !== undefined) {
      if (!existingPlugins.includes(pluginName)) {
        existingPlugins.push(pluginName);
      }
    } else {
      skillNameIndex.set(skillName, [pluginName]);
    }

    return conflict;
  }

  function resolveNamespace(fullName: string): NamespaceResolution {
    const colonIdx = fullName.indexOf(":");

    if (colonIdx > 0) {
      return {
        fullName,
        pluginName: fullName.slice(0, colonIdx),
        skillName: fullName.slice(colonIdx + 1),
        hasNamespace: true,
      };
    }

    return {
      fullName,
      pluginName: "",
      skillName: fullName,
      hasNamespace: false,
    };
  }

  function getNamespaceConflicts(): readonly NamespaceConflict[] {
    return [...conflicts];
  }

  function hasNamespaceConflict(pluginName: string, skillName: string): boolean {
    const existingPlugins = skillNameIndex.get(skillName);
    if (existingPlugins === undefined) return false;
    return existingPlugins.some((p) => p !== pluginName);
  }

  function getConfigMerger(): ConfigMerger | undefined {
    return config?.configMerger;
  }

  return {
    register,
    unregister,
    get,
    listAll,
    listBySource,
    // 扩展方法
    activatePlugin,
    getRegistration,
    getState,
    count,
    clearAll,
    // 命名空间方法
    registerNamespacedSkill,
    resolveNamespace,
    getNamespaceConflicts,
    hasNamespaceConflict,
    getConfigMerger,
  };
}

// ─── 扩展的插件注册表类型 ───

export interface PluginRegistryExtended extends PluginRegistry {
  activatePlugin(name: string): boolean;
  getRegistration(name: string): PluginRegistration | undefined;
  getState(name: string): PluginState | undefined;
  count(): number;
  clearAll(): Promise<void>;

  // ─── 命名空间功能 ───

  /**
   * 注册带命名空间的 Skill。
   *
   * 使用 `plugin-name:skill-name` 格式注册。
   * 如果发生命名冲突，记录警告但不阻止注册。
   */
  registerNamespacedSkill(
    pluginName: string,
    skillName: string,
    skill: unknown,
  ): NamespaceConflict | undefined;

  /**
   * 解析带命名空间的名称。
   *
   * 支持格式：
   * - `plugin:skill` → 带命名空间
   * - `skill` → 无命名空间（pluginName 为空字符串）
   */
  resolveNamespace(fullName: string): NamespaceResolution;

  /**
   * 获取所有命名空间冲突。
   */
  getNamespaceConflicts(): readonly NamespaceConflict[];

  /**
   * 检查是否存在命名空间冲突。
   */
  hasNamespaceConflict(pluginName: string, skillName: string): boolean;

  getConfigMerger(): ConfigMerger | undefined;
}
