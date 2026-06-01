import { describe, expect, it } from "vitest";
import { getModuleRetentionEntries } from "../src/module-retention";
import { getModuleLedgerEntries } from "../src/module-ledger";

describe("Task 8 > module retention", () => {
  it("为高概率孤立/扩展/重复装配候选提供去留决策与回滚边界", () => {
    const entries = getModuleRetentionEntries();
    expect(entries.map((entry) => entry.module)).toEqual([
      "plugins",
      "sandbox",
      "knowledge",
      "provider_bootstrap",
    ]);

    for (const entry of entries) {
      expect(entry.rationale.length).toBeGreaterThan(0);
      expect(entry.rollbackBoundary.length).toBeGreaterThan(0);
      expect(entry.actions.length).toBeGreaterThan(0);
    }
  });

  it("Task 7 台账中的 test_only/extension_only/partially_integrated 模块均被 Task 8 决策覆盖", () => {
    const ledgerEntries = getModuleLedgerEntries().filter((entry) =>
      entry.status === "test_only" || entry.status === "extension_only" || entry.status === "partially_integrated"
    );
    const retentionModules = new Set(getModuleRetentionEntries().map((entry) => entry.module));

    expect(ledgerEntries.map((entry) => entry.module)).toEqual(["plugins", "knowledge", "sandbox"]);
    for (const entry of ledgerEntries) {
      expect(retentionModules.has(entry.module)).toBe(true);
    }
  });

  it("重复的 provider 自动检测装配被收敛为共享 bootstrap 决策", () => {
    const providerBootstrap = getModuleRetentionEntries().find((entry) => entry.module === "provider_bootstrap");
    expect(providerBootstrap?.decision).toBe("consolidate_shared_bootstrap");
    expect(providerBootstrap?.actions).toContain("新增共享 provider bootstrap 函数");
  });
});
