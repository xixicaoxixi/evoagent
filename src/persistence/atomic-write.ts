/**
 * 原子写入 — tmp + rename 模式。
 *
 * RULES_2-7: 原子写入，防止写入过程中断导致数据损坏。
 * RULES_2-9: Read-before-Write（修改前先读取当前状态）。
 */

import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

/**
 * 原子写入 JSON 文件。
 * 先写入临时文件 `.tmp`，再原子重命名。
 *
 * @param filePath - 目标文件路径
 * @param data - 要写入的数据
 * @param options - 写入选项
 */
export async function atomicWriteJSON(
  filePath: string,
  data: unknown,
  options?: {
    readonly encoding?: BufferEncoding;
    readonly mkdirp?: boolean;
  },
): Promise<void> {
  const encoding = options?.encoding ?? "utf-8";
  const shouldMkdirp = options?.mkdirp ?? true;

  // 确保目录存在
  if (shouldMkdirp && !existsSync(dirname(filePath))) {
    await mkdir(dirname(filePath), { recursive: true });
  }

  const tmpPath = `${filePath}.tmp`;

  try {
    const content = JSON.stringify(data, null, 2);
    await writeFile(tmpPath, content, encoding);
    await rename(tmpPath, filePath);
  } catch (error) {
    // 清理临时文件
    try {
      await unlink(tmpPath);
    } catch {
      // 忽略清理失败
    }
    throw error;
  }
}

/**
 * 原子读取 JSON 文件。
 *
 * @param filePath - 文件路径
 * @param options - 读取选项
 * @returns 解析后的 JSON 数据，文件不存在时返回 null
 */
export async function atomicReadJSON<T = unknown>(
  filePath: string,
  options?: {
    readonly encoding?: BufferEncoding;
  },
): Promise<T | null> {
  const encoding = options?.encoding ?? "utf-8";

  if (!existsSync(filePath)) {
    return null;
  }

  const content = await readFile(filePath, encoding);
  return JSON.parse(content) as T;
}

/**
 * 原子写入文本文件。
 */
export async function atomicWriteText(
  filePath: string,
  content: string,
  options?: {
    readonly encoding?: BufferEncoding;
    readonly mkdirp?: boolean;
  },
): Promise<void> {
  const encoding = options?.encoding ?? "utf-8";
  const shouldMkdirp = options?.mkdirp ?? true;

  if (shouldMkdirp && !existsSync(dirname(filePath))) {
    await mkdir(dirname(filePath), { recursive: true });
  }

  const tmpPath = `${filePath}.tmp`;

  try {
    await writeFile(tmpPath, content, encoding);
    await rename(tmpPath, filePath);
  } catch (error) {
    try {
      await unlink(tmpPath);
    } catch {
      // 忽略清理失败
    }
    throw error;
  }
}
