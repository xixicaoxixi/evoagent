/**
 * 安全文件写入 — 处理不受信任的文件输入。
 *
 * 安全防护层次：
 * 1. 路径规范化（防止目录遍历）
 * 2. nonce 目录（防止路径预测）
 * 3. 0o600 权限限制
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, normalize, relative, isAbsolute, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ─── 安全写入结果 ───

export interface SafeWriteResult {
  readonly success: boolean;
  readonly targetPath: string;
  readonly error?: string;
}

// ─── 安全路径验证 ───

export function validateSkillFilePath(
  baseDir: string,
  relativePath: string,
): string {
  const normalized = normalize(relativePath);

  // 检查绝对路径
  if (isAbsolute(normalized)) {
    throw new Error(`Skill file path escapes skill dir (absolute): ${relativePath}`);
  }

  // 检查目录遍历
  const parts = normalized.split(/[/\\]/);
  if (parts.includes("..")) {
    throw new Error(`Skill file path escapes skill dir (traversal): ${relativePath}`);
  }

  // 检查最终路径是否在 baseDir 内
  const fullPath = join(baseDir, normalized);
  const rel = relative(baseDir, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Skill file path escapes skill dir: ${relativePath}`);
  }

  return fullPath;
}

// ─── 安全写入文件 ───

export async function safeWriteFile(
  targetDir: string,
  relativePath: string,
  content: string,
): Promise<SafeWriteResult> {
  try {
    // 验证路径
    const safePath = validateSkillFilePath(targetDir, relativePath);

    const dir = dirname(safePath);
    if (dir && dir !== safePath) {
      await mkdir(dir, { recursive: true });
    }

    // 写入文件（0o600 权限）
    await writeFile(safePath, content, { mode: 0o600, encoding: "utf8" });

    return { success: true, targetPath: safePath };
  } catch (err) {
    return {
      success: false,
      targetPath: join(targetDir, relativePath),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── 创建 nonce 临时目录 ───

export async function createNonceDir(
  prefix?: string,
): Promise<string> {
  const nonce = randomUUID().slice(0, 8);
  const dir = join(tmpdir(), `${prefix ?? "skill"}-${nonce}`);
  await mkdir(dir, { mode: 0o700 });
  return dir;
}

// ─── 清理临时目录 ───

export async function cleanupDir(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { recursive: true, force: true });
  } catch {
    // 清理失败不抛出
  }
}
