import { describe, it, expect } from "vitest";
import { createKnowledgeManager } from "../../src/knowledge/knowledge-manager";
import { createKnowledgeFacade } from "../../src/knowledge/knowledge-facade";
import type { KnowledgeStore } from "../../src/server/routes/knowledge";
import type { MemoryEntry } from "../../src/knowledge/memory-types";
import { createMemoryKnowledgeStore } from "../../src/server/routes/knowledge";

describe("知识统一集成 — HTTP 注入 → 主链检索", () => {
  it("通过 Facade 注入的知识可通过 KnowledgeManager.search 检索到", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    facade.inject({ content: "EvoAgent uses TypeScript strict mode", type: "fact", confidence: 0.9 });

    const results = km.search("TypeScript strict");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.content).toContain("TypeScript strict mode");
  });

  it("通过 Facade 注入的多条知识全部出现在主链检索中", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    facade.inject({ content: "Rust ownership model prevents data races", type: "fact", confidence: 0.9 });
    facade.inject({ content: "Rust borrow checker enforces ownership rules", type: "fact", confidence: 0.8 });

    const results = km.search("Rust");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("通过 Facade 注入的 instruction 类型在主链中保留类型信息", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    facade.inject({ content: "Always run tests before commit", type: "instruction", confidence: 1.0 });

    const all = km.getAll();
    expect(all.length).toBe(1);
    expect(all[0]!.type).toBe("instruction");
    expect(all[0]!.content).toBe("Always run tests before commit");
  });

  it("通过 Facade 注入的知识在 KnowledgeManager.get 中可检索", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    const entry = facade.inject({ content: "Zod validates schemas", type: "fact", confidence: 0.9 });

    const kmEntry = km.get(entry.id);
    expect(kmEntry).toBeDefined();
    expect(kmEntry!.content).toBe("Zod validates schemas");
  });
});

describe("知识统一集成 — 主链抽取 → HTTP 搜索", () => {
  it("通过 KnowledgeManager.store 存入的记忆可通过 Facade.search 检索到", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    const now = Date.now();
    const memoryEntry: MemoryEntry = {
      id: "mem-001",
      type: "fact",
      title: "Bun runtime",
      content: "Bun is a fast JavaScript runtime built on JavaScriptCore",
      tags: ["runtime", "javascript"],
      createdAt: now,
      updatedAt: now,
      mtimeMs: now,
      source: "memory-extractor",
      confidence: 0.85,
    };

    km.store(memoryEntry);

    const results = facade.search("Bun runtime");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.content).toContain("Bun");
  });

  it("主链抽取的多条记忆全部出现在 Facade 搜索中", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    const now = Date.now();
    km.store({
      id: "mem-001",
      type: "fact",
      title: "V8 engine",
      content: "V8 is Google's JavaScript engine used in Chrome and Node.js",
      tags: ["engine", "javascript"],
      createdAt: now,
      updatedAt: now,
      mtimeMs: now,
      source: "memory-extractor",
      confidence: 0.9,
    });

    km.store({
      id: "mem-002",
      type: "skill",
      title: "Debugging with V8",
      content: "Use V8 inspector protocol for debugging Node.js applications",
      tags: ["debugging", "v8"],
      createdAt: now,
      updatedAt: now,
      mtimeMs: now,
      source: "memory-extractor",
      confidence: 0.8,
    });

    const results = facade.search("V8");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("主链抽取的记忆在 Facade.getMemory 中正确统计", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    const now = Date.now();
    km.store({
      id: "mem-001",
      type: "preference",
      title: "Code style",
      content: "User prefers tabs over spaces",
      tags: ["style"],
      createdAt: now,
      updatedAt: now,
      mtimeMs: now,
      source: "memory-extractor",
      confidence: 0.7,
    });

    const mem = facade.getMemory();
    expect(mem.total).toBe(1);
    expect(mem.byType.preference).toBe(1);
  });

  it("主链抽取的记忆可通过 Facade.get 按 ID 获取", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    const now = Date.now();
    km.store({
      id: "mem-unique-123",
      type: "skill",
      title: "Testing",
      content: "Write tests before implementation",
      tags: ["testing"],
      createdAt: now,
      updatedAt: now,
      mtimeMs: now,
      source: "memory-extractor",
      confidence: 0.9,
    });

    const entry = facade.get("mem-unique-123");
    expect(entry).toBeDefined();
    expect(entry!.content).toBe("Write tests before implementation");
    expect(entry!.type).toBe("skill");
  });
});

