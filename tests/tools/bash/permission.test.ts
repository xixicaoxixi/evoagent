/**
 * Session 4.1 测试 — Bash 权限管线基础层。
 * 覆盖 AST 解析器、语义检查器、权限管线入口。
 */

import { describe, expect, it } from "vitest";
import {
  analyzeBashAstForSecurity,
  analyzeBashSemantics,
} from "../../../src/tools/bash/ast-parser";
import {
  checkSemanticsDetailed,
  getDangerousPatternCount,
  SemanticCheckCategory,
} from "../../../src/tools/bash/semantic-check";
import {
  checkBashPermission,
  createBashPermissionContext,
  PermissionRuleBehavior,
  type PermissionRule,
} from "../../../src/tools/bash/permission";
import type { ToolUseContext } from "../../../src/interfaces/tool";

// ─── AST 解析器测试 ───

describe("AST Parser", () => {
  describe("analyzeBashAstForSecurity", () => {
    it("空命令返回 simple 空", () => {
      const result = analyzeBashAstForSecurity("");
      expect(result.kind).toBe("simple");
      if (result.kind === "simple") {
        expect(result.commands).toHaveLength(0);
      }
    });

    it("纯空白命令返回 simple 空", () => {
      const result = analyzeBashAstForSecurity("   \t  ");
      expect(result.kind).toBe("simple");
    });

    it("简单命令解析为 simple", () => {
      const result = analyzeBashAstForSecurity("ls -la /tmp");
      expect(result.kind).toBe("simple");
      if (result.kind === "simple") {
        expect(result.commands).toHaveLength(1);
        expect(result.commands[0]?.text).toBe("ls -la /tmp");
        expect(result.commands[0]?.args).toEqual(["ls", "-la", "/tmp"]);
      }
    });

    it("带引号的命令正确解析", () => {
      const result = analyzeBashAstForSecurity('echo "hello world"');
      expect(result.kind).toBe("simple");
      if (result.kind === "simple") {
        expect(result.commands[0]?.args).toEqual(["echo", "hello world"]);
      }
    });

    it("带单引号的命令正确解析", () => {
      const result = analyzeBashAstForSecurity("echo 'hello world'");
      expect(result.kind).toBe("simple");
      if (result.kind === "simple") {
        expect(result.commands[0]?.args).toEqual(["echo", "hello world"]);
      }
    });

    it("管道命令解析为多个 simple 命令", () => {
      const result = analyzeBashAstForSecurity("cat file.txt | grep pattern");
      expect(result.kind).toBe("simple");
      if (result.kind === "simple") {
        expect(result.commands).toHaveLength(2);
        expect(result.commands[0]?.args[0]).toBe("cat");
        expect(result.commands[1]?.args[0]).toBe("grep");
      }
    });

    it("&& 逻辑操作符正确分割", () => {
      const result = analyzeBashAstForSecurity("npm install && npm test");
      expect(result.kind).toBe("simple");
      if (result.kind === "simple") {
        expect(result.commands).toHaveLength(2);
      }
    });

    it("|| 逻辑操作符正确分割", () => {
      const result = analyzeBashAstForSecurity("cmd1 || cmd2");
      expect(result.kind).toBe("simple");
      if (result.kind === "simple") {
        expect(result.commands).toHaveLength(2);
      }
    });

    it("; 分号正确分割", () => {
      const result = analyzeBashAstForSecurity("echo a; echo b");
      expect(result.kind).toBe("simple");
      if (result.kind === "simple") {
        expect(result.commands).toHaveLength(2);
      }
    });

    it("重定向正确提取", () => {
      const result = analyzeBashAstForSecurity("echo hello > /tmp/out.txt");
      expect(result.kind).toBe("simple");
      if (result.kind === "simple") {
        expect(result.commands[0]?.redirects).toEqual(["/tmp/out.txt"]);
      }
    });

    it("控制字符 → too-complex", () => {
      const result = analyzeBashAstForSecurity("ls\x00-la");
      expect(result.kind).toBe("too-complex");
      if (result.kind === "too-complex") {
        expect(result.reason).toContain("control characters");
      }
    });

    it("Unicode 空白 → too-complex", () => {
      const result = analyzeBashAstForSecurity("ls\u00a0-la");
      expect(result.kind).toBe("too-complex");
      if (result.kind === "too-complex") {
        expect(result.reason).toContain("Unicode whitespace");
      }
    });

    it("反斜杠转义空白 → too-complex", () => {
      const result = analyzeBashAstForSecurity("ls\\ -la");
      expect(result.kind).toBe("too-complex");
      if (result.kind === "too-complex") {
        expect(result.reason).toContain("backslash");
      }
    });

    it("命令替换 $(...) → too-complex", () => {
      const result = analyzeBashAstForSecurity("echo $(whoami)");
      expect(result.kind).toBe("too-complex");
      if (result.kind === "too-complex") {
        expect(result.reason).toContain("command substitution");
      }
    });

    it("反引号命令替换 → too-complex", () => {
      const result = analyzeBashAstForSecurity("echo `whoami`");
      expect(result.kind).toBe("too-complex");
    });

    it("进程替换 <(...) → too-complex", () => {
      const result = analyzeBashAstForSecurity("diff <(sort a) <(sort b)");
      expect(result.kind).toBe("too-complex");
      if (result.kind === "too-complex") {
        expect(result.reason).toContain("process substitution");
      }
    });

    it("here-string <<< → too-complex", () => {
      const result = analyzeBashAstForSecurity("cat <<< hello");
      expect(result.kind).toBe("too-complex");
      if (result.kind === "too-complex") {
        expect(result.reason).toContain("here-string");
      }
    });

    it("here-document << → too-complex", () => {
      const result = analyzeBashAstForSecurity("cat << EOF\nhello\nEOF");
      expect(result.kind).toBe("too-complex");
      if (result.kind === "too-complex") {
        expect(result.reason).toContain("here-document");
      }
    });

    it("算术展开 $(( → too-complex", () => {
      const result = analyzeBashAstForSecurity("echo $((1+1))");
      expect(result.kind).toBe("too-complex");
      if (result.kind === "too-complex") {
        expect(result.reason).toContain("arithmetic expansion");
      }
    });

    it("zsh ~[ 语法 → too-complex", () => {
      const result = analyzeBashAstForSecurity("cd ~[test]");
      expect(result.kind).toBe("too-complex");
      if (result.kind === "too-complex") {
        expect(result.reason).toContain("zsh");
      }
    });

    it("反斜杠转义空白被预检查拦截（too-complex）", () => {
      const result = analyzeBashAstForSecurity("echo hello\\ world");
      expect(result.kind).toBe("too-complex");
      if (result.kind === "too-complex") {
        expect(result.reason).toContain("backslash");
      }
    });

    it("注释被正确忽略", () => {
      const result = analyzeBashAstForSecurity("echo hello # this is a comment");
      expect(result.kind).toBe("simple");
      if (result.kind === "simple") {
        expect(result.commands[0]?.args).toEqual(["echo", "hello"]);
      }
    });
  });

  describe("analyzeBashSemantics", () => {
    it("安全命令返回 ok", () => {
      const result = analyzeBashAstForSecurity("ls -la /tmp");
      if (result.kind === "simple") {
        expect(analyzeBashSemantics(result.commands).ok).toBe(true);
      }
    });

    it("eval 命令返回错误", () => {
      const result = analyzeBashAstForSecurity("eval echo hello");
      if (result.kind === "simple") {
        expect(analyzeBashSemantics(result.commands).ok).toBe(false);
      }
    });

    it("bash -c 命令返回错误", () => {
      const result = analyzeBashAstForSecurity("bash -c 'echo hello'");
      if (result.kind === "simple") {
        expect(analyzeBashSemantics(result.commands).ok).toBe(false);
      }
    });

    it("source 命令返回错误", () => {
      const result = analyzeBashAstForSecurity("source ~/.bashrc");
      if (result.kind === "simple") {
        expect(analyzeBashSemantics(result.commands).ok).toBe(false);
      }
    });
  });
});

