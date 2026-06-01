/**
 * S.4.1 安全修复测试 — 危险配置检测 + HTTPS 警告（SEC-06 + SEC-11）。
 *
 * 覆盖范围：
 * - 危险工具黑名单
 * - 危险配置标志检测
 * - 安全审计
 * - 生产环境 HTTPS 警告
 * - API Key 缺失警告
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  DANGEROUS_TOOLS,
  isDangerousTool,
  collectEnabledInsecureOrDangerousFlags,
  getDangerousFlagDescriptions,
  securityAudit,
} from "../../src/security/dangerous-flags";

// ─── DANGEROUS_TOOLS ───

describe("S.4.1 > SEC-11 > DANGEROUS_TOOLS", () => {
  it("包含 exec", () => {
    expect(DANGEROUS_TOOLS).toContain("exec");
  });

  it("包含 shell", () => {
    expect(DANGEROUS_TOOLS).toContain("shell");
  });

  it("包含 fs_write 和 fs_delete", () => {
    expect(DANGEROUS_TOOLS).toContain("fs_write");
    expect(DANGEROUS_TOOLS).toContain("fs_delete");
  });

  it("包含 spawn", () => {
    expect(DANGEROUS_TOOLS).toContain("spawn");
  });

  it("包含 gateway", () => {
    expect(DANGEROUS_TOOLS).toContain("gateway");
  });

  it("至少包含 14 个危险工具", () => {
    expect(DANGEROUS_TOOLS.length).toBeGreaterThanOrEqual(14);
  });
});

// ─── isDangerousTool ───

describe("S.4.1 > SEC-11 > isDangerousTool", () => {
  it("识别危险工具", () => {
    expect(isDangerousTool("exec")).toBe(true);
    expect(isDangerousTool("shell")).toBe(true);
    expect(isDangerousTool("fs_write")).toBe(true);
    expect(isDangerousTool("fs_delete")).toBe(true);
  });

  it("非危险工具返回 false", () => {
    expect(isDangerousTool("file_read")).toBe(false);
    expect(isDangerousTool("web_search")).toBe(false);
    expect(isDangerousTool("list_files")).toBe(false);
  });
});

// ─── collectEnabledInsecureOrDangerousFlags ───

describe("S.4.1 > SEC-11 > collectEnabledInsecureOrDangerousFlags", () => {
  it("空配置返回空列表", () => {
    expect(collectEnabledInsecureOrDangerousFlags({})).toEqual([]);
  });

  it("检测 server.authDisabled", () => {
    const flags = collectEnabledInsecureOrDangerousFlags({ server_auth_disabled: true });
    expect(flags).toContain("server.authDisabled");
  });

  it("检测 server.allowInsecureAuth", () => {
    const flags = collectEnabledInsecureOrDangerousFlags({ server_allow_insecure_auth: true });
    expect(flags).toContain("server.allowInsecureAuth");
  });

  it("检测 evolution.sandboxDisabled", () => {
    const flags = collectEnabledInsecureOrDangerousFlags({
      evolution: { sandbox_enabled: false },
    });
    expect(flags).toContain("evolution.sandboxDisabled");
  });

  it("检测 communication.allowUnsafeContent", () => {
    const flags = collectEnabledInsecureOrDangerousFlags({
      communication: { allow_unsafe_content: true },
    });
    expect(flags).toContain("communication.allowUnsafeContent");
  });

  it("检测 tools.exec.workspaceOnlyDisabled", () => {
    const flags = collectEnabledInsecureOrDangerousFlags({
      tools_exec_workspace_only: false,
    });
    expect(flags).toContain("tools.exec.workspaceOnlyDisabled");
  });

  it("检测 security.disableUnicodeSanitization", () => {
    const flags = collectEnabledInsecureOrDangerousFlags({
      security_disable_unicode_sanitization: true,
    });
    expect(flags).toContain("security.disableUnicodeSanitization");
  });

  it("安全配置不触发检测", () => {
    const flags = collectEnabledInsecureOrDangerousFlags({
      server_auth_disabled: false,
      evolution: { sandbox_enabled: true },
    });
    expect(flags).toEqual([]);
  });

  it("多个危险标志同时检测", () => {
    const flags = collectEnabledInsecureOrDangerousFlags({
      server_auth_disabled: true,
      security_disable_unicode_sanitization: true,
      communication: { allow_unsafe_content: true },
    });
    expect(flags.length).toBe(3);
  });
});

// ─── getDangerousFlagDescriptions ───

describe("S.4.1 > SEC-11 > getDangerousFlagDescriptions", () => {
  it("返回非空数组", () => {
    const descs = getDangerousFlagDescriptions();
    expect(descs.length).toBeGreaterThan(0);
  });

  it("每个描述包含 path 和 description", () => {
    const descs = getDangerousFlagDescriptions();
    for (const desc of descs) {
      expect(typeof desc.path).toBe("string");
      expect(typeof desc.description).toBe("string");
      expect(desc.path.length).toBeGreaterThan(0);
      expect(desc.description.length).toBeGreaterThan(0);
    }
  });
});

// ─── securityAudit ───

describe("S.4.1 > SEC-06 + SEC-11 > securityAudit", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalApiKeys = process.env.EVOAGENT_API_KEYS;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    if (originalApiKeys !== undefined) {
      process.env.EVOAGENT_API_KEYS = originalApiKeys;
    } else {
      delete process.env.EVOAGENT_API_KEYS;
    }
  });

  it("安全配置返回 secure: true", () => {
    process.env.NODE_ENV = "development";
    const result = securityAudit({});
    expect(result.secure).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.dangerousFlags).toEqual([]);
  });

  it("危险配置返回 secure: false", () => {
    process.env.NODE_ENV = "development";
    const result = securityAudit({ server_auth_disabled: true });
    expect(result.secure).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.dangerousFlags).toContain("server.authDisabled");
  });

  it("生产环境缺少 HTTPS 时警告", () => {
    process.env.NODE_ENV = "production";
    process.env.EVOAGENT_API_KEYS = "evo_test_key";
    const result = securityAudit({ server: { protocol: "http" } });
    expect(result.secure).toBe(false);
    expect(result.warnings.some((w) => w.includes("HTTPS"))).toBe(true);
  });

  it("生产环境缺少 API Keys 时警告", () => {
    process.env.NODE_ENV = "production";
    delete process.env.EVOAGENT_API_KEYS;
    const result = securityAudit({});
    expect(result.secure).toBe(false);
    expect(result.warnings.some((w) => w.includes("EVOAGENT_API_KEYS"))).toBe(true);
  });

  it("生产环境 HTTPS + API Keys 配置正确时安全", () => {
    process.env.NODE_ENV = "production";
    process.env.EVOAGENT_API_KEYS = "evo_test_key";
    const result = securityAudit({ server: { protocol: "https" } });
    expect(result.secure).toBe(true);
  });

  it("包含时间戳", () => {
    const result = securityAudit({});
    expect(typeof result.timestamp).toBe("number");
    expect(result.timestamp).toBeGreaterThan(0);
  });
});
