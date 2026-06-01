import { describe, it, expect } from "vitest";
import { createKnowledgeManager } from "../../src/knowledge/knowledge-manager";
import { createKnowledgeFacade } from "../../src/knowledge/knowledge-facade";
import type { KnowledgeStore, KnowledgeEntry } from "../../src/server/routes/knowledge";

describe("KnowledgeFacade — inject 写入一致性", () => {
  it("inject 后 getMemory 返回正确统计", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    facade.inject({ content: "TypeScript is typed", type: "fact", confidence: 0.9 });
    facade.inject({ content: "Use strict mode", type: "instruction", confidence: 1.0 });

    const mem = facade.getMemory();
    expect(mem.total).toBe(2);
    expect(mem.byType.fact).toBe(1);
    expect(mem.byType.instruction).toBe(1);
  });

  it("inject 返回 KnowledgeEntry 格式", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    const entry = facade.inject({ content: "Test content", type: "fact", confidence: 0.8 });

    expect(entry.id).toBeTruthy();
    expect(entry.content).toBe("Test content");
    expect(entry.type).toBe("fact");
    expect(entry.confidence).toBe(0.8);
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(entry.accessCount).toBe(0);
  });

  it("inject 后 get 可检索", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    const entry = facade.inject({ content: "Test knowledge", type: "fact", confidence: 0.9 });
    const retrieved = facade.get(entry.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.content).toBe("Test knowledge");
    expect(retrieved!.type).toBe("fact");
  });

  it("多次 inject 累加统计", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    facade.inject({ content: "Fact 1", type: "fact", confidence: 0.9 });
    facade.inject({ content: "Fact 2", type: "fact", confidence: 0.8 });
    facade.inject({ content: "Pref 1", type: "preference", confidence: 0.7 });

    const mem = facade.getMemory();
    expect(mem.total).toBe(3);
    expect(mem.byType.fact).toBe(2);
    expect(mem.byType.preference).toBe(1);
  });
});

describe("KnowledgeFacade — search 读取一致性", () => {
  it("inject 后 search 可检索到", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    facade.inject({ content: "Rust is memory safe", type: "fact", confidence: 0.9 });

    const results = facade.search("Rust memory");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.content).toContain("Rust");
  });

  it("search 结果格式为 KnowledgeSearchResult", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    facade.inject({ content: "Bun is fast", type: "fact", confidence: 0.9 });

    const results = facade.search("Bun");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.score).toBeGreaterThan(0);
    expect(results[0]!.entry).toBeDefined();
    expect(results[0]!.entry.id).toBeTruthy();
  });

  it("search 无结果时返回空数组", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    const results = facade.search("nonexistent query xyz");
    expect(results).toEqual([]);
  });

  it("search limit 参数生效", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    facade.inject({ content: "Python is dynamic", type: "fact", confidence: 0.9 });
    facade.inject({ content: "Python has GIL", type: "fact", confidence: 0.8 });
    facade.inject({ content: "Python uses indentation", type: "fact", confidence: 0.7 });

    const results = facade.search("Python", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("KnowledgeFacade — get 读取一致性", () => {
  it("get 不存在的 id 返回 undefined", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    expect(facade.get("nonexistent")).toBeUndefined();
  });

  it("get 返回的 entry 包含所有必要字段", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    const injected = facade.inject({ content: "Test", type: "skill", confidence: 0.6 });
    const retrieved = facade.get(injected.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(injected.id);
    expect(retrieved!.content).toBe("Test");
    expect(retrieved!.type).toBe("skill");
    expect(retrieved!.confidence).toBe(0.6);
    expect(retrieved!.createdAt).toBeGreaterThan(0);
    expect(retrieved!.accessCount).toBe(0);
  });
});

describe("KnowledgeFacade — 实现 KnowledgeStore 接口", () => {
  it("facade 可赋值给 KnowledgeStore 类型", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    const store: KnowledgeStore = facade;
    expect(store.search).toBeDefined();
    expect(store.inject).toBeDefined();
    expect(store.getMemory).toBeDefined();
    expect(store.get).toBeDefined();
  });
});

describe("KnowledgeFacade — 四种类型支持", () => {
  it("fact 类型正确存储和检索", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    facade.inject({ content: "Node.js uses V8", type: "fact", confidence: 0.9 });
    expect(facade.getMemory().byType.fact).toBe(1);
  });

  it("preference 类型正确存储和检索", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    facade.inject({ content: "Prefer tabs over spaces", type: "preference", confidence: 0.8 });
    expect(facade.getMemory().byType.preference).toBe(1);
  });

  it("instruction 类型正确存储和检索", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    facade.inject({ content: "Always use strict mode", type: "instruction", confidence: 1.0 });
    expect(facade.getMemory().byType.instruction).toBe(1);
  });

  it("skill 类型正确存储和检索", () => {
    const km = createKnowledgeManager();
    const facade = createKnowledgeFacade({ knowledgeManager: km });

    facade.inject({ content: "Debug with console.log", type: "skill", confidence: 0.7 });
    expect(facade.getMemory().byType.skill).toBe(1);
  });
});
