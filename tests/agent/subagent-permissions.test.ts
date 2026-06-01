/**
 * Session C.1 测试 — Subagent 工具权限最小化。
 *
 * 验证角色工具映射、自动分配、权限审计。
 */

import { describe, expect, it } from "vitest";
import {
  filterToolsForAgent,
  getRoleToolWhitelist,
  ROLE_TOOL_MAP,
  ROLE_DESCRIPTIONS,
  ToolUseAuditor,
  type AgentRole,
  type ToolUseAuditEntry,
} from "../../src/core/agent/tool-filter";
import type { Tool } from "../../src/interfaces/tool";

// ─── Mock Tools ───

function createMockTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    execute: async () => ({ output: "", error: undefined }),
  };
}

const ALL_TOOLS: Tool[] = [
  createMockTool("file_read"),
  createMockTool("file_write"),
  createMockTool("file_edit"),
  createMockTool("bash"),
  createMockTool("glob"),
    createMockTool("agent"),
  createMockTool("config_set"),
];

// ─── 测试 ───

describe("ROLE_TOOL_MAP", () => {
  it("reviewer 只有只读工具", () => {
    expect(ROLE_TOOL_MAP["reviewer"]).toEqual(["file_read", "glob"]);
  });

  it("debugger 包含 bash", () => {
    expect(ROLE_TOOL_MAP["debugger"]).toContain("bash");
    expect(ROLE_TOOL_MAP["debugger"]).not.toContain("file_write");
  });

  it("refactorer 包含 file_write 和 file_edit", () => {
    expect(ROLE_TOOL_MAP["refactorer"]).toContain("file_write");
    expect(ROLE_TOOL_MAP["refactorer"]).toContain("file_edit");
    expect(ROLE_TOOL_MAP["refactorer"]).toContain("bash");
  });

  it("tester 包含 bash 但不包含 file_write", () => {
    expect(ROLE_TOOL_MAP["tester"]).toContain("bash");
    expect(ROLE_TOOL_MAP["tester"]).not.toContain("file_write");
  });

  it("full 为空数组（不过滤）", () => {
    expect(ROLE_TOOL_MAP["full"]).toEqual([]);
  });
});

describe("getRoleToolWhitelist", () => {
  it("reviewer 返回 2 个工具的 Set", () => {
    const whitelist = getRoleToolWhitelist("reviewer");
    expect(whitelist).toBeDefined();
    expect(whitelist!.size).toBe(2);
    expect(whitelist!.has("file_read")).toBe(true);
    expect(whitelist!.has("file_write")).toBe(false);
  });

  it("full 返回 undefined（不过滤）", () => {
    const whitelist = getRoleToolWhitelist("full");
    expect(whitelist).toBeUndefined();
  });
});

describe("ROLE_DESCRIPTIONS", () => {
  const roles: AgentRole[] = ["reviewer", "debugger", "refactorer", "tester", "full"];
  for (const role of roles) {
    it(`${role} 有描述`, () => {
      expect(ROLE_DESCRIPTIONS[role]).toBeDefined();
      expect(typeof ROLE_DESCRIPTIONS[role]).toBe("string");
      expect(ROLE_DESCRIPTIONS[role]!.length).toBeGreaterThan(0);
    });
  }
});

