/**
 * Session E.2 测试 — 工具懒加载机制。
 *
 * 覆盖：
 * - partitionTools 正确分区 eager/onDemand
 * - ToolDiscoveryService 发现/列表/已发现
 * - resolveEffectiveTools 合并 eager + 已发现
 * - 未发现的工具不在有效列表中
 */

import { describe, expect, it } from "vitest";
import {
  partitionTools,
  createToolDiscoveryService,
  resolveEffectiveTools,
  type ToolPartition,
} from "../../src/tools/tool-discovery";
import type { Tool } from "../../src/interfaces/tool";

// ─── Mock Tool 工厂 ───

function createMockTool(name: string, options?: { readonly lazyLoad?: boolean }): Tool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: {} as any,
    maxResultSizeChars: 10000,
    call: async () => ({ content: "ok", isError: false }),
    checkPermissions: async () => ({ behavior: "allow" }),
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    lazyLoad: options?.lazyLoad,
  } as Tool;
}

// ═══════════════════════════════════════════
// partitionTools
// ═══════════════════════════════════════════

describe("partitionTools", () => {
  it("应正确分区 eager 和 onDemand 工具", () => {
    const tools = [
      createMockTool("file_read"),
      createMockTool("glob"),
      createMockTool("heavy_tool", { lazyLoad: true }),
      createMockTool("rare_tool", { lazyLoad: true }),
    ];

    const partition = partitionTools(tools);
    expect(partition.eagerTools).toHaveLength(2);
    expect(partition.onDemandTools).toHaveLength(2);
    expect(partition.eagerTools.map((t) => t.name)).toEqual(["file_read", "glob"]);
    expect(partition.onDemandTools.map((t) => t.name)).toEqual(["heavy_tool", "rare_tool"]);
  });

  it("全部 eager 时 onDemand 为空", () => {
    const tools = [createMockTool("a"), createMockTool("b")];
    const partition = partitionTools(tools);
    expect(partition.eagerTools).toHaveLength(2);
    expect(partition.onDemandTools).toHaveLength(0);
  });

  it("全部 onDemand 时 eager 为空", () => {
    const tools = [
      createMockTool("a", { lazyLoad: true }),
      createMockTool("b", { lazyLoad: true }),
    ];
    const partition = partitionTools(tools);
    expect(partition.eagerTools).toHaveLength(0);
    expect(partition.onDemandTools).toHaveLength(2);
  });

  it("空列表应返回空分区", () => {
    const partition = partitionTools([]);
    expect(partition.eagerTools).toHaveLength(0);
    expect(partition.onDemandTools).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════
// ToolDiscoveryService
// ═══════════════════════════════════════════

describe("ToolDiscoveryService", () => {
  it("discover 应返回按需加载的工具", () => {
    const onDemandTools = [
      createMockTool("heavy_tool", { lazyLoad: true }),
      createMockTool("rare_tool", { lazyLoad: true }),
    ];
    const service = createToolDiscoveryService(onDemandTools);

    const tool = service.discover("heavy_tool");
    expect(tool).toBeDefined();
    expect(tool?.name).toBe("heavy_tool");
  });

  it("discover 不存在的工具应返回 undefined", () => {
    const service = createToolDiscoveryService([
      createMockTool("heavy_tool", { lazyLoad: true }),
    ]);
    expect(service.discover("nonexistent")).toBeUndefined();
  });

  it("listDiscoverable 应返回所有可发现的工具名称", () => {
    const service = createToolDiscoveryService([
      createMockTool("a", { lazyLoad: true }),
      createMockTool("b", { lazyLoad: true }),
    ]);
    expect(service.listDiscoverable()).toEqual(["a", "b"]);
  });

  it("isDiscovered 应正确反映发现状态", () => {
    const service = createToolDiscoveryService([
      createMockTool("a", { lazyLoad: true }),
    ]);

    expect(service.isDiscovered("a")).toBe(false);
    service.discover("a");
    expect(service.isDiscovered("a")).toBe(true);
  });

  it("getDiscoveredTools 应返回已发现的工具", () => {
    const service = createToolDiscoveryService([
      createMockTool("a", { lazyLoad: true }),
      createMockTool("b", { lazyLoad: true }),
      createMockTool("c", { lazyLoad: true }),
    ]);

    service.discover("a");
    service.discover("c");

    const discovered = service.getDiscoveredTools();
    expect(discovered).toHaveLength(2);
    expect(discovered.map((t) => t.name)).toEqual(["a", "c"]);
  });

  it("markDiscovered 应标记工具为已发现", () => {
    const service = createToolDiscoveryService([
      createMockTool("a", { lazyLoad: true }),
    ]);

    service.markDiscovered("a");
    expect(service.isDiscovered("a")).toBe(true);
    expect(service.getDiscoveredTools()).toHaveLength(1);
  });

  it("markDiscovered 不存在的工具应忽略", () => {
    const service = createToolDiscoveryService([]);
    service.markDiscovered("nonexistent");
    expect(service.getDiscoveredTools()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════
// resolveEffectiveTools
// ═══════════════════════════════════════════

describe("resolveEffectiveTools", () => {
  it("应合并 eager 和已发现的 onDemand 工具", () => {
    const eagerTools = [createMockTool("file_read"), createMockTool("glob")];
    const service = createToolDiscoveryService([
      createMockTool("heavy_tool", { lazyLoad: true }),
    ]);

    // 初始：只有 eager
    let effective = resolveEffectiveTools(eagerTools, service);
    expect(effective).toHaveLength(2);

    // 发现 heavy_tool
    service.discover("heavy_tool");
    effective = resolveEffectiveTools(eagerTools, service);
    expect(effective).toHaveLength(3);
    expect(effective.map((t) => t.name)).toEqual(["file_read", "glob", "heavy_tool"]);
  });

  it("未发现的 onDemand 工具不应包含在有效列表中", () => {
    const eagerTools = [createMockTool("file_read")];
    const service = createToolDiscoveryService([
      createMockTool("heavy_tool", { lazyLoad: true }),
      createMockTool("rare_tool", { lazyLoad: true }),
    ]);

    // 只发现 heavy_tool
    service.discover("heavy_tool");
    const effective = resolveEffectiveTools(eagerTools, service);
    expect(effective).toHaveLength(2);
    expect(effective.map((t) => t.name)).toEqual(["file_read", "heavy_tool"]);
  });
});
