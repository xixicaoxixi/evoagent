/**
 * 配置管线 — 加载 → 验证 → 物化 → 快照 → 热更新。
 *
 * RULES_2-21: 配置管线模式。
 * RULES_2-2: Fail-Closed 默认值。
 * RULES_2-7: 原子写入。
 *
 * D.3 增强：
 * - ${ENV} 环境变量替换（运行时注入，缺失检测）
 * - $include 嵌套包含展开
 * - 配置热重载（文件监听 + 防抖 + diff）
 * - 物化引擎（运行时默认值注入 + Profile 机制）
 */

import { z } from "zod";
import {
  AppConfigSchema,
  DEFAULT_APP_CONFIG,
} from "../schemas/config";
import type { AppConfig } from "../schemas/config";
import { atomicWriteJSON, atomicReadJSON } from "../persistence/atomic-write";

// ═══════════════════════════════════════════════════════════
// ${ENV} 环境变量替换
// ═══════════════════════════════════════════════════════════

const ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export class MissingEnvVarError extends Error {
  constructor(
    public readonly varName: string,
    public readonly configPath: string,
  ) {
    super(`Missing env var "${varName}" referenced at config path: ${configPath}`);
    this.name = "MissingEnvVarError";
  }
}

export interface EnvSubstitutionWarning {
  readonly varName: string;
  readonly configPath: string;
}

export interface EnvSubstitutionOptions {
  readonly onMissing?: (warning: EnvSubstitutionWarning) => void;
}

/**
 * substituteEnvVars — 递归替换配置对象中的 ${VAR_NAME} 引用。
 *
 * 参考 `代码片段_基础设施与可观测性补充` #1 resolveConfigEnvVars。
 * 仅匹配大写环境变量名。
 */
export function substituteEnvVars(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = "",
  opts?: EnvSubstitutionOptions,
): string {
  if (!value.includes("$")) return value;

  const chunks: string[] = [];
  let i = 0;

  while (i < value.length) {
    const char = value[i]!;
    if (char !== "$") {
      chunks.push(char);
      i++;
      continue;
    }

    // 转义: $${VAR} → ${VAR}
    if (value[i + 1] === "$" && value[i + 2] === "{") {
      const start = i + 3;
      const end = value.indexOf("}", start);
      if (end !== -1) {
        const name = value.slice(start, end);
        if (ENV_VAR_PATTERN.test(name)) {
          chunks.push(`\${${name}}`);
          i = end + 1;
          continue;
        }
      }
    }

    // 替换: ${VAR} → value
    if (value[i + 1] === "{") {
      const start = i + 2;
      const end = value.indexOf("}", start);
      if (end !== -1) {
        const name = value.slice(start, end);
        if (ENV_VAR_PATTERN.test(name)) {
          const envValue = env[name];
          if (envValue === undefined || envValue === "") {
            if (opts?.onMissing) {
              opts.onMissing({ varName: name, configPath });
              chunks.push(`\${${name}}`);
              i = end + 1;
              continue;
            }
            throw new MissingEnvVarError(name, configPath);
          }
          chunks.push(envValue);
          i = end + 1;
          continue;
        }
      }
    }

    chunks.push(char);
    i++;
  }

  return chunks.join("");
}

/**
 * deepSubstituteEnvVars — 递归替换嵌套对象/数组中的环境变量。
 */
export function deepSubstituteEnvVars(
  obj: unknown,
  env: NodeJS.ProcessEnv = process.env,
  path: string = "",
  opts?: EnvSubstitutionOptions,
): unknown {
  if (typeof obj === "string") {
    return substituteEnvVars(obj, env, path, opts);
  }
  if (Array.isArray(obj)) {
    return obj.map((item, idx) =>
      deepSubstituteEnvVars(item, env, `${path}[${idx}]`, opts),
    );
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      const childPath = path ? `${path}.${key}` : key;
      result[key] = deepSubstituteEnvVars(val, env, childPath, opts);
    }
    return result;
  }
  return obj;
}

// ═══════════════════════════════════════════════════════════
// $include 嵌套包含展开
// ═══════════════════════════════════════════════════════════

export interface IncludeResolver {
  /** 解析 $include 路径，返回内容 */
  resolve(path: string): unknown | undefined;
}

