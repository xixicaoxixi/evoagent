/**
 * 文件编辑工具 — SearchReplace 模式编辑。
 *
 * 安全特性：
 * - Read-before-Write（RULES_2-9）
 * - 原子写入（RULES_2-7）
 * - 搜索验证（确保搜索内容存在）
 * - 唯一性检查（确保搜索内容唯一匹配）
 */

import { z } from "zod";
import { createToolDefinition } from "../builder";
import type { Tool } from "../../interfaces/tool";
import { atomicWriteText } from "../../persistence/atomic-write";
import { createToolResult } from "../../types/tool";
import type { ReadFileState } from "./write";
import { normalizeWindowsPath, validatePath } from "./path-utils";

// ─── 输入 Schema ───

export const FileEditInputSchema = z.object({
  file_path: z.string().min(1, "File path is required"),
  old_str: z.string().min(1, "Search string is required"),
  new_str: z.string(),
  replace_all: z.boolean().default(false),
});

export type FileEditInput = z.infer<typeof FileEditInputSchema>;

// ─── 输出类型 ───

export interface FileEditOutput {
  readonly success: true;
  readonly path: string;
  readonly replacements: number;
  readonly bytesChanged: number;
}

// ─── 工具定义 ───

/**
 * createFileEditTool — 创建文件编辑工具。
 *
 * 安全特性：
 * - Read-before-Write
 * - 原子写入
 * - 搜索验证（old_str 必须存在于文件中）
 * - 唯一性检查（默认要求 old_str 唯一匹配）
 */
export function createFileEditTool(
  readFileState?: ReadFileState,
): Tool {
  return createToolDefinition({
    name: "file_edit",
    description: "Edit a file by searching for old_str and replacing with new_str. File must be read first.",
    inputSchema: FileEditInputSchema,

    async call(input, _context) {
      const parsed = FileEditInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(`Invalid input: ${parsed.error.message}`);
      }
      const { file_path, old_str, new_str, replace_all = false } = parsed.data;

      const pathCheck = validatePath(file_path);
      if (!pathCheck.valid) {
        throw new Error(pathCheck.reason);
      }

      const fs = await import("node:fs/promises");

      // Read-before-Write 检查
      if (readFileState !== undefined) {
        const readStatus = readFileState.wasRead(file_path);
        if (!readStatus.read) {
          throw new Error(
            `File has not been read yet. Read it first before editing it.`,
          );
        }
      }

      // 读取当前文件内容
      const content = await fs.readFile(file_path, "utf-8");

      // 搜索验证
      const occurrences = countOccurrences(content, old_str);
      if (occurrences === 0) {
        throw new Error(
          `Search string not found in file: ${file_path}. ` +
          `Ensure the exact content (including whitespace) matches.`,
        );
      }

      if (!replace_all && occurrences > 1) {
        throw new Error(
          `Search string matches ${occurrences} times in ${file_path}. ` +
          `Include more surrounding lines to uniquely identify the section to replace, ` +
          `or set replace_all to true.`,
        );
      }

      // 执行替换
      let newContent: string;
      if (replace_all) {
        newContent = content.replaceAll(old_str, new_str);
      } else {
        newContent = content.replace(old_str, new_str);
      }

      // 原子写入
      await atomicWriteText(file_path, newContent);

      const bytesChanged = Math.abs(
        Buffer.byteLength(newContent, "utf-8") -
        Buffer.byteLength(content, "utf-8"),
      );

      return createToolResult({
        success: true,
        path: normalizeWindowsPath(file_path),
        replacements: replace_all ? occurrences : 1,
        bytesChanged,
      }, false);
    },

    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  });
}

// ─── 辅助函数 ───

/**
 * 计算字符串在文本中出现的次数。
 */
function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = 0;

  while (true) {
    const index = text.indexOf(search, pos);
    if (index === -1) break;
    count++;
    pos = index + search.length;
  }

  return count;
}
