/**
 * 文件路径处理和安全验证公共工具。
 *
 * 集中管理所有文件工具共享的路径规范化与安全验证逻辑，
 * 消除 read/write/glob/edit 中的重复实现。
 */

import { resolve } from "node:path";

export type PathValidationResult =
  | { readonly valid: true; readonly resolved: string }
  | { readonly valid: false; readonly reason: string };

export function normalizeWindowsPath(filePath: string): string {
  if (process.platform !== "win32") return filePath;
  return filePath.replace(/^\\\\\?\\/, "");
}

export function validatePath(filePath: string, allowedRoot?: string): PathValidationResult {
  if (!filePath || filePath.trim().length === 0) {
    return { valid: false, reason: "Path must not be empty" };
  }

  if (/%[0-9a-fA-F]{2}/.test(filePath)) {
    return { valid: false, reason: "URL-encoded characters not allowed in file path" };
  }

  let resolved: string;
  try {
    resolved = resolve(filePath);
  } catch {
    return { valid: false, reason: "Path resolution failed" };
  }

  if (allowedRoot !== undefined) {
    const resolvedRoot = resolve(allowedRoot);
    const normalizedRoot = resolvedRoot.endsWith("/") || resolvedRoot.endsWith("\\")
      ? resolvedRoot
      : resolvedRoot + (process.platform === "win32" ? "\\" : "/");
    if (!resolved.startsWith(normalizedRoot) && resolved !== resolvedRoot) {
      return { valid: false, reason: `Path escapes allowed directory: ${resolvedRoot}` };
    }
  }

  return { valid: true, resolved };
}
