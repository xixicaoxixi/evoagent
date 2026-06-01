/**
 * A.2 引用清除验证测试 — 验证源码中无外部项目引用残留。
 *
 * 覆盖范围：
 * - src/ 中无 claude-code 引用
 * - src/ 中无 openclaw 引用
 * - src/ 中无 HackerOne 引用
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      files.push(...getAllTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function searchInFiles(files: string[], pattern: RegExp): Array<{ file: string; line: number; content: string }> {
  const matches: Array<{ file: string; line: number; content: string }> = [];
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i]!)) {
        matches.push({ file: file.replace(SRC_DIR + "/", ""), line: i + 1, content: lines[i]! });
      }
    }
  }
  return matches;
}

describe("A.2 > 引用清除验证", { timeout: 30_000 }, () => {
  const srcFiles = getAllTsFiles(SRC_DIR);

  it("src/ 中无 claude-code 引用", () => {
    const matches = searchInFiles(srcFiles, /claude-code/);
    expect(matches.length).toBe(0);
  });

  it("src/ 中无 openclaw 引用", () => {
    const matches = searchInFiles(srcFiles, /openclaw/);
    expect(matches.length).toBe(0);
  });

  it("src/ 中无 HackerOne 引用", () => {
    const matches = searchInFiles(srcFiles, /HackerOne/);
    expect(matches.length).toBe(0);
  });
});
