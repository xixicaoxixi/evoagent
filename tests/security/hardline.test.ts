/**
 * Step 1 测试 — Hardline 无条件阻止层。
 *
 * 覆盖：
 * - HARDLINE_PATTERNS 常量完整性
 * - checkHardline 各模式匹配
 * - 正常命令不被误拦截
 * - 嵌套输入中的字符串提取
 * - 额外模式追加
 * - 权限链集成（Phase 0）
 * - YOLO/Override 模式不可绕过
 * - isOverrideProof 包含 hardlineBlock
 */

import { describe, expect, it } from "vitest";
import {
  HARDLINE_PATTERNS,
  checkHardline,
  isHardlineBlocked,
  type HardlinePattern,
} from "../../src/security/hardline";
import { evaluateToolAccess, type PermissionChainConfig } from "../../src/tools/permission-chain";
import type { Tool, ToolUseContext } from "../../src/interfaces/tool";
import { isDenied, isOverrideProof } from "../../src/types/permission";

// ─── Mock Tool ───

function createMockTool(): Tool {
  return {
    name: "bash",
    description: "Bash tool",
    inputSchema: {} as any,
    maxResultSizeChars: 10000,
    call: async () => ({ content: "ok", isError: false }),
    checkPermissions: async () => ({ behavior: "allow" as const }),
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
  } as Tool;
}

const mockContext: ToolUseContext = {
  cwd: "/test",
  getAppState: () => ({}),
};

// ═══════════════════════════════════════════
// HARDLINE_PATTERNS 常量
// ═══════════════════════════════════════════

describe("HARDLINE_PATTERNS 常量", () => {
  it("应包含至少 10 个模式", () => {
    expect(HARDLINE_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });

  it("每个模式应有唯一 id", () => {
    const ids = HARDLINE_PATTERNS.map((p) => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("每个模式应有非空 reason", () => {
    for (const p of HARDLINE_PATTERNS) {
      expect(p.reason.length).toBeGreaterThan(0);
    }
  });

  it("每个模式的 pattern 应为有效的 RegExp", () => {
    for (const p of HARDLINE_PATTERNS) {
      expect(p.pattern).toBeInstanceOf(RegExp);
    }
  });
});

// ═══════════════════════════════════════════
// checkHardline — rm -rf / 系列
// ═══════════════════════════════════════════

describe("checkHardline — rm -rf / 系列", () => {
  it("rm -rf / 应被阻止", () => {
    const result = checkHardline("bash", { command: "rm -rf /" });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("rm_root_recursive");
    }
  });

  it("rm -fr / 应被阻止", () => {
    const result = checkHardline("bash", { command: "rm -fr /" });
    expect(result.blocked).toBe(true);
  });

  it("rm -rf /* 应被阻止", () => {
    const result = checkHardline("bash", { command: "rm -rf /*" });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("rm_root_glob");
    }
  });

  it("rm -rf /home/user/project 不应被阻止", () => {
    const result = checkHardline("bash", { command: "rm -rf /home/user/project" });
    expect(result.blocked).toBe(false);
  });

  it("rm file.txt 不应被阻止", () => {
    const result = checkHardline("bash", { command: "rm file.txt" });
    expect(result.blocked).toBe(false);
  });
});

// ═══════════════════════════════════════════
// checkHardline — Fork bomb 系列
// ═══════════════════════════════════════════

describe("checkHardline — Fork bomb 系列", () => {
  it("经典 fork bomb :(){ :|:& };: 应被阻止", () => {
    const result = checkHardline("bash", { command: ":(){ :|:& };:" });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("fork_bomb_classic");
    }
  });

  it("命名函数 fork bomb 应被阻止", () => {
    const result = checkHardline("bash", { command: "bomb(){ bomb|bomb& }; bomb" });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("fork_bomb_named");
    }
  });
});

// ═══════════════════════════════════════════
// checkHardline — mkfs 系列
// ═══════════════════════════════════════════

describe("checkHardline — mkfs 系列", () => {
  it("mkfs.ext4 应被阻止", () => {
    const result = checkHardline("bash", { command: "mkfs.ext4 /dev/sda1" });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("mkfs");
    }
  });

  it("mkfs.xfs 应被阻止", () => {
    const result = checkHardline("bash", { command: "mkfs.xfs /dev/nvme0n1" });
    expect(result.blocked).toBe(true);
  });

  it("mkfs.btrfs 应被阻止", () => {
    const result = checkHardline("bash", { command: "mkfs.btrfs /dev/sda1" });
    expect(result.blocked).toBe(true);
  });
});

