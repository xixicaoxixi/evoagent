/**
 * 阶段 C 集成测试 — ROADMAP_FIX 阶段 C 修复验证。
 *
 * 覆盖：
 * - C.1: API级压缩 + LLM摘要 + 质量守卫 + 自适应分块
 * - C.2: 记忆提取系统（四类型分类 + 老化 + 目录扫描）
 * - C.3: KnowledgeManager + 混合检索
 * - C.4: 主动遗忘 + 梦境整理 + ContextEngine增强
 * - C.5: 向量存储扩展（memory-schema + vector-store）
 */

import { describe, it, expect, beforeEach } from "vitest";
import { APICompactStrategy } from "../../src/context/api-compact";
import {
  createSummarizer,
  computeAdaptiveChunkRatio,
  auditSummaryStructure,
  buildCompactionStructureInstructions,
} from "../../src/context/summarizer";
import {
  memoryAgeDays,
  memoryAge,
  memoryFreshnessText,
  memoryFreshnessNote,
  halfLifeDecay,
  computeStalenessScore,
} from "../../src/knowledge/memory-age";
import {
  parseMemoryType,
  isValidMemoryType,
  MEMORY_TYPE_DESCRIPTIONS,
} from "../../src/knowledge/memory-types";
import {
  scanMemoryHeaders,
  formatMemoryManifest,
  buildMemoryScanResult,
} from "../../src/knowledge/memory-scan";
import { createMemoryExtractor } from "../../src/knowledge/memory-extractor";
import { createKnowledgeManager } from "../../src/knowledge/knowledge-manager";
import { extractKeywords } from "../../src/knowledge/keywords";
import { createForgettingManager } from "../../src/knowledge/forgetting";
import { createDreamingManager } from "../../src/knowledge/dreaming";
import { createContextEngine } from "../../src/context/engine";
import type { Message } from "../../src/types/message";
import { ensureMemoryIndexSchema } from "../../src/knowledge/memory-schema";
import { createVectorStore } from "../../src/knowledge/vector-store";

// ═══════════════════════════════════════════════════════════
// C.1: API 级压缩
// ═══════════════════════════════════════════════════════════

describe("Phase C Integration > C.1: API 级压缩", () => {
  it("thinking 块清除策略", async () => {
    const strategy = new APICompactStrategy({
      clearThinking: true,
      keepThinkingTurns: 1,
    });

    const messages: Message[] = [
      {
        id: "m1", role: "assistant", timestamp: Date.now(),
        content: "<thinking>First thought process</thinking>\nLet me help you",
      },
      {
        id: "m2", role: "assistant", timestamp: Date.now(),
        content: "<thinking>Second thought process</thinking>\nHere is the answer",
      },
    ];

    const result = await strategy.compact(messages, {
      targetTokens: 1000,
      maxTokens: 2000,
      reason: "api",
    });

    // 第一条保留 thinking，第二条清除
    expect(result.messages[0]!.content).toContain("First thought process");
    expect(result.messages[1]!.content).not.toContain("Second thought process");
    expect(result.messages[1]!.content).toContain("thinking block cleared");
  });

  it("工具结果截断", async () => {
    const strategy = new APICompactStrategy({ maxToolResultChars: 50 });

    const messages: Message[] = [
      {
        id: "r1", role: "tool_result", timestamp: Date.now(),
        toolUseId: "t1", content: "A".repeat(200), isError: false,
      },
    ];

    const result = await strategy.compact(messages, {
      targetTokens: 1000,
      maxTokens: 2000,
      reason: "api",
    });

    expect(result.messages[0]!.content.length).toBeLessThanOrEqual(100);
    expect(result.messages[0]!.content).toContain("truncated by API compact");
  });
});

// ═══════════════════════════════════════════════════════════
// C.1: LLM 摘要 + 质量守卫
// ═══════════════════════════════════════════════════════════