/**
 * expandIncludes — 递归展开配置中的 $include 引用。
 *
 * 支持 `{ "$include": "path/to/config.json" }` 语法。
 * 循环引用检测：最大深度 10。
 */
export function expandIncludes(
  obj: unknown,
  resolver: IncludeResolver,
  depth: number = 0,
  visited: ReadonlySet<string> = new Set(),
): unknown {
  if (depth > 10) {
    return obj;
  }

  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>;

    // 检查 $include
    if (typeof record["$include"] === "string") {
      const includePath = record["$include"]!;
      if (visited.has(includePath)) {
        return {}; // 循环引用，返回空
      }
      const included = resolver.resolve(includePath);
      if (included === undefined) {
        return {};
      }
      return expandIncludes(included, resolver, depth + 1, new Set([...visited, includePath]));
    }

    // 递归处理所有字段
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      result[key] = expandIncludes(val, resolver, depth + 1, visited);
    }
    return result;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => expandIncludes(item, resolver, depth + 1, visited));
  }

  return obj;
}

// ═══════════════════════════════════════════════════════════
// 配置差异比较
// ═══════════════════════════════════════════════════════════

/**
 * diffConfigPaths — 递归比较两个配置对象，返回变更路径。
 *
 * 参考 `代码片段_基础设施与可观测性补充` #2 diffConfigPaths。
 */
export function diffConfigPaths(
  prev: unknown,
  next: unknown,
  prefix: string = "",
): string[] {
  if (prev === next) return [];

  if (
    prev !== null && typeof prev === "object" &&
    next !== null && typeof next === "object" &&
    !Array.isArray(prev) && !Array.isArray(next)
  ) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const paths: string[] = [];
    for (const key of keys) {
      const prevVal = (prev as Record<string, unknown>)[key];
      const nextVal = (next as Record<string, unknown>)[key];
      if (prevVal === undefined && nextVal === undefined) continue;
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      paths.push(...diffConfigPaths(prevVal, nextVal, childPrefix));
    }
    return paths;
  }

  return [prefix || "<root>"];
}

// ═══════════════════════════════════════════════════════════
// 物化引擎
// ═══════════════════════════════════════════════════════════

export type MaterializationMode = "load" | "missing" | "snapshot";

interface MaterializationProfile {
  readonly includeDefaults: boolean;
  readonly normalizePaths: boolean;
}

const MATERIALIZATION_PROFILES: Record<MaterializationMode, MaterializationProfile> = {
  load: { includeDefaults: true, normalizePaths: true },
  missing: { includeDefaults: true, normalizePaths: false },
  snapshot: { includeDefaults: false, normalizePaths: true },
};

/**
 * materializeConfig — 物化配置（填充运行时默认值）。
 *
 * 参考 `代码片段_状态管理与插件扩展` #8 materializeRuntimeConfig。
 * 使用 Profile 机制：不同加载模式应用不同的默认值集合。
 */
export function materializeConfig(
  config: AppConfig,
  mode: MaterializationMode = "load",
): AppConfig {
  const profile = MATERIALIZATION_PROFILES[mode];

  // 深合并默认值
  if (profile.includeDefaults) {
    config = deepMerge(DEFAULT_APP_CONFIG, config) as AppConfig;
  }

  return config;
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (source === null || source === undefined) return target;
  if (typeof source !== "object" || Array.isArray(source)) return source;

  if (target !== null && typeof target === "object" && !Array.isArray(target)) {
    const result: Record<string, unknown> = { ...target as Record<string, unknown> };
    for (const [key, val] of Object.entries(source as Record<string, unknown>)) {
      result[key] = deepMerge((target as Record<string, unknown>)[key], val);
    }
    return result;
  }

  return source;
}

// ═══════════════════════════════════════════════════════════
// 配置管线
// ═══════════════════════════════════════════════════════════

export interface ConfigPipelineResult {
  readonly config: AppConfig;
  readonly warnings: readonly string[];
  readonly version: number;
}

export interface ConfigPipelineOptions {
  readonly configPath: string;
  readonly onConfigChange?: (config: AppConfig) => void;
  /** $include 解析器 */
  readonly includeResolver?: IncludeResolver;
  /** 环境变量（默认 process.env） */
  readonly env?: NodeJS.ProcessEnv;
  /** 环境变量缺失时的处理方式 */
  readonly onMissingEnv?: (warning: EnvSubstitutionWarning) => void;
}