// ─── 语义检查器测试 ───

describe("Semantic Check", () => {
  it("安全命令通过检查", () => {
    const result = analyzeBashAstForSecurity("ls -la /tmp");
    if (result.kind === "simple") {
      const check = checkSemanticsDetailed(result.commands);
      expect(check.ok).toBe(true);
    }
  });

  it("eval 被检测为 dangerous_builtin", () => {
    const result = analyzeBashAstForSecurity("eval echo test");
    if (result.kind === "simple") {
      const check = checkSemanticsDetailed(result.commands);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.category).toBe(SemanticCheckCategory.DANGEROUS_BUILTIN);
      }
    }
  });

  it("exec 被检测为 dangerous_builtin", () => {
    const result = analyzeBashAstForSecurity("exec bash");
    if (result.kind === "simple") {
      const check = checkSemanticsDetailed(result.commands);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.category).toBe(SemanticCheckCategory.DANGEROUS_BUILTIN);
      }
    }
  });

  it("rm -rf / 被检测为 dangerous_file_op", () => {
    const result = analyzeBashAstForSecurity("rm -rf /");
    if (result.kind === "simple") {
      const check = checkSemanticsDetailed(result.commands);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.category).toBe(SemanticCheckCategory.DANGEROUS_FILE_OP);
      }
    }
  });

  it("chmod 777 / 被检测为 dangerous_file_op", () => {
    const result = analyzeBashAstForSecurity("chmod -R 777 /");
    if (result.kind === "simple") {
      const check = checkSemanticsDetailed(result.commands);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.category).toBe(SemanticCheckCategory.DANGEROUS_FILE_OP);
      }
    }
  });

  it("nc 监听被检测为 dangerous_network", () => {
    const result = analyzeBashAstForSecurity("nc -l 4444");
    if (result.kind === "simple") {
      const check = checkSemanticsDetailed(result.commands);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.category).toBe(SemanticCheckCategory.DANGEROUS_NETWORK);
      }
    }
  });

  it("sudo su 被检测为 privilege_escalation", () => {
    const result = analyzeBashAstForSecurity("sudo su -");
    if (result.kind === "simple") {
      const check = checkSemanticsDetailed(result.commands);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.category).toBe(SemanticCheckCategory.PRIVILEGE_ESCALATION);
      }
    }
  });

  it("base64 解码被检测为 obfuscation", () => {
    const result = analyzeBashAstForSecurity("base64 -d encoded.txt");
    if (result.kind === "simple") {
      const check = checkSemanticsDetailed(result.commands);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.category).toBe(SemanticCheckCategory.OBFUSCATION);
      }
    }
  });

  it("危险模式总数 >= 23", () => {
    expect(getDangerousPatternCount()).toBeGreaterThanOrEqual(23);
  });
});