describe("Phase C Integration > C.1: LLM 摘要 + 质量守卫", () => {
  it("规则摘要降级模式", async () => {
    const summarizer = createSummarizer();
    const messages: Message[] = [
      { id: "u1", role: "user", timestamp: Date.now(), content: "Fix the auth bug" },
      { id: "a1", role: "assistant", timestamp: Date.now(), content: "I'll fix it" },
      { id: "u2", role: "user", timestamp: Date.now(), content: "Also add tests" },
    ];

    const result = await summarizer.summarize(messages);
    expect(result.method).toBe("rule_fallback");
    expect(result.summary).toContain("Context Summary");
  });

  it("质量守卫检测必需章节", () => {
    const goodSummary = [
      "### Active Task", "- Implementing auth",
      "### Goal", "- Build auth system",
      "### Decisions", "- Use JWT",
      "### Completed Actions", "- Created User model",
      "### Open TODOs", "- Add tests",
      "### Remaining Work", "- Frontend login",
      "### Constraints/Rules", "- No global state",
      "### Active State", "- User model created",
      "### Error History", "- None",
      "### Tool Usage Summary", "- bash: 3 calls",
      "### Pending User Asks", "- Fix bug",
      "### Exact Identifiers", "- src/auth.ts:42",
      "### Environment Notes", "- Node.js v20",
    ].join("\n");

    const result = auditSummaryStructure(goodSummary);
    expect(result.ok).toBe(true);
    expect(result.missingSections).toHaveLength(0);
  });

  it("质量守卫检测缺失章节", () => {
    const badSummary = "Some random text without proper sections";
    const result = auditSummaryStructure(badSummary);
    expect(result.ok).toBe(false);
    expect(result.missingSections.length).toBeGreaterThan(0);
  });

  it("自适应分块比例", () => {
    // 短消息 → 基础比例（或接近）
    const shortMessages: Message[] = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`, role: "user", timestamp: Date.now(), content: "short",
    }));
    const ratio1 = computeAdaptiveChunkRatio(shortMessages, 100000);
    expect(ratio1).toBeGreaterThanOrEqual(0.15); // 至少 MIN_CHUNK_RATIO

    // 长消息在小的 context window 下 → 降低比例
    const longMessages: Message[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, role: "user", timestamp: Date.now(),
      content: "A".repeat(20000),
    }));
    const ratio2 = computeAdaptiveChunkRatio(longMessages, 50000);
    expect(ratio2).toBeLessThan(ratio1);
  });

  it("5段必需摘要结构指令生成", () => {
    const instructions = buildCompactionStructureInstructions();
    expect(instructions).toContain("### Decisions");
    expect(instructions).toContain("### Open TODOs");
    expect(instructions).toContain("### Constraints/Rules");
    expect(instructions).toContain("### Pending User Asks");
    expect(instructions).toContain("### Exact Identifiers");
  });
});

// ═══════════════════════════════════════════════════════════
// C.2: 记忆老化
// ═══════════════════════════════════════════════════════════

describe("Phase C Integration > C.2: 记忆老化", () => {
  it("memoryAgeDays 正确计算", () => {
    const now = Date.now();
    expect(memoryAgeDays(now)).toBe(0);
    expect(memoryAgeDays(now - 86_400_000)).toBe(1);
    expect(memoryAgeDays(now - 172_800_000)).toBe(2);
    expect(memoryAgeDays(now + 1000)).toBe(0);
  });

  it("memoryAge 人类可读", () => {
    const now = Date.now();
    expect(memoryAge(now)).toBe("today");
    expect(memoryAge(now - 86_400_000)).toBe("yesterday");
    expect(memoryAge(now - 172_800_000)).toBe("2 days ago");
  });

  it("陈旧性警告", () => {
    const now = Date.now();
    expect(memoryFreshnessText(now)).toBe("");
    expect(memoryFreshnessText(now - 86_400_000)).toBe(""); // 1天不警告
    expect(memoryFreshnessText(now - 172_800_000)).toContain("2 days old");
    expect(memoryFreshnessText(now - 172_800_000)).toContain("point-in-time");
  });

  it("半衰期衰减", () => {
    const now = Date.now();
    expect(halfLifeDecay(now, 30)).toBeCloseTo(1.0, 5);
    expect(halfLifeDecay(now - 30 * 86_400_000, 30)).toBeCloseTo(0.5, 5);
    expect(halfLifeDecay(now - 60 * 86_400_000, 30)).toBeCloseTo(0.25, 5);
  });

  it("半衰期衰减连续性：12 小时前的记忆得分 < 1.0", () => {
    const twelveHoursAgo = Date.now() - 12 * 3_600_000;
    const score = halfLifeDecay(twelveHoursAgo, 30);
    expect(score).toBeGreaterThan(0.97);
    expect(score).toBeLessThan(1.0);
  });

  it("陈旧性评分", () => {
    const now = Date.now();
    expect(computeStalenessScore(now, 90)).toBeCloseTo(0, 5);
    expect(computeStalenessScore(now - 45 * 86_400_000, 90)).toBeCloseTo(0.5, 5);
    expect(computeStalenessScore(now - 90 * 86_400_000, 90)).toBeCloseTo(1.0, 5);
    expect(computeStalenessScore(now - 180 * 86_400_000, 90)).toBe(1.0);
  });

  it("陈旧性评分连续性：12 小时前的记忆得分 > 0", () => {
    const twelveHoursAgo = Date.now() - 12 * 3_600_000;
    const score = computeStalenessScore(twelveHoursAgo, 90);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.01);
  });
});

// ═══════════════════════════════════════════════════════════
// C.2: 记忆类型分类
// ═══════════════════════════════════════════════════════════

describe("Phase C Integration > C.2: 四类型分类", () => {
  it("解析有效记忆类型", () => {
    expect(parseMemoryType("preference")).toBe("preference");
    expect(parseMemoryType("fact")).toBe("fact");
    expect(parseMemoryType("instruction")).toBe("instruction");
    expect(parseMemoryType("skill")).toBe("skill");
    expect(parseMemoryType("invalid")).toBeUndefined();
    expect(parseMemoryType(123)).toBeUndefined();
  });

  it("isValidMemoryType 类型守卫", () => {
    expect(isValidMemoryType("preference")).toBe(true);
    expect(isValidMemoryType("fact")).toBe(true);
    expect(isValidMemoryType("unknown")).toBe(false);
  });

  it("四类型描述完整", () => {
    expect(Object.keys(MEMORY_TYPE_DESCRIPTIONS)).toHaveLength(4);
    for (const type of ["preference", "fact", "instruction", "skill"] as const) {
      expect(MEMORY_TYPE_DESCRIPTIONS[type]).toBeDefined();
      expect(MEMORY_TYPE_DESCRIPTIONS[type].length).toBeGreaterThan(10);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// C.2: 目录扫描
// ═══════════════════════════════════════════════════════════

describe("Phase C Integration > C.2: 目录扫描", () => {
  it("scanMemoryHeaders 按时间排序", () => {
    const now = Date.now();
    const memories = [
      { filename: "old.md", filePath: "/mem/old.md", mtimeMs: now - 100000, type: "fact" },
      { filename: "new.md", filePath: "/mem/new.md", mtimeMs: now, type: "preference" },
      { filename: "mid.md", filePath: "/mem/mid.md", mtimeMs: now - 50000, type: "skill" },
    ];

    const headers = scanMemoryHeaders(memories);
    expect(headers).toHaveLength(3);
    expect(headers[0]!.filename).toBe("new.md"); // 最新优先
    expect(headers[1]!.filename).toBe("mid.md");
    expect(headers[2]!.filename).toBe("old.md");
  });

  it("formatMemoryManifest 格式化", () => {
    const now = Date.now();
    const headers = scanMemoryHeaders([
      { filename: "auth.md", filePath: "/mem/auth.md", mtimeMs: now, description: "Auth config", type: "fact" },
    ]);

    const manifest = formatMemoryManifest(headers);
    expect(manifest).toContain("[fact]");
    expect(manifest).toContain("auth.md");
    expect(manifest).toContain("Auth config");
  });
});

// ═══════════════════════════════════════════════════════════
// C.3: KnowledgeManager + 混合检索
// ═══════════════════════════════════════════════════════════

describe("Phase C Integration > C.3: KnowledgeManager", () => {
  let km: ReturnType<typeof createKnowledgeManager>;

  beforeEach(() => {
    km = createKnowledgeManager();
  });

  it("存储和检索记忆", () => {
    km.store({
      id: "m1", type: "fact", title: "Auth uses JWT",
      content: "The project uses JWT for authentication",
      tags: ["auth", "jwt"], createdAt: Date.now(), updatedAt: Date.now(),
      mtimeMs: Date.now(), source: "conversation", confidence: 0.9,
    });

    expect(km.count()).toBe(1);
    expect(km.get("m1")).toBeDefined();
  });

  it("TF-IDF 搜索", () => {
    km.store({
      id: "m1", type: "fact", title: "Auth uses JWT",
      content: "The project uses JWT for authentication",
      tags: [], createdAt: Date.now(), updatedAt: Date.now(),
      mtimeMs: Date.now(), source: "conversation", confidence: 0.9,
    });

    const results = km.search("JWT authentication");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.id).toBe("m1");
  });

  it("精确匹配优先", () => {
    km.store({
      id: "m1", type: "fact", title: "Database config",
      content: "PostgreSQL on port 5432",
      tags: [], createdAt: Date.now(), updatedAt: Date.now(),
      mtimeMs: Date.now(), source: "conversation", confidence: 0.9,
    });

    const results = km.search("PostgreSQL");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.matchMethod).toBe("exact");
  });

  it("知识注入到上下文", () => {
    km.store({
      id: "m1", type: "fact", title: "Auth uses JWT",
      content: "The project uses JWT for authentication",
      tags: [], createdAt: Date.now(), updatedAt: Date.now(),
      mtimeMs: Date.now(), source: "conversation", confidence: 0.9,
    });

    const injection = km.injectForContext("JWT auth", 500);
    expect(injection.injectedCount).toBeGreaterThan(0);
    expect(injection.systemPromptAddition).toContain("<knowledge-context>");
    expect(injection.systemPromptAddition).toContain("</knowledge-context>");
  });

  it("时间衰减影响排序", () => {
    const now = Date.now();
    km.store({
      id: "old", type: "fact", title: "Old auth info",
      content: "Auth uses API keys",
      tags: [], createdAt: now - 60 * 86_400_000, updatedAt: now - 60 * 86_400_000,
      mtimeMs: now - 60 * 86_400_000, source: "conversation", confidence: 0.9,
    });
    km.store({
      id: "new", type: "fact", title: "New auth info",
      content: "Auth uses OAuth2",
      tags: [], createdAt: now, updatedAt: now,
      mtimeMs: now, source: "conversation", confidence: 0.9,
    });

    const results = km.search("auth", { halfLifeDays: 7 });
    // 新记忆应该排名更高（衰减更少）
    if (results.length >= 2) {
      expect(results[0]!.entry.id).toBe("new");
    }
  });
});

// ═══════════════════════════════════════════════════════════
// C.3: 关键词提取
// ═══════════════════════════════════════════════════════════

describe("Phase C Integration > C.3: 关键词提取", () => {
  it("英文关键词提取", () => {
    const keywords = extractKeywords("that thing we discussed about the API authentication");
    expect(keywords).toContain("discussed");
    expect(keywords).toContain("api");
    expect(keywords).toContain("authentication");
    expect(keywords).not.toContain("the");
  });

  it("中文关键词提取", () => {
    const keywords = extractKeywords("之前讨论的那个方案");
    expect(keywords).toContain("讨论");
    expect(keywords).toContain("方案");
  });

  it("短词和数字过滤", () => {
    const keywords = extractKeywords("is it 123 or 456");
    expect(keywords).not.toContain("is");
    expect(keywords).not.toContain("it");
    expect(keywords).not.toContain("123");
  });
});

// ═══════════════════════════════════════════════════════════
// C.4: 主动遗忘
// ═══════════════════════════════════════════════════════════

describe("Phase C Integration > C.4: 主动遗忘", () => {
  it("时间衰减淘汰过期记忆", () => {
    const fm = createForgettingManager({ maxAgeDays: 30 });
    const now = Date.now();

    const memories = [
      {
        id: "old", type: "fact" as const, title: "Old", content: "Old info",
        tags: [], createdAt: now - 60 * 86_400_000, updatedAt: now - 60 * 86_400_000,
        mtimeMs: now - 60 * 86_400_000, source: "conversation", confidence: 0.9,
      },
      {
        id: "new", type: "fact" as const, title: "New", content: "New info",
        tags: [], createdAt: now, updatedAt: now,
        mtimeMs: now, source: "conversation", confidence: 0.9,
      },
    ];

    const result = fm.forget(memories);
    expect(result.forgotten).toHaveLength(1);
    expect(result.forgotten[0]!.id).toBe("old");
    expect(result.retained).toHaveLength(1);
    expect(result.reasons.get("old")).toContain("age_exceeded");
  });

  it("低置信度淘汰", () => {
    const fm = createForgettingManager({ minConfidence: 0.5 });
    const now = Date.now();

    const memories = [
      {
        id: "low", type: "fact" as const, title: "Low", content: "Low confidence",
        tags: [], createdAt: now, updatedAt: now,
        mtimeMs: now, source: "conversation", confidence: 0.1,
      },
      {
        id: "high", type: "fact" as const, title: "High", content: "High confidence",
        tags: [], createdAt: now, updatedAt: now,
        mtimeMs: now, source: "conversation", confidence: 0.9,
      },
    ];

    const result = fm.forget(memories);
    expect(result.forgotten).toHaveLength(1);
    expect(result.forgotten[0]!.id).toBe("low");
    expect(result.reasons.get("low")).toContain("low_confidence");
  });

  it("LRU 淘汰", () => {
    const fm = createForgettingManager({ maxMemories: 2 });
    const now = Date.now();

    const memories = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, type: "fact" as const, title: `Memory ${i}`, content: `Content ${i}`,
      tags: [] as const, createdAt: now, updatedAt: now,
      mtimeMs: now, source: "conversation", confidence: 0.9,
    }));

    const result = fm.forget(memories);
    expect(result.forgotten).toHaveLength(3);
    expect(result.retained).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════
// C.4: 梦境整理
// ═══════════════════════════════════════════════════════════

describe("Phase C Integration > C.4: 梦境整理", () => {
  it("Light dreaming 去重", () => {
    const dm = createDreamingManager({ light: { enabled: true } });
    const now = Date.now();

    const memories = [
      {
        id: "m1", type: "fact" as const, title: "Auth uses JWT", content: "JWT auth",
        tags: [], createdAt: now, updatedAt: now, mtimeMs: now, source: "conversation", confidence: 0.9,
      },
      {
        id: "m2", type: "fact" as const, title: "Auth uses JWT", content: "Updated: JWT with refresh",
        tags: [], createdAt: now + 1000, updatedAt: now + 1000, mtimeMs: now + 1000, source: "conversation", confidence: 0.9,
      },
    ];

    const result = dm.runLightDreaming(memories);
    expect(result.merged).toBe(1);
    expect(result.phase).toBe("light");
  });

  it("Deep dreaming 识别高价值记忆", () => {
    const dm = createDreamingManager({ deep: { enabled: true } });
    const now = Date.now();

    const memories = [
      {
        id: "popular", type: "fact" as const, title: "Popular", content: "Often recalled",
        tags: [], createdAt: now, updatedAt: now, mtimeMs: now, source: "conversation", confidence: 0.9,
      },
      {
        id: "unpopular", type: "fact" as const, title: "Unpopular", content: "Never recalled",
        tags: [], createdAt: now - 30 * 86_400_000, updatedAt: now - 30 * 86_400_000,
        mtimeMs: now - 30 * 86_400_000, source: "conversation", confidence: 0.1,
      },
    ];

    dm.recordRecall("popular");
    dm.recordRecall("popular");
    dm.recordRecall("popular");

    const result = dm.runDeepDreaming(memories);
    expect(result.promoted).toBeGreaterThanOrEqual(1);
    expect(result.deprecated).toBeGreaterThanOrEqual(1);
  });

  it("REM dreaming 模式识别", () => {
    const dm = createDreamingManager({ rem: { enabled: true } });
    const now = Date.now();

    const memories = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`, type: "fact" as const, title: `Fact ${i}`, content: `Content ${i}`,
      tags: ["common-tag"] as const, createdAt: now, updatedAt: now,
      mtimeMs: now, source: "conversation", confidence: 0.9,
    }));

    const result = dm.runREMDreaming(memories);
    expect(result.patterns.length).toBeGreaterThan(0);
    expect(result.patterns.some((p) => p.includes("common-tag"))).toBe(true);
  });

  it("三阶段完整执行", () => {
    const dm = createDreamingManager();
    const now = Date.now();

    const memories = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, type: "fact" as const, title: `Memory ${i}`, content: `Content ${i}`,
      tags: [] as const, createdAt: now, updatedAt: now,
      mtimeMs: now, source: "conversation", confidence: 0.9,
    }));

    const results = dm.runAllPhases(memories);
    expect(results).toHaveLength(3);
    expect(results[0]!.phase).toBe("light");
    expect(results[1]!.phase).toBe("deep");
    expect(results[2]!.phase).toBe("rem");
  });
});

