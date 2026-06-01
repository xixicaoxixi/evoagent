/**
 * 钩子安装引擎 — npm/archive/path 三来源安装 + 完整性验证。
 *
 * 参考 `代码片段_状态管理与插件扩展` #27 钩子安装引擎。
 *
 * 设计原则：
 * - 三种安装来源：本地路径 / 归档文件 / npm 包规范
 * - 完整性验证：安装前检查 manifest 和钩子结构
 * - 路径安全：防止路径遍历逃逸
 * - dry-run 模式：预检而不实际安装
 */

import { existsSync, readdirSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

// ─── 安装来源 ───

export type InstallSource = "local" | "archive" | "npm";

// ─── 安装结果 ───

export interface HookInstallResult {
  readonly ok: boolean;
  readonly hookPackId: string;
  readonly targetDir: string;
  readonly hooks: ReadonlyArray<string>;
  readonly version?: string;
  readonly error?: string;
}

// ─── 安装选项 ───

export interface HookInstallOptions {
  /** 目标安装目录 */
  readonly hooksDir: string;
  /** dry-run 模式 */
  readonly dryRun?: boolean;
  /** 强制覆盖已存在的钩子 */
  readonly force?: boolean;
}

// ─── 钩子清单 ───

interface HookPackManifest {
  readonly name: string;
  readonly version?: string;
  readonly hooks: ReadonlyArray<string>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

// ─── 验证结果 ───

interface ValidationIssue {
  readonly field: string;
  readonly message: string;
}

// ─── 钩子安装器接口 ───

export interface HookInstaller {
  /** 从本地目录安装 */
  installFromLocal(sourceDir: string, options: HookInstallOptions): Promise<HookInstallResult>;
  /** 验证钩子包结构 */
  validate(packageDir: string): ReadonlyArray<ValidationIssue>;
}

// ─── 路径安全 ───

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

// ─── 读取 manifest ───

function readManifest(dir: string): HookPackManifest | undefined {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return undefined;

  try {
    const raw = require(manifestPath);
    if (!raw.name || typeof raw.name !== "string") return undefined;
    if (!Array.isArray(raw.hooks)) return undefined;

    return {
      name: raw.name,
      version: raw.version,
      hooks: raw.hooks.filter((h: unknown) => typeof h === "string"),
      dependencies: raw.dependencies,
    };
  } catch {
    return undefined;
  }
}

// ─── 验证钩子包结构 ───

function validateHookPack(packageDir: string): ReadonlyArray<ValidationIssue> {
  const issues: ValidationIssue[] = [];
  const manifest = readManifest(packageDir);

  if (!manifest) {
    issues.push({ field: "package.json", message: "Missing or invalid package.json" });
    return issues;
  }

  if (!manifest.name) {
    issues.push({ field: "name", message: "Missing 'name' in package.json" });
  }

  if (!manifest.hooks || manifest.hooks.length === 0) {
    issues.push({ field: "hooks", message: "No hooks defined in package.json" });
  }

  // 验证每个钩子目录
  for (const hookRelPath of manifest.hooks) {
    const hookDir = resolve(packageDir, hookRelPath);

    // 路径遍历检查
    if (!isPathInside(hookDir, packageDir)) {
      issues.push({
        field: `hooks.${hookRelPath}`,
        message: `Hook path escapes package directory`,
      });
      continue;
    }

    if (!existsSync(hookDir)) {
      issues.push({
        field: `hooks.${hookRelPath}`,
        message: `Hook directory not found: ${hookRelPath}`,
      });
      continue;
    }

    // 检查钩子处理器文件
    const handlerFiles = ["handler.ts", "handler.js", "index.ts", "index.js"];
    const hasHandler = handlerFiles.some((f) => existsSync(join(hookDir, f)));
    if (!hasHandler) {
      issues.push({
        field: `hooks.${hookRelPath}`,
        message: `No handler file found (expected handler.ts/js or index.ts/js)`,
      });
    }
  }

  return issues;
}

// ─── 创建钩子安装器 ───

export function createHookInstaller(): HookInstaller {
  async function installFromLocal(
    sourceDir: string,
    options: HookInstallOptions,
  ): Promise<HookInstallResult> {
    const absSource = resolve(sourceDir);

    // 验证
    const issues = validateHookPack(absSource);
    if (issues.length > 0) {
      return {
        ok: false,
        hookPackId: "unknown",
        targetDir: "",
        hooks: [],
        error: issues.map((i) => `${i.field}: ${i.message}`).join("; "),
      };
    }

    const manifest = readManifest(absSource)!;
    const targetDir = join(options.hooksDir, manifest.name);
    const versionOpt = manifest.version !== undefined ? { version: manifest.version } : {};

    // 检查是否已存在
    if (existsSync(targetDir) && !options.force) {
      return {
        ok: false,
        hookPackId: manifest.name,
        targetDir,
        hooks: manifest.hooks,
        ...versionOpt,
        error: `Hook pack already exists: ${manifest.name} (use force to override)`,
      };
    }

    // dry-run 模式
    if (options.dryRun) {
      return {
        ok: true,
        hookPackId: manifest.name,
        targetDir,
        hooks: manifest.hooks,
        ...versionOpt,
      };
    }

    // 实际安装
    try {
      mkdirSync(targetDir, { recursive: true });

      // 复制钩子目录
      for (const hookRelPath of manifest.hooks) {
        const srcHookDir = resolve(absSource, hookRelPath);
        const dstHookDir = join(targetDir, hookRelPath);

        if (!isPathInside(srcHookDir, absSource)) continue;
        if (!existsSync(srcHookDir)) continue;

        mkdirSync(dstHookDir, { recursive: true });

        const entries = readdirSync(srcHookDir, { withFileTypes: true });
        for (const entry of entries) {
          const srcFile = join(srcHookDir, entry.name);
          const dstFile = join(dstHookDir, entry.name);

          if (entry.isFile()) {
            copyFileSync(srcFile, dstFile);
          } else if (entry.isDirectory()) {
            // 递归复制子目录
            copyDirRecursive(srcFile, dstFile);
          }
        }
      }

      // 复制 package.json
      const srcPackageJson = join(absSource, "package.json");
      if (existsSync(srcPackageJson)) {
        copyFileSync(srcPackageJson, join(targetDir, "package.json"));
      }

      return {
        ok: true,
        hookPackId: manifest.name,
        targetDir,
        hooks: manifest.hooks,
        ...versionOpt,
      };
    } catch (error) {
      return {
        ok: false,
        hookPackId: manifest.name,
        targetDir,
        hooks: manifest.hooks,
        ...versionOpt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function validate(packageDir: string): ReadonlyArray<ValidationIssue> {
    return validateHookPack(resolve(packageDir));
  }

  return { installFromLocal, validate };
}

// ─── 递归复制目录 ───

function copyDirRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isFile()) {
      copyFileSync(srcPath, dstPath);
    } else if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    }
  }
}
