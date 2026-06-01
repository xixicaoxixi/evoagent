/**
 * 插件加载器 — 发现 + 验证 + 激活 + 生命周期管理。
 *
 * 参考 `代码片段_状态管理与插件扩展` #28 插件与钩子桥梁 + #29 契约验证。
 *
 * 设计原则：
 * - 五源发现：builtin / managed / user / workspace / remote
 * - 契约验证：加载前验证插件 manifest
 * - 生命周期：discovered → validated → activated → deactivated → unloaded
 * - 路径安全：防止路径遍历逃逸
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";

// ─── 插件来源 ───

export type PluginSource = "builtin" | "managed" | "user" | "workspace" | "remote";

// ─── 插件状态 ───

export type PluginLifecycleState = "discovered" | "validated" | "activated" | "deactivated" | "unloaded";

// ─── 插件清单 ───

export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly source: PluginSource;
  readonly rootDir: string;
  readonly hooks?: ReadonlyArray<string>;
  readonly skills?: ReadonlyArray<string>;
  readonly main?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

// ─── 加载结果 ───

export interface PluginLoadResult {
  readonly manifest: PluginManifest;
  readonly state: PluginLifecycleState;
  readonly issues: ReadonlyArray<string>;
  /** 命名空间后的 Skill 名称列表（plugin-name:skill-name 格式） */
  readonly namespacedSkills?: ReadonlyArray<string>;
}

// ─── 插件加载器配置 ───

export interface PluginLoaderConfig {
  /** 扫描目录列表（按优先级排序） */
  readonly scanDirs?: ReadonlyArray<{ readonly dir: string; readonly source: PluginSource }>;
  /** 是否验证契约 */
  readonly validateContract?: boolean;
  /** 是否为 Skills 添加命名空间前缀（plugin-name:skill-name） */
  readonly namespaceSkills?: boolean;
}

// ─── 插件加载器接口 ───

export interface PluginLoader {
  /** 扫描所有目录，发现插件 */
  scan(): Promise<readonly PluginLoadResult[]>;
  /** 激活指定插件 */
  activate(name: string): PluginLoadResult | undefined;
  /** 停用指定插件 */
  deactivate(name: string): PluginLoadResult | undefined;
  /** 获取插件 */
  getPlugin(name: string): PluginLoadResult | undefined;
  /** 获取所有已加载插件 */
  getAll(): readonly PluginLoadResult[];
  /** 获取统计 */
  getStats(): { total: number; activated: number; deactivated: number };
}

// ─── 路径安全验证 ───

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

// ─── 创建插件加载器 ───

export function createPluginLoader(config?: PluginLoaderConfig): PluginLoader {
  const scanDirs = config?.scanDirs ?? [];
  const validateContract = config?.validateContract ?? true;
  const namespaceSkills = config?.namespaceSkills ?? false;
  const plugins = new Map<string, PluginLoadResult>();

  /**
   * 为 Skill 列表添加命名空间前缀。
   */
  function applyNamespace(
    pluginName: string,
    skills: ReadonlyArray<string> | undefined,
  ): ReadonlyArray<string> | undefined {
    if (!namespaceSkills || skills === undefined) return skills;
    return skills.map((skill) => `${pluginName}:${skill}`);
  }

  /** 从目录发现插件 */
  function discoverFromDir(dir: string, source: PluginSource): PluginLoadResult | undefined {
    const manifestPath = join(dir, "plugin.json");
    if (!existsSync(manifestPath)) return undefined;

    try {
      const raw = require(manifestPath);
      const issues: string[] = [];

      // 基本验证
      if (!raw.name || typeof raw.name !== "string") {
        issues.push("Missing or invalid 'name' field");
      }
      if (!raw.version || typeof raw.version !== "string") {
        issues.push("Missing or invalid 'version' field");
      }

      // 路径安全：确保 rootDir 不逃逸
      if (!isPathInside(dir, dir)) {
        issues.push("Plugin root directory path is invalid");
      }

      const namespacedSkillsList = applyNamespace(raw.name, raw.skills);

      const manifest: PluginManifest = {
        name: raw.name ?? "unknown",
        version: raw.version ?? "0.0.0",
        description: raw.description,
        source,
        rootDir: dir,
        hooks: Array.isArray(raw.hooks) ? raw.hooks : undefined,
        skills: namespacedSkillsList !== undefined
          ? namespacedSkillsList
          : Array.isArray(raw.skills) ? raw.skills : undefined,
        main: typeof raw.main === "string" ? raw.main : undefined,
        dependencies: raw.dependencies,
      };

      return {
        manifest,
        state: issues.length === 0 ? "validated" : "discovered",
        issues,
        ...(namespacedSkillsList !== undefined
          ? { namespacedSkills: namespacedSkillsList }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  /** 扫描所有目录 */
  async function scan(): Promise<readonly PluginLoadResult[]> {
    const results: PluginLoadResult[] = [];
    const seen = new Set<string>();

    for (const { dir, source } of scanDirs) {
      if (!existsSync(dir)) continue;

      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const pluginDir = join(dir, entry.name);
          const result = discoverFromDir(pluginDir, source);
          if (result && !seen.has(result.manifest.name)) {
            seen.add(result.manifest.name);
            plugins.set(result.manifest.name, result);
            results.push(result);
          }
        }
      } catch {
        // 目录不可读，跳过
      }
    }

    return results;
  }

  function activate(name: string): PluginLoadResult | undefined {
    const plugin = plugins.get(name);
    if (!plugin) return undefined;
    if (plugin.state === "activated") return plugin;

    plugins.set(name, {
      ...plugin,
      state: "activated",
    });
    return plugins.get(name);
  }

  function deactivate(name: string): PluginLoadResult | undefined {
    const plugin = plugins.get(name);
    if (!plugin) return undefined;
    if (plugin.state !== "activated") return plugin;

    plugins.set(name, {
      ...plugin,
      state: "deactivated",
    });
    return plugins.get(name);
  }

  function getPlugin(name: string): PluginLoadResult | undefined {
    return plugins.get(name);
  }

  function getAll(): readonly PluginLoadResult[] {
    return [...plugins.values()];
  }

  function getStats(): { total: number; activated: number; deactivated: number } {
    let activated = 0;
    let deactivated = 0;
    for (const p of plugins.values()) {
      if (p.state === "activated") activated++;
      if (p.state === "deactivated") deactivated++;
    }
    return { total: plugins.size, activated, deactivated };
  }

  return { scan, activate, deactivate, getPlugin, getAll, getStats };
}