// ═══════════════════════════════════════════
// checkHardline — dd to block device 系列
// ═══════════════════════════════════════════

describe("checkHardline — dd to block device 系列", () => {
  it("dd of=/dev/sda 应被阻止", () => {
    const result = checkHardline("bash", { command: "dd if=/dev/zero of=/dev/sda" });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("dd_block_device_sd");
    }
  });

  it("dd of=/dev/nvme0n1 应被阻止", () => {
    const result = checkHardline("bash", { command: "dd if=image.img of=/dev/nvme0n1" });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("dd_block_device_nvme");
    }
  });

  it("dd of=/tmp/backup.img 不应被阻止", () => {
    const result = checkHardline("bash", { command: "dd if=/dev/sda1 of=/tmp/backup.img" });
    expect(result.blocked).toBe(false);
  });
});

// ═══════════════════════════════════════════
// checkHardline — 系统关机系列
// ═══════════════════════════════════════════

describe("checkHardline — 系统关机系列", () => {
  it("shutdown 应被阻止", () => {
    const result = checkHardline("bash", { command: "shutdown -h now" });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("shutdown");
    }
  });

  it("reboot 应被阻止", () => {
    const result = checkHardline("bash", { command: "reboot" });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("reboot");
    }
  });

  it("halt 应被阻止", () => {
    const result = checkHardline("bash", { command: "halt" });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("halt");
    }
  });

  it("poweroff 应被阻止", () => {
    const result = checkHardline("bash", { command: "poweroff" });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("poweroff");
    }
  });

  it("init 0 应被阻止", () => {
    const result = checkHardline("bash", { command: "init 0" });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("init_runlevel_0_6");
    }
  });

  it("init 6 应被阻止", () => {
    const result = checkHardline("bash", { command: "init 6" });
    expect(result.blocked).toBe(true);
  });

  it("systemctl reboot 应被阻止", () => {
    const result = checkHardline("bash", { command: "systemctl reboot" });
    expect(result.blocked).toBe(true);
  });

  it("systemctl poweroff 应被阻止", () => {
    const result = checkHardline("bash", { command: "systemctl poweroff" });
    expect(result.blocked).toBe(true);
  });

  it("systemctl halt 应被阻止", () => {
    const result = checkHardline("bash", { command: "systemctl halt" });
    expect(result.blocked).toBe(true);
  });

  it("systemctl shutdown 应被阻止", () => {
    const result = checkHardline("bash", { command: "systemctl shutdown" });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("systemctl_shutdown");
    }
  });
});

// ═══════════════════════════════════════════
// checkHardline — 正常命令不被误拦截
// ═══════════════════════════════════════════

describe("checkHardline — 正常命令不被误拦截", () => {
  const safeCommands = [
    "ls -la",
    "cat file.txt",
    "grep pattern file",
    "npm install",
    "git status",
    "echo hello",
    "node server.js",
    "bun test",
    "rm -rf /home/user/temp",
    "rm -rf ./node_modules",
    "dd if=/dev/zero of=/tmp/test.img bs=1M count=100",
    "systemctl status nginx",
    "systemctl start docker",
    "init 3",
    "init 5",
  ];

  for (const cmd of safeCommands) {
    it(`${cmd} 不应被阻止`, () => {
      const result = checkHardline("bash", { command: cmd });
      expect(result.blocked).toBe(false);
    });
  }
});

// ═══════════════════════════════════════════
// checkHardline — 嵌套输入中的字符串提取
// ═══════════════════════════════════════════

describe("checkHardline — 嵌套输入提取", () => {
  it("嵌套对象中的危险命令应被检测", () => {
    const result = checkHardline("bash", {
      options: { command: "rm -rf /" },
    });
    expect(result.blocked).toBe(true);
  });

  it("数组中的危险命令应被检测", () => {
    const result = checkHardline("bash", {
      args: ["echo", "hello", "rm -rf /"],
    });
    expect(result.blocked).toBe(true);
  });

  it("深层嵌套中的危险命令应被检测", () => {
    const result = checkHardline("bash", {
      level1: { level2: { level3: { cmd: "reboot" } } },
    });
    expect(result.blocked).toBe(true);
  });
});

// ═══════════════════════════════════════════
// checkHardline — 额外模式追加
// ═══════════════════════════════════════════

