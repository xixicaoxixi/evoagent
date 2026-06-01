/**
 * 文件写入工具 — 安全的文件创建/覆盖。
 *
 * 安全特性：
 * - Read-before-Write（RULES_2-9）
 * - 原子写入（tmp + rename）（RULES_2-7）
 * - 路径验证
 * - 大小限制
 */

import { z } from "zod";
import { createToolDefinition } from "../builder";
import type { Tool } from "../../interfaces/tool";
import { atomicWriteText } from "../../persistence/atomic-write";
import { createToolResult } from "../../types/tool";
import { normalizeWindowsPath, validatePath } from "./path-utils";

// ─── 输入 Schema ───

export const FileWriteInputSchema = z.object({
  file_path: z.string().min(1, "File path is required"),
  content: z.string(),
});

export type FileWriteInput = z.infer<typeof FileWriteInputSchema>;

// ─── 输出类型 ───

export interface FileWriteOutput {
  readonly success: true;
  readonly path: string;
  readonly bytesWritten: number;
  readonly warning?: string;
}

// ─── 常量 ───

const MAX_CONTENT_SIZE = 100 * 1024 * 1024;

// ─── Read State 接口 ───

/**
 * 文件读取状态追踪器。
 * 用于实现 Read-before-Write 安全策略。
 */
export interface ReadFileState {
  markRead(filePath: string, isPartialView: boolean, mtimeMs?: number): void;
  wasRead(filePath: string): { readonly read: true; readonly isPartialView: boolean; readonly mtimeMs?: number } | { readonly read: false };
}

export function createMemoryReadFileState(): ReadFileState {
  const state = new Map<string, { readonly isPartialView: boolean; readonly mtimeMs?: number }>();

  return {
    markRead(filePath: string, isPartialView: boolean, mtimeMs?: number) {
      state.set(filePath, { isPartialView, ...(mtimeMs !== undefined ? { mtimeMs } : {}) });
    },
    wasRead(filePath: string) {
      const entry = state.get(filePath);
      if (entry === undefined) return { read: false as const };
      return { read: true as const, isPartialView: entry.isPartialView, ...(entry.mtimeMs !== undefined ? { mtimeMs: entry.mtimeMs } : {}) };
    },
  };
}

// ─── 工具定义 ───

/**
 * createFileWriteTool — 创建文件写入工具。
 *
 * 安全特性：
 * - Read-before-Write（必须先读取文件才能写入）
 * - 原子写入（tmp + rename）
 * - 路径验证
 * - 大小限制（100MB）
 */
export function createFileWriteTool(
  readFileState?: ReadFileState,
): Tool {
  return createToolDefinition({
    name: "file_write",
    description: "Write content to a file. File must be read first (Read-before-Write). Uses atomic write (tmp + rename).",
    inputSchema: FileWriteInputSchema,

    async call(input, _context) {
      const parsed = FileWriteInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(`Invalid input: ${parsed.error.message}`);
      }
      const { file_path, content } = parsed.data;

      const pathCheck = validatePath(file_path);
      if (!pathCheck.valid) {
        throw new Error(pathCheck.reason);
      }

      // 大小检查
      if (content.length > MAX_CONTENT_SIZE) {
        throw new Error(`Content too large: ${content.length} bytes (max ${MAX_CONTENT_SIZE})`);
      }

      const fs = await import("node:fs/promises");

      // Read-before-Write 检查
      if (readFileState !== undefined) {
        // 检查文件是否已存在
        let fileExists = false;
        try {
          await fs.stat(file_path);
          fileExists = true;
        } catch {
          // 文件不存在，无需先读取
        }

        if (fileExists) {
          const readStatus = readFileState.wasRead(file_path);
          if (!readStatus.read) {
            throw new Error(
              `File has not been read yet. Read it first before writing to it.`,
            );
          }
          if (readStatus.isPartialView) {
            throw new Error(
              `File was only partially read. Read the full file before writing.`,
            );
          }

          if (readStatus.mtimeMs !== undefined) {
            const currentStat = await fs.stat(file_path);
            if (currentStat.mtimeMs !== readStatus.mtimeMs) {
              throw new Error(
                `File was modified externally since last read (read mtime: ${readStatus.mtimeMs}, current: ${currentStat.mtimeMs}). ` +
                `Re-read the file before writing.`,
              );
            }
          }
        }
      }

      // 原子写入
      await atomicWriteText(file_path, content);

      if (readFileState !== undefined) {
        const newStat = await fs.stat(file_path);
        readFileState.markRead(file_path, false, newStat.mtimeMs);
      }

      const TAIL_VERIFY_BYTES = 64;
      let warning: string | undefined;
      if (content.length > TAIL_VERIFY_BYTES) {
        const expectedTail = content.slice(-TAIL_VERIFY_BYTES);
        try {
          const fs = await import("node:fs/promises");
          const writtenContent = await fs.readFile(file_path, "utf-8");
          const actualTail = writtenContent.slice(-TAIL_VERIFY_BYTES);
          if (actualTail !== expectedTail) {
            warning = "File tail verification mismatch - content may be truncated";
          }
        } catch {
          warning = "File tail verification failed - could not read back written file";
        }
      }

      return createToolResult({
        success: true,
        path: normalizeWindowsPath(file_path),
        bytesWritten: Buffer.byteLength(content, "utf-8"),
        ...(warning ? { warning } : {}),
      }, false);
    },

    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  });
}
