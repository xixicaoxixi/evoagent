import { describe, expect, it } from "vitest";
import { getModuleLedgerEntries, getModuleLedgerSnapshot } from "../src/module-ledger";

describe("Task 7 > module ledger", () => {
  it("覆盖 Task 7 要求的模块并提供五类分类边界", () => {
    const entries = getModuleLedgerEntries();
    expect(entries.map((entry) => entry.module)).toEqual([
      "plugins",
      "knowledge",
      "sandbox",
      "communication",
      "evolution",
      "observability",
      "mcp",
      "server",
    ]);

    const statuses = new Set(entries.map((entry) => entry.status));
    expect(statuses.has("mainline_integrated")).toBe(true);
    expect(statuses.has("partially_integrated")).toBe(true);
    expect(statuses.has("test_only")).toBe(true);
    expect(statuses.has("extension_only")).toBe(true);
  });

  it("每个模块都包含入口、调用方、测试、文档与运行时观测证据", () => {
    for (const entry of getModuleLedgerEntries()) {
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.evidence.entrypoints.length).toBeGreaterThan(0);
      expect(entry.evidence.callers.length).toBeGreaterThan(0);
      expect(entry.evidence.tests.length).toBeGreaterThan(0);
      expect(entry.evidence.docs.length).toBeGreaterThan(0);
      expect(entry.evidence.runtimeObservability.length).toBeGreaterThan(0);
    }
  });

  it("主闭环模块具备可审计的主链接入证据", () => {
    const entries = getModuleLedgerEntries();
    const communication = entries.find((entry) => entry.module === "communication");
    const evolution = entries.find((entry) => entry.module === "evolution");
    const observability = entries.find((entry) => entry.module === "observability");
    const mcp = entries.find((entry) => entry.module === "mcp");
    const server = entries.find((entry) => entry.module === "server");

    expect(communication?.status).toBe("mainline_integrated");
    expect(communication?.evidence.callers).toContain("src/integration/context.ts -> createGateway/createCommunity/createMarketplace/createAnalytics");
    expect(evolution?.status).toBe("mainline_integrated");
    expect(evolution?.evidence.callers).toContain("src/integration/context.ts -> createEvolutionEngine/createJSONLRuleStore");
    expect(observability?.status).toBe("mainline_integrated");
    expect(observability?.evidence.callers).toContain("src/integration/context.ts -> createLogger/createStatsStore/createCostTracker/createProgressTracker");
    expect(mcp?.status).toBe("mainline_integrated");
    expect(mcp?.evidence.runtimeObservability).toContain("MCP /health、/sse、/message");
    expect(server?.status).toBe("mainline_integrated");
    expect(server?.evidence.runtimeObservability).toContain("HTTP /api/v1/* 与根路径 Web UI");
  });

  it("仅测试接入与预留扩展模块被明确区分", () => {
    const entries = getModuleLedgerEntries();
    const plugins = entries.find((entry) => entry.module === "plugins");
    const sandbox = entries.find((entry) => entry.module === "sandbox");
    const knowledge = entries.find((entry) => entry.module === "knowledge");

    expect(plugins?.status).toBe("test_only");
    expect(plugins?.evidence.tests).toContain("tests/plugins/session6-integration.test.ts");
    expect(sandbox?.status).toBe("extension_only");
    expect(sandbox?.evidence.callers).toContain("未发现主链对 SubprocessSandbox 的实例化调用");
    expect(knowledge?.status).toBe("partially_integrated");
    expect(knowledge?.evidence.callers).toContain("src/integration/context.ts -> createMemoryExtractor()");
  });

  it("快照输出包含稳定时间戳与完整条目", () => {
    const snapshot = getModuleLedgerSnapshot(new Date("2026-04-22T00:00:00.000Z"));
    expect(snapshot.generatedAt).toBe("2026-04-22T00:00:00.000Z");
    expect(snapshot.entries).toEqual(getModuleLedgerEntries());
  });
});
