/**
 * JSONL 格式读写。
 *
 * 用于触发日志、消融结果等追加型数据存储。
 * RULES_2-7: 原子写入（每行独立写入）。
 */

import { readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 追加一行 JSON 到文件。
 * 每行是一个独立的 JSON 对象（JSONL 格式）。
 */
export async function appendJSONL(
  filePath: string,
  record: unknown,
): Promise<void> {
  if (!existsSync(dirname(filePath))) {
    await mkdir(dirname(filePath), { recursive: true });
  }

  const line = `${JSON.stringify(record)}\n`;
  await appendFile(filePath, line, "utf-8");
}

/**
 * 读取 JSONL 文件的所有行。
 *
 * @param filePath - 文件路径
 * @param options - 读取选项
 * @returns 解析后的记录数组
 */
export async function readJSONL<T = unknown>(
  filePath: string,
  options?: {
    readonly limit?: number;
    readonly offset?: number;
  },
): Promise<T[]> {
  if (!existsSync(filePath)) {
    return [];
  }

  const content = await readFile(filePath, "utf-8");
  const lines = content
    .split("\n")
    .filter((line) => line.trim().length > 0);

  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? lines.length;

  const sliced = lines.slice(offset, offset + limit);
  return sliced.map((line) => JSON.parse(line) as T);
}

/**
 * 读取 JSONL 文件的最后 N 行（从尾部读取）。
 */
export async function readJSONLLast<T = unknown>(
  filePath: string,
  count: number,
): Promise<T[]> {
  if (!existsSync(filePath)) {
    return [];
  }

  const content = await readFile(filePath, "utf-8");
  const lines = content
    .split("\n")
    .filter((line) => line.trim().length > 0);

  const sliced = lines.slice(-count);
  return sliced.map((line) => JSON.parse(line) as T);
}

/**
 * 获取 JSONL 文件的行数。
 */
export async function countJSONL(filePath: string): Promise<number> {
  if (!existsSync(filePath)) {
    return 0;
  }

  const content = await readFile(filePath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

/**
 * 截断 JSONL 文件到指定行数。
 * RULES_2-10: 两层截断。
 */
export async function truncateJSONL(
  filePath: string,
  maxLines: number,
): Promise<number> {
  if (!existsSync(filePath)) {
    return 0;
  }

  const allRecords = await readJSONL(filePath);
  if (allRecords.length <= maxLines) {
    return allRecords.length;
  }

  const truncated = allRecords.slice(-maxLines);
  await writeFile(filePath, truncated.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  return truncated.length;
}