describe("checkHardline — 额外模式追加", () => {
  it("额外模式应被追加到内置模式之后", () => {
    const additional: readonly HardlinePattern[] = [
      {
        id: "custom_wipe",
        pattern: /\bcustom_wipe\b/,
        reason: "Custom wipe command",
      },
    ];

    const result = checkHardline("bash", { command: "custom_wipe --all" }, additional);
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("custom_wipe");
    }
  });

  it("内置模式仍应生效", () => {
    const additional: readonly HardlinePattern[] = [
      {
        id: "custom_wipe",
        pattern: /\bcustom_wipe\b/,
        reason: "Custom wipe command",
      },
    ];

    const result = checkHardline("bash", { command: "rm -rf /" }, additional);
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.patternId).toBe("rm_root_recursive");
    }
  });

  it("无额外模式时内置模式仍应生效", () => {
    const result = checkHardline("bash", { command: "shutdown now" });
    expect(result.blocked).toBe(true);
  });
});

// ═══════════════════════════════════════════
// isHardlineBlocked
// ═══════════════════════════════════════════

describe("isHardlineBlocked", () => {
  it("blocked=true 时返回 true", () => {
    const result = checkHardline("bash", { command: "rm -rf /" });
    expect(isHardlineBlocked(result)).toBe(true);
  });

  it("blocked=false 时返回 false", () => {
    const result = checkHardline("bash", { command: "ls -la" });
    expect(isHardlineBlocked(result)).toBe(false);
  });
});

// ═══════════════════════════════════════════
// 权限链集成 — Phase 0
// ═══════════════════════════════════════════

describe("权限链集成 — Phase 0 Hardline", () => {
  it("rm -rf / 在普通模式下应被 hardline 阻止", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("bash", { command: "rm -rf /" }, tool, mockContext);

    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("hardlineBlock");
  });

  it("rm -rf / 在 YOLO/Override 模式下仍应被 hardline 阻止", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("bash", { command: "rm -rf /" }, tool, mockContext, {
      overrideMode: true,
    });

    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("hardlineBlock");
  });

  it("reboot 在 Override 模式下仍应被 hardline 阻止", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("bash", { command: "reboot" }, tool, mockContext, {
      overrideMode: true,
    });

    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("hardlineBlock");
  });

  it("正常命令不应被 hardline 阻止", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("bash", { command: "ls -la" }, tool, mockContext);

    expect(result.verdict.phase).not.toBe("hardlineBlock");
  });

  it("hardline deny 的 reason 应包含 HARDLINE 前缀", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("bash", { command: "rm -rf /" }, tool, mockContext);

    expect(isDenied(result.result)).toBe(true);
    expect(result.result.reason).toContain("HARDLINE:");
  });

  it("hardline 阻止应优先于 Deny 规则", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("bash", { command: "rm -rf /" }, tool, mockContext, {
      rules: [{ id: "r1", behavior: "allow", pattern: "bash", reason: "Allow bash" }],
    });

    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("hardlineBlock");
  });

  it("额外 hardline 模式应通过 config 生效", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("bash", { command: "custom_wipe --all" }, tool, mockContext, {
      additionalHardlinePatterns: [
        { id: "custom_wipe", pattern: /\bcustom_wipe\b/, reason: "Custom wipe command" },
      ],
    });

    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("hardlineBlock");
  });

  it("hardline 阻止应记录 patternId", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("bash", { command: "rm -rf /" }, tool, mockContext);

    expect(result.verdict.phase).toBe("hardlineBlock");
    if (result.verdict.phase === "hardlineBlock") {
      expect(result.verdict.patternId).toBe("rm_root_recursive");
    }
  });
});

// ═══════════════════════════════════════════
// isOverrideProof 包含 hardlineBlock
// ═══════════════════════════════════════════

describe("isOverrideProof — hardlineBlock", () => {
  it("hardlineBlock 是 override-proof", () => {
    expect(isOverrideProof({ phase: "hardlineBlock", reason: "test" })).toBe(true);
  });

  it("hardlineBlock 比 matchedDenyRule 更不可绕过", () => {
    const hardlineVerdict = { phase: "hardlineBlock" as const, reason: "test" };
    const denyVerdict = { phase: "matchedDenyRule" as const, reason: "test" };
    expect(isOverrideProof(hardlineVerdict)).toBe(true);
    expect(isOverrideProof(denyVerdict)).toBe(true);
  });
});
