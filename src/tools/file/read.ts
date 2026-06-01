/**
 * 文件读取工具 — 安全的文件内容读取。
 *
 * 安全特性：
 * - 路径验证（防止路径遍历）
 * - 大小限制（防止内存溢出）
 * - 二进制检测（警告非文本文件）
 * - 行号范围（支持 offset + limit）
 */

import { z } from "zod";
import { createToolDefinition } from "../builder";
import type { Tool } from "../../interfaces/tool";
import { createToolResult } from "../../types/tool";
import type { ReadFileState } from "./write";
import { normalizeWindowsPath, validatePath } from "./path-utils";

// ─── 输入 Schema ───

export const FileReadInputSchema = z.object({
  file_path: z.string().min(1, "File path is required"),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
});

export type FileReadInput = z.infer<typeof FileReadInputSchema>;

// ─── 输出类型 ───

export interface FileReadOutput {
  readonly exists: boolean;
  readonly content: string;
  readonly lineCount: number;
  readonly totalLines: number;
  readonly truncated: boolean;
  readonly encoding: string;
  readonly size: number;
}

// ─── 常量 ───

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_LIMIT = 5000;
const BINARY_CHECK_LENGTH = 8192;

// ─── 辅助函数 ───

/**
 * 检测文件是否是二进制文件。
 * 通过检查前 N 字节中 null 字节的比例来判断。
 */
function isBinaryContent(buffer: Uint8Array): boolean {
  const checkLength = Math.min(buffer.length, BINARY_CHECK_LENGTH);
  let nullCount = 0;

  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      nullCount++;
    }
  }

  // 超过 1% 的 null 字节视为二进制
  return nullCount / checkLength > 0.01;
}

// ─── 工具定义 ───

/**
 * createFileReadTool — 创建文件读取工具。
 *
 * 安全特性：
 * - 路径验证（防止路径遍历）
 * - 大小限制（10MB）
 * - 二进制检测
 * - 行号范围支持
 */
export function createFileReadTool(
  readFileState?: ReadFileState,
): Tool {
  return createToolDefinition({
    name: "file_read",
    description: "Read file contents with optional line range (offset + limit). Supports text files up to 10MB.",
    inputSchema: FileReadInputSchema,

    async call(input, _context) {
      const parsed = FileReadInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(`Invalid input: ${parsed.error.message}`);
      }
      const { file_path, offset = 0, limit = DEFAULT_LIMIT } = parsed.data;

      // 路径验证
      const pathCheck = validatePath(file_path);
      if (!pathCheck.valid) {
        throw new Error(pathCheck.reason);
      }

      const fs = await import("node:fs/promises");
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(file_path);
      } catch {
        if (readFileState !== undefined) {
          readFileState.markRead(file_path, false);
        }
        return createToolResult({
          exists: false,
          content: "",
          lineCount: 0,
          totalLines: 0,
          truncated: false,
          encoding: "utf-8",
          size: 0,
        }, false);
      }

      // 大小检查
      if (stat.size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})`);
      }

      // 二进制检查
      const buffer = new Uint8Array(await fs.readFile(file_path));
      if (isBinaryContent(buffer)) {
        throw new Error(
          `Binary file detected: ${file_path}. Use appropriate tools for binary files.`,
        );
      }

      // 读取文本内容
      const content = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
      const lines = content.split("\n");
      const totalLines = lines.length;

      // 应用行号范围
      const startLine = Math.max(0, offset);
      const endLine = Math.min(totalLines, startLine + limit);
      const selectedLines = lines.slice(startLine, endLine);
      const selectedContent = selectedLines.join("\n");

      const isPartialView = offset > 0 || endLine < totalLines;

      if (readFileState !== undefined) {
        readFileState.markRead(file_path, isPartialView, stat.mtimeMs);
      }

      return createToolResult({
        exists: true,
        content: selectedContent,
        lineCount: selectedLines.length,
        totalLines,
        truncated: endLine < totalLines,
        encoding: "utf-8",
        size: stat.size,
      }, false);
    },

    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
}