describe("基于角色的工具过滤", () => {
  it("reviewer 角色只保留只读工具", () => {
    const result = filterToolsForAgent(ALL_TOOLS, { role: "reviewer" });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("file_read");
    expect(names).toContain("glob");
        expect(names).not.toContain("file_write");
    expect(names).not.toContain("file_edit");
    expect(names).not.toContain("bash");
  });

  it("debugger 角色保留 bash 但不保留 write", () => {
    const result = filterToolsForAgent(ALL_TOOLS, { role: "debugger" });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("bash");
    expect(names).toContain("file_read");
    expect(names).not.toContain("file_write");
    expect(names).not.toContain("file_edit");
  });

  it("refactorer 角色保留 file_write 和 file_edit", () => {
    const result = filterToolsForAgent(ALL_TOOLS, { role: "refactorer" });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("file_write");
    expect(names).toContain("file_edit");
    expect(names).toContain("bash");
  });

  it("tester 角色保留 bash 但不保留 file_write", () => {
    const result = filterToolsForAgent(ALL_TOOLS, { role: "tester" });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("bash");
    expect(names).not.toContain("file_write");
    expect(names).not.toContain("file_edit");
  });

  it("full 角色保留所有非禁止工具", () => {
    const result = filterToolsForAgent(ALL_TOOLS, { role: "full" });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("file_read");
    expect(names).toContain("file_write");
    expect(names).toContain("bash");
    // 全局禁止的工具仍然被过滤
    expect(names).not.toContain("agent");
  });

  it("无角色时默认为 full（不过滤）", () => {
    const result = filterToolsForAgent(ALL_TOOLS);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("file_read");
    expect(names).toContain("file_write");
    expect(names).toContain("bash");
  });

  it("角色白名单与显式 whitelist 共存时显式优先", () => {
    const result = filterToolsForAgent(ALL_TOOLS, {
      role: "reviewer",
      whitelist: new Set(["bash"]),
    });
    const names = result.tools.map((t) => t.name);
    // 显式 whitelist 覆盖角色白名单
    expect(names).toContain("bash");
    expect(names).not.toContain("file_read");
  });

  it("角色 + isAsync 组合", () => {
    const result = filterToolsForAgent(ALL_TOOLS, {
      role: "full",
      isAsync: true,
    });
    const names = result.tools.map((t) => t.name);
    // full 角色不过滤，但 isAsync 启用白名单模式
    expect(names).toContain("bash");
    expect(names).toContain("file_read");
    expect(names).not.toContain("agent");
  });

  it("角色 + planMode 组合", () => {
    const result = filterToolsForAgent(ALL_TOOLS, {
      role: "refactorer",
      planMode: true,
    });
    const names = result.tools.map((t) => t.name);
    // planMode 优先级高于角色白名单
    expect(names).toContain("file_read");
    expect(names).not.toContain("file_write");
    expect(names).not.toContain("bash");
  });
});

describe("ToolUseAuditor", () => {
  it("记录工具使用", () => {
    const auditor = new ToolUseAuditor();
    auditor.record({
      agentId: "agent-1",
      toolName: "file_read",
      timestamp: Date.now(),
      allowed: true,
      role: "reviewer",
    });
    expect(auditor.getEntries()).toHaveLength(1);
  });

  it("按 agent 过滤", () => {
    const auditor = new ToolUseAuditor();
    auditor.record({ agentId: "agent-1", toolName: "file_read", timestamp: 1, allowed: true });
    auditor.record({ agentId: "agent-2", toolName: "bash", timestamp: 2, allowed: true });
    auditor.record({ agentId: "agent-1", toolName: "glob", timestamp: 3, allowed: true });

    const agent1Entries = auditor.getByAgent("agent-1");
    expect(agent1Entries).toHaveLength(2);
  });

  it("统计被拒绝的次数", () => {
    const auditor = new ToolUseAuditor();
    auditor.record({ agentId: "agent-1", toolName: "file_read", timestamp: 1, allowed: true });
    auditor.record({ agentId: "agent-1", toolName: "file_write", timestamp: 2, allowed: false });
    auditor.record({ agentId: "agent-1", toolName: "bash", timestamp: 3, allowed: false });

    expect(auditor.getDeniedCount()).toBe(2);
  });

  it("超过 maxSize 时自动淘汰旧记录", () => {
    const auditor = new ToolUseAuditor(3);
    auditor.record({ agentId: "agent-1", toolName: "a", timestamp: 1, allowed: true });
    auditor.record({ agentId: "agent-1", toolName: "b", timestamp: 2, allowed: true });
    auditor.record({ agentId: "agent-1", toolName: "c", timestamp: 3, allowed: true });
    auditor.record({ agentId: "agent-1", toolName: "d", timestamp: 4, allowed: true });

    expect(auditor.getEntries()).toHaveLength(3);
    expect(auditor.getEntries()[0]?.toolName).toBe("b");
  });

  it("clear 清空所有记录", () => {
    const auditor = new ToolUseAuditor();
    auditor.record({ agentId: "agent-1", toolName: "file_read", timestamp: 1, allowed: true });
    auditor.clear();
    expect(auditor.getEntries()).toHaveLength(0);
    expect(auditor.getDeniedCount()).toBe(0);
  });
});
