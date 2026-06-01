/**
 * 记忆目录扫描 — 扫描记忆目录并构建索引。
 *
 * 参考 `代码片段_记忆系统与知识管理补充.md` 片段 #2。
 * 单次扫描：读取 frontmatter → 排序 → 截断。
 */

import type { MemoryHeader } from "./memory-types";
import { parseMemoryType } from "./memory-types";

// ─── 常量 ───

const MAX_MEMORY_FILES = 200;
const FRONTMATTER_MAX_LINES = 30;

// ─── 扫描结果 ───

export interface MemoryScanResult {
  readonly headers: readonly MemoryHeader[];
  readonly manifest: string;
  readonly totalFiles: number;
  readonly scannedFiles: number;
}

// ─── 简单 frontmatter 解析 ───

interface FrontmatterData {
  description?: string;
  type?: string;
  tags?: string[];
}

function parseFrontmatter(content: string): { frontmatter: FrontmatterData } {
  const frontmatter: FrontmatterData = {};

  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { frontmatter };

  const lines = match[1]!.split("\n");
  for (const line of lines) {
    const kvMatch = line.match(/^(\w+):\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1]!.toLowerCase();
      const value = kvMatch[2]!.trim().replace(/^["']|["']$/g, "");
      if (key === "description") frontmatter.description = value;
      if (key === "type") frontmatter.type = value;
      if (key === "tags") {
        frontmatter.tags = value.split(",").map((t) => t.trim()).filter(Boolean);
      }
    }
  }

  return { frontmatter };
}

// ─── 目录扫描 ───

/**
 * scanMemoryHeaders — 扫描内存中的记忆条目列表并构建索引。
 *
 * 在完整实现中，这里会读取文件系统。当前版本接受已解析的记忆列表。
 */
export function scanMemoryHeaders(
  memories: ReadonlyArray<{
    readonly filename: string;
    readonly filePath: string;
    readonly mtimeMs: number;
    readonly description?: string;
    readonly type?: string;
  }>,
): MemoryHeader[] {
  return memories
    .map((m) => ({
      filename: m.filename,
      filePath: m.filePath,
      mtimeMs: m.mtimeMs,
      description: m.description ?? null,
      type: parseMemoryType(m.type),
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES);
}

/**
 * formatMemoryManifest — 格式化记忆索引为文本清单。
 */
export function formatMemoryManifest(memories: readonly MemoryHeader[]): string {
  return memories
    .map((m) => {
      const tag = m.type ? `[${m.type}] ` : "";
      const ts = new Date(m.mtimeMs).toISOString();
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`;
    })
    .join("\n");
}

/**
 * buildMemoryScanResult — 构建完整的扫描结果。
 */
export function buildMemoryScanResult(
  memories: ReadonlyArray<{
    readonly filename: string;
    readonly filePath: string;
    readonly mtimeMs: number;
    readonly description?: string;
    readonly type?: string;
  }>,
): MemoryScanResult {
  const headers = scanMemoryHeaders(memories);
  return {
    headers,
    manifest: formatMemoryManifest(headers),
    totalFiles: memories.length,
    scannedFiles: headers.length,
  };
}