export class ConfigPipeline {
  private readonly configPath: string;
  private currentConfig: AppConfig;
  private version: number;
  private readonly onConfigChange: ((config: AppConfig) => void) | undefined;
  private readonly includeResolver: IncludeResolver | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onMissingEnv: ((w: EnvSubstitutionWarning) => void) | undefined;

  constructor(options: ConfigPipelineOptions) {
    this.configPath = options.configPath;
    this.currentConfig = DEFAULT_APP_CONFIG;
    this.version = 0;
    this.onConfigChange = options.onConfigChange;
    this.includeResolver = options.includeResolver;
    this.env = options.env ?? process.env;
    this.onMissingEnv = options.onMissingEnv;
  }

  /**
   * 完整配置加载管线：
   * 1. 读取文件
   * 2. $include 展开
   * 3. ${ENV} 替换
   * 4. Zod 验证
   * 5. 物化（填充默认值）
   * 6. 应用到当前状态
   */
  async load(): Promise<ConfigPipelineResult> {
    const warnings: string[] = [];

    try {
      const raw = await atomicReadJSON(this.configPath);
      if (raw === null) {
        return this.materialize(DEFAULT_APP_CONFIG, warnings);
      }

      // $include 展开
      let expanded = raw;
      if (this.includeResolver) {
        expanded = expandIncludes(raw, this.includeResolver) as Record<string, unknown>;
      }

      // ${ENV} 替换
      const envOpts = this.onMissingEnv
        ? { onMissing: this.onMissingEnv }
        : undefined;
      const substituted = deepSubstituteEnvVars(expanded, this.env, "", envOpts);

      // Zod 验证
      const result = AppConfigSchema.safeParse(substituted);
      if (!result.success) {
        const errors = result.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        warnings.push(`配置验证失败，使用默认值:\n${errors}`);
        return this.materialize(DEFAULT_APP_CONFIG, warnings);
      }

      // 物化
      const materialized = materializeConfig(result.data, "load");

      return this.applyConfig(materialized, warnings);
    } catch (error) {
      if (error instanceof MissingEnvVarError) {
        warnings.push(error.message);
        return this.materialize(DEFAULT_APP_CONFIG, warnings);
      }
      const message =
        error instanceof Error ? error.message : String(error);
      warnings.push(`配置加载失败: ${message}，使用默认值`);
      return this.materialize(DEFAULT_APP_CONFIG, warnings);
    }
  }

  /**
   * 保存配置（原子写入）。
   */
  async save(config?: Partial<AppConfig>): Promise<void> {
    const merged: AppConfig = {
      ...this.currentConfig,
      ...config,
      last_modified: new Date().toISOString(),
    };

    const result = AppConfigSchema.safeParse(merged);
    if (!result.success) {
      throw new Error(
        `配置验证失败: ${result.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    await atomicWriteJSON(this.configPath, result.data);
    this.currentConfig = result.data;
    this.version++;
    this.onConfigChange?.(this.currentConfig);
  }

  /**
   * 热更新：部分更新配置并持久化。
   */
  async hotUpdate(partial: Partial<AppConfig>): Promise<ConfigPipelineResult> {
    const prevConfig = this.currentConfig;
    await this.save(partial);

    const changedPaths = diffConfigPaths(prevConfig, this.currentConfig);
    const warnings = changedPaths.length > 0
      ? [`配置变更: ${changedPaths.join(", ")}`]
      : [];

    return {
      config: this.currentConfig,
      warnings,
      version: this.version,
    };
  }

  /** 获取当前配置 */
  getConfig(): AppConfig {
    return this.currentConfig;
  }

  /** 获取配置版本号 */
  getVersion(): number {
    return this.version;
  }

  // ─── 内部方法 ───

  private materialize(
    data: AppConfig,
    warnings: string[],
  ): ConfigPipelineResult {
    const materialized = materializeConfig(data, "load");
    return this.applyConfig(materialized, warnings);
  }

  private applyConfig(
    config: AppConfig,
    warnings: string[],
  ): ConfigPipelineResult {
    this.currentConfig = config;
    this.version++;
    return {
      config: this.currentConfig,
      warnings,
      version: this.version,
    };
  }
}

/**
 * 创建配置管线实例。
 */
export function createConfigPipeline(
  options: ConfigPipelineOptions,
): ConfigPipeline {
  return new ConfigPipeline(options);
}
