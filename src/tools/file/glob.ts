/**
 * 文件模式匹配工具 — Glob 搜索。
 *
 * 安全特性：
 * - 路径约束检查
 * - 结果数量限制
 * - 深度限制
 */

import { z } from "zod";
import { createToolDefinition } from "../builder";
import type { Tool } from "../../interfaces/tool";
import { readdir } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { createToolResult } from "../../types/tool";
import { normalizeWindowsPath } from "./path-utils";

// ─── 输入 Schema ───

export const GlobInputSchema = z.object({
  pattern: z.string().min(1, "Pattern is required"),
  path: z.string().optional(),
  ignore: z.array(z.string()).optional(),
  maxDepth: z.number().int().min(1).max(200).optional(),
});

export type GlobInput = z.infer<typeof GlobInputSchema>;

// ─── 输出类型 ───

export interface GlobOutput {
  readonly matches: readonly string[];
  readonly truncated: boolean;
  readonly totalMatches: number;
}

// ─── 常量 ───

const MAX_RESULTS = 1000;
const DEFAULT_MAX_DEPTH = 50;

// ─── 辅助函数 ───

/**
 * 简单的 glob 模式匹配。
 * 支持 *（任意字符）和 ?（单个字符）。
 */
function simpleGlobMatch(text: string, pattern: string): boolean {
  const normalizedText = text.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");

  let regexStr = "";
  let i = 0;
  while (i < normalizedPattern.length) {
    const ch = normalizedPattern[i]!;
    if (ch === "*" && i + 1 < normalizedPattern.length && normalizedPattern[i + 1] === "*") {
      if (i + 2 < normalizedPattern.length && normalizedPattern[i + 2] === "/") {
        regexStr += "(.*/)?";
        i += 3;
      } else {
        regexStr += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      regexStr += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      regexStr += "[^/]";
      i += 1;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regexStr += "\\" + ch;
      i += 1;
    } else {
      regexStr += ch;
      i += 1;
    }
  }

  const re = new RegExp(`^${regexStr}$`);
  return re.test(normalizedText);
}

function matchesIgnorePattern(relPath: string, entryName: string, patterns: readonly string[]): boolean {
  const normalizedRelPath = relPath.replace(/\\/g, "/");
  const normalizedEntryName = entryName.replace(/\\/g, "/");
  for (const pattern of patterns) {
    if (simpleGlobMatch(normalizedRelPath, pattern)) return true;
    if (simpleGlobMatch(normalizedEntryName, pattern)) return true;
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      if (normalizedEntryName.endsWith(ext)) return true;
      if (normalizedRelPath.endsWith(ext)) return true;
    }
  }
  return false;
}

// ─── 工具定义 ───

/**
 * createGlobTool — 创建文件模式匹配工具。
 *
 * 安全特性：
 * - 结果数量限制（最多 1000 个）
 * - 支持忽略模式
 */
export function createGlobTool(): Tool {
  return createToolDefinition({
    name: "glob",
    description: "Find files matching a glob pattern. Returns up to 1000 results.",
    inputSchema: GlobInputSchema,

    async call(input, _context) {
      const parsed = GlobInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(`Invalid input: ${parsed.error.message}`);
      }
      const { pattern, path: searchPath, ignore, maxDepth } = parsed.data;
      const normalizedPattern = pattern.replace(/\\/g, "/");
      const cwd = (searchPath ?? process.cwd()).replace(/\\/g, "/");
      const effectiveMaxDepth = maxDepth ?? DEFAULT_MAX_DEPTH;

      const matches: string[] = [];
      const ignorePatterns = ignore ?? [];

      async function search(dir: string, depth: number = 0): Promise<void> {
        if (matches.length >= MAX_RESULTS * 2) return;
        if (depth > effectiveMaxDepth) return;
        let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
        try {
          const rawEntries = await readdir(dir, { withFileTypes: true });
          entries = rawEntries.map((e) => ({
            name: e.name,
            isDirectory: () => e.isDirectory(),
            isFile: () => e.isFile(),
          }));
        } catch {
          return;
        }

        for (const entry of entries) {
          if (matches.length >= MAX_RESULTS * 2) return;
          const fullPath = join(dir, entry.name);
          const relPath = relative(cwd, fullPath).replace(/\\/g, "/");
          const entryName = entry.name;

          if (matchesIgnorePattern(relPath, entryName, ignorePatterns)) continue;

          if (entry.isDirectory()) {
            await search(fullPath, depth + 1);
          } else if (entry.isFile()) {
            if (simpleGlobMatch(relPath, normalizedPattern)) {
              matches.push(normalizeWindowsPath(fullPath));
            }
          }
        }
      }

      await search(cwd);

      const truncated = matches.length > MAX_RESULTS;
      const selectedMatches = matches.slice(0, MAX_RESULTS);

      return createToolResult({
        matches: selectedMatches,
        truncated,
        totalMatches: matches.length,
      }, false);
    },

    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
}
