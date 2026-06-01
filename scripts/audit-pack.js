#!/usr/bin/env node

/**
 * audit-pack.js — 发布内容审计脚本。
 *
 * D.2 修复：在 npm pack 之前检查 dist/ 目录不含敏感信息。
 *
 * 检查项：
 * 1. dist/ 目录存在
 * 2. 不含 .map 文件
 * 3. 不含硬编码 API Key 模式
 * 4. 不含外部项目引用（claude-code、openclaw、HackerOne）
 * 5. 不含 eval() 或 new Function() 调用
 * 6. 不含 .env 文件
 *
 * 用法：node scripts/audit-pack.js
 * 退出码：0 = 通过，1 = 失败
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const DIST_DIR = join(import.meta.dirname, "..", "dist");

let violations = 0;

function check(condition, message) {
  if (!condition) {
    console.error(`  ❌ ${message}`);
    violations++;
  } else {
    console.log(`  ✅ ${message}`);
  }
}

function getAllFiles(dir, ext = ".js") {
  const results = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllFiles(fullPath, ext));
    } else if (extname(entry.name) === ext) {
      results.push(fullPath);
    }
  }
  return results;
}

// ─── 1. dist/ 目录存在 ───

console.log("\n📋 D.2 发布内容审计\n");

check(existsSync(DIST_DIR), "dist/ 目录存在");

if (!existsSync(DIST_DIR)) {
  console.error("\n⛔ dist/ 目录不存在，请先运行 npm run build");
  process.exit(1);
}

// ─── 2. 不含 .map 文件 ───

const mapFiles = getAllFiles(DIST_DIR, ".map");
check(mapFiles.length === 0, `无 .map 文件（${mapFiles.length} 个）`);

// ─── 3. 不含硬编码 API Key ───

const jsFiles = getAllFiles(DIST_DIR, ".js");
const dtsFiles = getAllFiles(DIST_DIR, ".d.ts");
const allFiles = [...jsFiles, ...dtsFiles];

const SENSITIVE_PATTERNS = [
  { pattern: /sk-ant-api03-[a-zA-Z0-9]{20,}/, name: "Anthropic API Key" },
  { pattern: /sk-[a-zA-Z0-9]{40,}/, name: "OpenAI API Key" },
  { pattern: /AKIA[0-9A-Z]{16}/, name: "AWS Access Key" },
  { pattern: /ghp_[a-zA-Z0-9]{36,}/, name: "GitHub PAT" },
  { pattern: /xox[bpas]-[a-zA-Z0-9-]{30,}/, name: "Slack Token" },
];

let sensitiveFound = false;
for (const file of allFiles) {
  const content = readFileSync(file, "utf-8");
  for (const { pattern, name } of SENSITIVE_PATTERNS) {
    if (pattern.test(content)) {
      console.error(`  ❌ ${name} 在 ${file.replace(DIST_DIR + "/", "")}`);
      violations++;
      sensitiveFound = true;
    }
  }
}
if (!sensitiveFound) {
  check(true, "无硬编码 API Key");
}

// ─── 4. 不含外部项目引用 ───

const EXTERNAL_REFS = ["claude-code", "openclaw", "HackerOne"];
let externalFound = false;
for (const file of allFiles) {
  const content = readFileSync(file, "utf-8");
  for (const ref of EXTERNAL_REFS) {
    if (content.includes(ref)) {
      console.error(`  ❌ 外部引用 "${ref}" 在 ${file.replace(DIST_DIR + "/", "")}`);
      violations++;
      externalFound = true;
    }
  }
}
if (!externalFound) {
  check(true, "无外部项目引用");
}

// ─── 5. 不含 eval() 或 new Function() ───

const DANGEROUS_PATTERNS = [
  { pattern: /\beval\s*\(/, name: "eval() 调用" },
  { pattern: /new\s+Function\s*\(/, name: "new Function() 调用" },
];

let dangerousFound = false;
for (const file of allFiles) {
  const content = readFileSync(file, "utf-8");
  for (const { pattern, name } of DANGEROUS_PATTERNS) {
    if (pattern.test(content)) {
      // 排除已知合法用途：code-sandbox.js 中的 new Function() 是沙箱执行所需
      if (file.includes("code-sandbox") && name === "new Function() 调用") {
        continue;
      }
      console.error(`  ❌ ${name} 在 ${file.replace(DIST_DIR + "/", "")}`);
      violations++;
      dangerousFound = true;
    }
  }
}
if (!dangerousFound) {
  check(true, "无 eval() 或 new Function() 调用");
}

// ─── 6. 不含 .env 文件 ───

const envFiles = allFiles.filter((f) => f.endsWith(".env"));
check(envFiles.length === 0, `无 .env 文件（${envFiles.length} 个）`);

// ─── 7. 文件大小检查 ───

let oversizedFiles = 0;
for (const file of allFiles) {
  const size = statSync(file).size;
  if (size > 500_000) {
    console.error(`  ❌ 文件过大: ${file.replace(DIST_DIR + "/", "")} (${Math.round(size / 1024)}KB)`);
    violations++;
    oversizedFiles++;
  }
}
if (oversizedFiles === 0) {
  check(true, "所有文件 < 500KB");
}

// ─── 8. src/ 与 dist/ 导出一致性 ───

const SRC_DIR = join(import.meta.dirname, "..", "src");

function getRelativePaths(dir, ext) {
  if (!existsSync(dir)) return [];
  return getAllFiles(dir, ext).map((f) => f.replace(dir + "/", "").replace(dir + "\\", ""));
}

const srcTsFiles = getRelativePaths(SRC_DIR, ".ts");
const distJsFiles = getRelativePaths(DIST_DIR, ".js");
const distDtsFiles = getRelativePaths(DIST_DIR, ".d.ts");

const srcBaseNames = new Set(srcTsFiles.map((f) => f.replace(/\.ts$/, "")));
const distJsBaseNames = new Set(distJsFiles.map((f) => f.replace(/\.js$/, "")));
const distDtsBaseNames = new Set(distDtsFiles.map((f) => f.replace(/\.d\.ts$/, "")));

const missingJs = [...srcBaseNames].filter((name) => !distJsBaseNames.has(name) && !name.includes(".test.") && !name.includes(".spec."));
const missingDts = [...srcBaseNames].filter((name) => !distDtsBaseNames.has(name) && !name.includes(".test.") && !name.includes(".spec."));

if (missingJs.length === 0) {
  check(true, "src/ 与 dist/ .js 文件一一对应");
} else {
  for (const name of missingJs.slice(0, 10)) {
    console.error(`  ❌ src/${name}.ts 无对应 dist/${name}.js`);
    violations++;
  }
  if (missingJs.length > 10) {
    console.error(`  ❌ ... 还有 ${missingJs.length - 10} 个文件缺失`);
    violations++;
  }
}

if (missingDts.length === 0) {
  check(true, "src/ 与 dist/ .d.ts 文件一一对应");
} else {
  for (const name of missingDts.slice(0, 10)) {
    console.error(`  ❌ src/${name}.ts 无对应 dist/${name}.d.ts`);
    violations++;
  }
  if (missingDts.length > 10) {
    console.error(`  ❌ ... 还有 ${missingDts.length - 10} 个类型声明缺失`);
    violations++;
  }
}

// ─── 结果 ───

console.log("");
if (violations > 0) {
  console.error(`⛔ 审计失败：${violations} 个违规项`);
  process.exit(1);
} else {
  console.log("✅ 审计通过：dist/ 目录安全可发布");
  process.exit(0);
}
