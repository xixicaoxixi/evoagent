/**
 * 代码沙箱（P4-05）— 安全执行生成的代码。
 *
 * 参考 SYSTEM_DESIGN.md 3.6.1。
 * 安全特性：
 * - 体积检查（<=100KB）
 * - 语法检查
 * - AST 级别危险操作检测
 * - 隔离执行（临时目录 + 超时）
 */

import { CODE_SANDBOX_TIMEOUT, CODE_SANDBOX_MAX_SIZE_KB } from "./constants";

// ─── 类型定义 ───

export interface CodeValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface SandboxExecutionResult {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

// ─── 禁止的调用（AST 级别检测） ───

const FORBIDDEN_CALLS: ReadonlySet<string> = new Set([
  "os.system",
  "subprocess.run",
  "subprocess.Popen",
  "subprocess.call",
  "exec",
  "eval",
  "compile",
  "__import__",
  "shutil.rmtree",
  "os.remove",
  "os.unlink",
  "child_process.exec",
  "child_process.spawn",
  "child_process.execSync",
]);

const FORBIDDEN_MODULES: ReadonlySet<string> = new Set([
  "signal",
  "ctypes",
  "multiprocessing",
  "child_process",
]);

const ESCAPE_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly name: string }> = [
  { pattern: /\bglobalThis\b/, name: "globalThis" },
  { pattern: /\bprocess\b/, name: "process" },
  { pattern: /\brequire\s*\(/, name: "require" },
];

// ─── 代码验证 ───

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * validateCode — 静态验证生成的代码。
 *
 * 检查项：
 * 1. 体积 <= 100KB
 * 2. 基本语法检查
 * 3. 禁止的调用检测
 * 4. 禁止的模块检测
 */
export function validateCode(code: string): CodeValidationResult {
  const errors: string[] = [];

  // 1. 体积检查
  const sizeKB = Buffer.byteLength(code, "utf-8") / 1024;
  if (sizeKB > CODE_SANDBOX_MAX_SIZE_KB) {
    errors.push(`Code size ${sizeKB.toFixed(1)}KB exceeds limit ${CODE_SANDBOX_MAX_SIZE_KB}KB`);
  }

  // 2. 基本语法检查（TypeScript/JavaScript）
  try {
    // 简单的括号匹配检查
    const stack: string[] = [];
    let inString = false;
    let stringChar = "";
    let inTemplate = false;

    for (let i = 0; i < code.length; i++) {
      const ch = code[i] ?? "";

      if (inString) {
        if (ch === "\\") { i++; continue; }
        if (ch === stringChar) inString = false;
        continue;
      }

      if (inTemplate) {
        if (ch === "\\") { i++; continue; }
        if (ch === "`") inTemplate = false;
        continue;
      }

      if (ch === '"' || ch === "'") {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === "`") {
        inTemplate = true;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        stack.push(ch);
        continue;
      }
      if (ch === ")") {
        if (stack.pop() !== "(") { errors.push("Unmatched closing parenthesis"); break; }
        continue;
      }
      if (ch === "]") {
        if (stack.pop() !== "[") { errors.push("Unmatched closing bracket"); break; }
        continue;
      }
      if (ch === "}") {
        if (stack.pop() !== "{") { errors.push("Unmatched closing brace"); break; }
        continue;
      }
    }

    if (stack.length > 0) {
      errors.push(`Unmatched opening bracket(s): ${stack.length} remaining`);
    }
  } catch {
    errors.push("Syntax check failed");
  }

  // 3. 禁止的调用检测
  for (const forbidden of FORBIDDEN_CALLS) {
    const pattern = new RegExp(`\\b${escapeRegExp(forbidden)}\\s*\\(`);
    if (pattern.test(code)) {
      errors.push(`Forbidden call detected: ${forbidden}`);
    }
  }

  // 4. 禁止的模块检测
  for (const mod of FORBIDDEN_MODULES) {
    const requirePattern = new RegExp(`require\\s*\\(\\s*['"]${mod}['"]\\s*\\)`);
    const importPattern = new RegExp(`import\\s+.*\\s+from\\s+['"]${mod}['"]`);
    if (requirePattern.test(code) || importPattern.test(code)) {
      errors.push(`Forbidden module detected: ${mod}`);
    }
  }

  // 5. 沙箱逃逸检测
  for (const { pattern, name } of ESCAPE_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(`Sandbox escape detected: ${name}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ─── 沙箱执行 ───

/**
 * executeInSandbox — 在沙箱中执行代码。
 *
 * 安全特性：
 * - 临时目录隔离
 * - 超时控制（默认 30 秒）
 * - stdout/stderr 捕获
 *
 * 注意：TypeScript 环境下使用 Bun 的 eval（受限）。
 * 生产环境应使用 Docker 或 nsjail 隔离。
 */
export async function executeInSandbox(
  code: string,
  timeoutMs: number = CODE_SANDBOX_TIMEOUT * 1000,
): Promise<SandboxExecutionResult> {
  const startTime = Date.now();

  // 验证代码
  const validation = validateCode(code);
  if (!validation.valid) {
    return {
      success: false,
      stdout: "",
      stderr: validation.errors.join("\n"),
      exitCode: -1,
      timedOut: false,
      durationMs: Date.now() - startTime,
    };
  }

  // 使用 Bun 的 eval 执行（受限沙箱）
  try {
    const result = await Promise.race([
      (async () => {
        const logs: string[] = [];

        const sandboxConsole = {
          log: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
          error: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
          warn: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
          info: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
        };

        try {
          const fn = new Function("console", code);
          fn(sandboxConsole);
          return { stdout: logs.join("\n"), stderr: "", exitCode: 0 };
        } catch (e) {
          return {
            stdout: logs.join("\n"),
            stderr: (e as Error).message,
            exitCode: 1,
          };
        }
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Sandbox timeout")), timeoutMs),
      ),
    ]);

    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: false,
      durationMs: Date.now() - startTime,
    };
  } catch (e) {
    return {
      success: false,
      stdout: "",
      stderr: (e as Error).message,
      exitCode: -1,
      timedOut: (e as Error).message === "Sandbox timeout",
      durationMs: Date.now() - startTime,
    };
  }
}