// ═══════════════════════════════════════════════════════════
// C.4: ContextEngine 增强
// ═══════════════════════════════════════════════════════════

describe("Phase C Integration > C.4: ContextEngine 增强", () => {
  it("injectKnowledge 注入知识到上下文", () => {
    const engine = createContextEngine();

    engine.ingest({
      id: "u1", role: "user", timestamp: Date.now(), content: "Hello",
    });

    engine.injectKnowledge("<knowledge-context>JWT auth is used</knowledge-context>");

    const messages = engine.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("knowledge-context");
    expect(messages[1]!.role).toBe("user");
  });

  it("空内容不注入", () => {
    const engine = createContextEngine();
    engine.injectKnowledge("");
    expect(engine.getMessageCount()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// C.5: 向量存储扩展
// ═══════════════════════════════════════════════════════════

const isBunC5 = typeof (globalThis as any).Bun !== "undefined";
const describeBunC5 = isBunC5 ? describe : describe.skip;

describeBunC5("Phase C Integration > C.5: 向量存储扩展", () => {
  it("memory-schema 核心表创建", () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");
    const result = ensureMemoryIndexSchema(db, { ftsEnabled: false });
    expect(result.ftsAvailable).toBe(false);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = (tables as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("meta");
    expect(names).toContain("files");
    expect(names).toContain("chunks");
    db.close();
  });

  it("vector-store 优雅降级初始化", async () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");
    const store = createVectorStore(db);
    const result = await store.initialize();
    expect(result.vectorAvailable).toBe(false);
    store.close();
    db.close();
  });

  it("vector-store 索引 + 关键词搜索", async () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");
    const store = createVectorStore(db);
    await store.initialize();

    await store.indexChunk({
      id: "c1", path: "/mem/test.md", source: "memory",
      startLine: 1, endLine: 10, hash: "h1", model: "test",
      text: "The project uses OAuth2 for authentication", embedding: "[]",
      updatedAt: Date.now(),
    });

    const results = await store.search("OAuth2");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.searchMethod).toBe("keyword");

    store.close();
    db.close();
  });

  it("vector-store 统计信息", async () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");
    const store = createVectorStore(db);
    await store.initialize();

    await store.indexChunk({
      id: "c1", path: "/mem/a.md", source: "memory",
      startLine: 1, endLine: 5, hash: "h1", model: "test",
      text: "Content A", embedding: "[]", updatedAt: Date.now(),
    });

    const stats = store.getStats();
    expect(stats.totalChunks).toBe(1);

    store.close();
    db.close();
  });
});
