/**
 * Step 2 测试 — 退出码语义解释。
 *
 * 覆盖：
 * - extractCommandName 命令名提取
 * - interpretExitCode 各命令退出码语义
 * - 通用退出码语义
 * - 未知命令/退出码回退
 * - isSemanticError 判定
 * - BashOutput 语义标注集成
 */

import { describe, expect, it } from "vitest";
import {
  interpretExitCode,
  extractCommandName,
  isSemanticError,
  type ExitCodeInterpretation,
} from "../../../src/tools/bash/exit-code-semantics";

// ═══════════════════════════════════════════
// extractCommandName
// ═══════════════════════════════════════════

describe("extractCommandName", () => {
  it("简单命令应提取命令名", () => {
    expect(extractCommandName("grep pattern file")).toBe("grep");
  });

  it("带路径的命令应提取 basename", () => {
    expect(extractCommandName("/usr/bin/grep pattern file")).toBe("grep");
  });

  it("带标志的命令应提取第一个 token", () => {
    expect(extractCommandName("grep -r pattern /path")).toBe("grep");
  });

  it("sudo 前缀应被跳过", () => {
    expect(extractCommandName("sudo grep pattern file")).toBe("grep");
  });

  it("多层前缀应被跳过", () => {
    expect(extractCommandName("sudo nice grep pattern file")).toBe("grep");
  });

  it("time 前缀应被跳过", () => {
    expect(extractCommandName("time npm test")).toBe("npm");
  });

  it("env 前缀应被跳过", () => {
    expect(extractCommandName("env NODE_ENV=prod node server.js")).toBe("node");
  });

  it("空命令应返回空字符串", () => {
    expect(extractCommandName("")).toBe("");
  });

  it("以 - 开头的命令应返回空字符串", () => {
    expect(extractCommandName("-la")).toBe("");
  });

  it("test 命令的 [ 别名应被识别", () => {
    expect(extractCommandName("[ -f file.txt ]")).toBe("[");
  });
});

// ═══════════════════════════════════════════
// interpretExitCode — grep 系列
// ═══════════════════════════════════════════

describe("interpretExitCode — grep", () => {
  it("grep=1 应标注为 no_match（非错误）", () => {
    const result = interpretExitCode("grep pattern file", 1);
    expect(result.code).toBe("no_match");
    expect(result.isError).toBe(false);
    expect(result.description).toContain("grep");
  });

  it("grep=2 应标注为 error（真正的错误）", () => {
    const result = interpretExitCode("grep pattern file", 2);
    expect(result.code).toBe("misuse");
    expect(result.isError).toBe(true);
  });

  it("grep=0 应为成功", () => {
    const result = interpretExitCode("grep pattern file", 0);
    expect(result.isError).toBe(false);
  });

  it("rg=1 应标注为 no_match", () => {
    const result = interpretExitCode("rg pattern /src", 1);
    expect(result.code).toBe("no_match");
    expect(result.isError).toBe(false);
  });
});

// ═══════════════════════════════════════════
// interpretExitCode — diff 系列
// ═══════════════════════════════════════════

describe("interpretExitCode — diff", () => {
  it("diff=1 应标注为 has_diff（非错误）", () => {
    const result = interpretExitCode("diff file1.txt file2.txt", 1);
    expect(result.code).toBe("has_diff");
    expect(result.isError).toBe(false);
    expect(result.description).toContain("differ");
  });

  it("diff=2 应标注为 misuse", () => {
    const result = interpretExitCode("diff file1.txt file2.txt", 2);
    expect(result.code).toBe("misuse");
    expect(result.isError).toBe(true);
  });
});

// ═══════════════════════════════════════════
// interpretExitCode — test 系列
// ═══════════════════════════════════════════

describe("interpretExitCode — test", () => {
  it("test=1 应标注为 test_fail（非错误）", () => {
    const result = interpretExitCode("test -f nonexistent.txt", 1);
    expect(result.code).toBe("test_fail");
    expect(result.isError).toBe(false);
  });

  it("[=1 应标注为 test_fail", () => {
    const result = interpretExitCode("[ -f nonexistent.txt ]", 1);
    expect(result.code).toBe("test_fail");
    expect(result.isError).toBe(false);
  });
});

// ═══════════════════════════════════════════
// interpretExitCode — which/type 系列
// ═══════════════════════════════════════════

describe("interpretExitCode — which/type", () => {
  it("which=1 应标注为 not_found（非错误）", () => {
    const result = interpretExitCode("which python3", 1);
    expect(result.code).toBe("not_found");
    expect(result.isError).toBe(false);
  });

  it("type=1 应标注为 not_found", () => {
    const result = interpretExitCode("type nonexistent_cmd", 1);
    expect(result.code).toBe("not_found");
    expect(result.isError).toBe(false);
  });
});

// ═══════════════════════════════════════════
// interpretExitCode — find/fd 系列
// ═══════════════════════════════════════════

describe("interpretExitCode — find/fd", () => {
  it("find=1 应标注为 no_match", () => {
    const result = interpretExitCode("find /path -name '*.xyz'", 1);
    expect(result.code).toBe("no_match");
    expect(result.isError).toBe(false);
  });

  it("fd=1 应标注为 no_match", () => {
    const result = interpretExitCode("fd pattern /path", 1);
    expect(result.code).toBe("no_match");
    expect(result.isError).toBe(false);
  });
});