describe("知识统一集成 — 双向一致性", () => {
  it("Facade 注入 + 主链注入 → 统一搜索覆盖全部", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    const now = Date.now();

    // 通过 Facade（模拟 HTTP 注入）
    facade.inject({ content: "HTTP injected: API uses REST conventions", type: "fact", confidence: 0.9 });

    // 通过 KnowledgeManager（模拟主链抽取）
    km.store({
      id: "mem-extracted",
      type: "fact",
      title: "REST API",
      content: "Extracted: REST API follows resource-oriented design",
      tags: ["api"],
      createdAt: now,
      updatedAt: now,
      mtimeMs: now,
      source: "memory-extractor",
      confidence: 0.8,
    });

    // 通过 Facade 搜索应覆盖两条
    const facadeResults = facade.search("REST API");
    expect(facadeResults.length).toBeGreaterThanOrEqual(2);

    // 通过 KnowledgeManager 搜索也应覆盖两条
    const kmResults = km.search("REST API");
    expect(kmResults.length).toBeGreaterThanOrEqual(2);
  });

  it("Facade 注入 + 主链注入 → getMemory 统计一致", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    const now = Date.now();

    facade.inject({ content: "HTTP fact 1", type: "fact", confidence: 0.9 });
    facade.inject({ content: "HTTP instruction 1", type: "instruction", confidence: 1.0 });

    km.store({
      id: "mem-1",
      type: "preference",
      title: "Pref",
      content: "Main chain preference",
      tags: [],
      createdAt: now,
      updatedAt: now,
      mtimeMs: now,
      source: "extractor",
      confidence: 0.7,
    });

    const mem = facade.getMemory();
    expect(mem.total).toBe(3);
    expect(mem.byType.fact).toBe(1);
    expect(mem.byType.instruction).toBe(1);
    expect(mem.byType.preference).toBe(1);
  });

  it("删除操作一致性：KnowledgeManager.delete 后 Facade 搜索不再返回", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    const entry = facade.inject({ content: "Temporary knowledge", type: "fact", confidence: 0.5 });

    expect(facade.get(entry.id)).toBeDefined();

    km.delete(entry.id);

    expect(facade.get(entry.id)).toBeUndefined();
    expect(facade.getMemory().total).toBe(0);
  });
});

describe("知识统一集成 — HTTP 路由场景模拟", () => {
  it("模拟 POST /knowledge/inject → GET /knowledge/search 流程", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    // 模拟 POST /knowledge/inject
    const injected = facade.inject({
      content: "The project uses Zod for schema validation",
      type: "fact",
      confidence: 0.9,
    });

    expect(injected.id).toBeTruthy();
    expect(injected.type).toBe("fact");

    // 模拟 GET /knowledge/search?q=Zod
    const results = facade.search("Zod validation");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.content).toContain("Zod");
  });

  it("模拟 GET /knowledge/memory 统计", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    facade.inject({ content: "Fact 1", type: "fact", confidence: 0.9 });
    facade.inject({ content: "Skill 1", type: "skill", confidence: 0.7 });

    const mem = facade.getMemory();
    expect(mem.total).toBe(2);
    expect(mem.byType).toEqual({
      fact: 1,
      preference: 0,
      instruction: 0,
      skill: 1,
    });
  });

  it("无 context 时回退到独立 KnowledgeStore", () => {
    const standaloneStore = createMemoryKnowledgeStore();
    const entry = standaloneStore.inject({ content: "Test", type: "fact", confidence: 0.8 });
    expect(entry.id).toBeTruthy();

    const results = standaloneStore.search("Test");
    expect(results.length).toBeGreaterThan(0);
  });
});