// ─── 权限管线测试 ───

describe("Bash Permission Pipeline", () => {
  const baseContext: ToolUseContext = {
    cwd: "/workspace",
    env: {},
    getAppState: () => ({}),
  };

  it("无规则时默认 ask_user", async () => {
    const ctx = createBashPermissionContext();
    const result = await checkBashPermission("ls -la", baseContext, ctx);
    expect(result.behavior).toBe("ask_user");
  });

  it("allow 规则匹配", async () => {
    const rules: PermissionRule[] = [
      { pattern: "ls", behavior: PermissionRuleBehavior.ALLOW },
    ];
    const ctx = createBashPermissionContext({ rules });
    const result = await checkBashPermission("ls -la /tmp", baseContext, ctx);
    expect(result.behavior).toBe("allow");
  });

  it("deny 规则优先于 allow", async () => {
    const rules: PermissionRule[] = [
      { pattern: "rm", behavior: PermissionRuleBehavior.DENY, reason: "rm is dangerous" },
      { pattern: "rm", behavior: PermissionRuleBehavior.ALLOW },
    ];
    const ctx = createBashPermissionContext({ rules });
    const result = await checkBashPermission("rm file.txt", baseContext, ctx);
    expect(result.behavior).toBe("deny");
  });

  it("too-complex 命令默认 ask_user", async () => {
    const ctx = createBashPermissionContext();
    const result = await checkBashPermission(
      "echo $(whoami)",
      baseContext,
      ctx,
    );
    expect(result.behavior).toBe("ask_user");
  });

  it("too-complex 命令匹配 deny 规则时 deny", async () => {
    const rules: PermissionRule[] = [
      { pattern: "whoami", behavior: PermissionRuleBehavior.DENY, reason: "no whoami" },
    ];
    const ctx = createBashPermissionContext({ rules });
    const result = await checkBashPermission(
      "echo $(whoami)",
      baseContext,
      ctx,
    );
    expect(result.behavior).toBe("deny");
  });

  it("语义危险命令默认 ask_user", async () => {
    const ctx = createBashPermissionContext();
    const result = await checkBashPermission("eval echo test", baseContext, ctx);
    expect(result.behavior).toBe("ask_user");
  });

  it("语义危险命令匹配 deny 规则时 deny", async () => {
    const rules: PermissionRule[] = [
      { pattern: "eval", behavior: PermissionRuleBehavior.DENY, reason: "no eval" },
    ];
    const ctx = createBashPermissionContext({ rules });
    const result = await checkBashPermission("eval echo test", baseContext, ctx);
    expect(result.behavior).toBe("deny");
  });

  it("沙箱模式自动放行", async () => {
    const ctx = createBashPermissionContext({ sandboxed: true });
    const result = await checkBashPermission("npm install", baseContext, ctx);
    expect(result.behavior).toBe("allow");
  });

  it("只读模式允许白名单命令", async () => {
    const ctx = createBashPermissionContext({
      readOnlyMode: true,
      rules: [{ pattern: "ls", behavior: PermissionRuleBehavior.ALLOW }],
    });
    const result = await checkBashPermission("ls -la /tmp", baseContext, ctx);
    expect(result.behavior).toBe("allow");
  });

  it("只读模式拒绝非白名单命令", async () => {
    const ctx = createBashPermissionContext({
      readOnlyMode: true,
      rules: [{ pattern: "rm", behavior: PermissionRuleBehavior.ALLOW }],
    });
    const result = await checkBashPermission("rm file.txt", baseContext, ctx);
    expect(result.behavior).toBe("deny");
  });

  it("只读模式拒绝写重定向", async () => {
    const ctx = createBashPermissionContext({
      readOnlyMode: true,
      rules: [{ pattern: "echo", behavior: PermissionRuleBehavior.ALLOW }],
    });
    const result = await checkBashPermission(
      "echo hello > /tmp/out.txt",
      baseContext,
      ctx,
    );
    expect(result.behavior).toBe("deny");
  });

  it("路径约束检查（语义检查先触发）", async () => {
    const ctx = createBashPermissionContext({
      allowedDirectories: ["/workspace"],
      rules: [{ pattern: "echo", behavior: PermissionRuleBehavior.ALLOW }],
    });
    const result = await checkBashPermission(
      "echo test > /etc/passwd",
      baseContext,
      ctx,
    );
    // 语义检查（dangerous_redirect）在路径约束之前触发
    expect(result.behavior).toBe("ask_user");
  });

  it("路径约束允许范围内路径", async () => {
    const ctx = createBashPermissionContext({
      allowedDirectories: ["/workspace"],
      rules: [{ pattern: "echo", behavior: PermissionRuleBehavior.ALLOW }],
    });
    const result = await checkBashPermission(
      "echo test > /workspace/out.txt",
      baseContext,
      ctx,
    );
    expect(result.behavior).toBe("allow");
  });

  it("管道写重定向在路径约束外触发 deny", async () => {
    const ctx = createBashPermissionContext({
      allowedDirectories: ["/workspace"],
    });
    const result = await checkBashPermission(
      "cat file | grep pattern > /etc/out.txt",
      baseContext,
      ctx,
    );
    expect(result.behavior).toBe("deny");
  });

  it("sed -e 标志在无 allow 规则时触发 ask_user", async () => {
    const ctx = createBashPermissionContext();
    const result = await checkBashPermission(
      "sed -e 's/a/b/' file.txt",
      baseContext,
      ctx,
    );
    // 无规则匹配 → 默认 ask_user（第 10 层最终决策）
    expect(result.behavior).toBe("ask_user");
  });

  it("createBashPermissionContext 默认值正确", () => {
    const ctx = createBashPermissionContext();
    expect(ctx.rules).toEqual([]);
    expect(ctx.sandboxed).toBe(false);
    expect(ctx.readOnlyMode).toBe(false);
    expect(ctx.allowedDirectories).toEqual([]);
  });

  it("createBashPermissionContext 覆盖值正确", () => {
    const rules: PermissionRule[] = [
      { pattern: "ls", behavior: PermissionRuleBehavior.ALLOW },
    ];
    const ctx = createBashPermissionContext({
      rules,
      sandboxed: true,
      readOnlyMode: true,
      allowedDirectories: ["/tmp"],
    });
    expect(ctx.rules).toEqual(rules);
    expect(ctx.sandboxed).toBe(true);
    expect(ctx.readOnlyMode).toBe(true);
    expect(ctx.allowedDirectories).toEqual(["/tmp"]);
  });
});