// ═══════════════════════════════════════════
// interpretExitCode — 通用退出码
// ═══════════════════════════════════════════

describe("interpretExitCode — 通用退出码", () => {
  it("exit=2 应标注为 misuse（适用于所有命令）", () => {
    const result = interpretExitCode("ls --invalid-flag", 2);
    expect(result.code).toBe("misuse");
    expect(result.isError).toBe(true);
  });

  it("exit=126 应标注为 misuse（不可执行）", () => {
    const result = interpretExitCode("./script.sh", 126);
    expect(result.code).toBe("misuse");
    expect(result.isError).toBe(true);
    expect(result.description).toContain("not executable");
  });

  it("exit=127 应标注为 not_found（命令未找到）", () => {
    const result = interpretExitCode("nonexistent_command", 127);
    expect(result.code).toBe("not_found");
    expect(result.isError).toBe(true);
    expect(result.description).toContain("not found");
  });

  it("exit=130 应标注为 interrupted（SIGINT）", () => {
    const result = interpretExitCode("long_running_process", 130);
    expect(result.code).toBe("interrupted");
    expect(result.isError).toBe(false);
    expect(result.description).toContain("SIGINT");
  });
});

// ═══════════════════════════════════════════
// interpretExitCode — 未知命令/退出码
// ═══════════════════════════════════════════

describe("interpretExitCode — 未知命令/退出码", () => {
  it("未知命令的非零退出码应标注为 error", () => {
    const result = interpretExitCode("custom_tool --flag", 1);
    expect(result.code).toBe("error");
    expect(result.isError).toBe(true);
  });

  it("未知退出码应标注为 error", () => {
    const result = interpretExitCode("grep pattern file", 42);
    expect(result.code).toBe("error");
    expect(result.isError).toBe(true);
  });

  it("负退出码应标注为 error（工具级错误）", () => {
    const result = interpretExitCode("any_command", -1);
    expect(result.code).toBe("error");
    expect(result.isError).toBe(true);
    expect(result.description).toContain("tool-level");
  });

  it("exit=0 应为成功", () => {
    const result = interpretExitCode("any_command", 0);
    expect(result.isError).toBe(false);
  });
});

// ═══════════════════════════════════════════
// interpretExitCode — 命令级语义优先于通用语义
// ═══════════════════════════════════════════

describe("interpretExitCode — 优先级", () => {
  it("grep=1 应使用命令级语义（no_match）而非通用语义", () => {
    const result = interpretExitCode("grep pattern file", 1);
    expect(result.code).toBe("no_match");
    expect(result.isError).toBe(false);
  });

  it("grep=2 应使用通用语义（misuse）", () => {
    const result = interpretExitCode("grep pattern file", 2);
    expect(result.code).toBe("misuse");
    expect(result.isError).toBe(true);
  });
});

// ═══════════════════════════════════════════
// isSemanticError
// ═══════════════════════════════════════════

describe("isSemanticError", () => {
  it("no_match 不是错误", () => {
    const result = interpretExitCode("grep pattern file", 1);
    expect(isSemanticError(result)).toBe(false);
  });

  it("has_diff 不是错误", () => {
    const result = interpretExitCode("diff a b", 1);
    expect(isSemanticError(result)).toBe(false);
  });

  it("test_fail 不是错误", () => {
    const result = interpretExitCode("test -f x", 1);
    expect(isSemanticError(result)).toBe(false);
  });

  it("not_found（which）不是错误", () => {
    const result = interpretExitCode("which cmd", 1);
    expect(isSemanticError(result)).toBe(false);
  });

  it("interrupted 不是错误", () => {
    const result = interpretExitCode("cmd", 130);
    expect(isSemanticError(result)).toBe(false);
  });

  it("misuse 是错误", () => {
    const result = interpretExitCode("cmd", 2);
    expect(isSemanticError(result)).toBe(true);
  });

  it("error 是错误", () => {
    const result = interpretExitCode("unknown_cmd", 1);
    expect(isSemanticError(result)).toBe(true);
  });

  it("not_found（127）是错误", () => {
    const result = interpretExitCode("cmd", 127);
    expect(isSemanticError(result)).toBe(true);
  });
});

// ═══════════════════════════════════════════
// BashOutput 语义标注集成
// ═══════════════════════════════════════════

describe("BashOutput 语义标注集成", () => {
  it("grep=1 的 BashOutput 应包含 semanticExitCode 和 semanticDescription", () => {
    const semantics = interpretExitCode("grep pattern file", 1);
    const output = {
      stdout: "",
      stderr: "",
      exitCode: 1,
      timedOut: false,
      semanticExitCode: semantics.code,
      semanticDescription: semantics.description,
    };

    expect(output.semanticExitCode).toBe("no_match");
    expect(output.semanticDescription).toContain("grep");
    expect(semantics.isError).toBe(false);
  });

  it("exit=0 的 BashOutput 不需要语义标注", () => {
    const semantics = interpretExitCode("ls -la", 0);
    expect(semantics.code).toBe("error");
    expect(semantics.description).toBe("");
    expect(semantics.isError).toBe(false);
  });

  it("exit=-1 的 BashOutput 应标注为工具级错误", () => {
    const semantics = interpretExitCode("any_command", -1);
    expect(semantics.code).toBe("error");
    expect(semantics.isError).toBe(true);
  });
});
