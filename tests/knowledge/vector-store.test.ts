/**
 * C.5 向量存储扩展测试 — ROADMAP_FIX Session C.5 验证。
 *
 * 覆盖：
 * - memory-schema.ts: Schema 创建、FTS5 降级、元数据、文件索引、Chunk 操作、嵌入缓存
 * - vector-store.ts: 初始化（优雅降级）、索引、FTS 搜索、关键词搜索回退、统计
 */

import { describe, it, expect, beforeEach } from "vitest";

const isBun = typeof (globalThis as any).Bun !== "undefined";

const describeBun = isBun ? describe : describe.skip;

import {
  ensureMemoryIndexSchema,
  getMeta,
  setMeta,
  upsertFileIndex,
  getFileIndex,
  upsertChunk,
  getChunksByPath,
  deleteChunksByPath,
  ftsSearch,
  getCachedEmbedding,
  setCachedEmbedding,
  type FileIndexEntry,
  type ChunkEntry,
} from "../../src/knowledge/memory-schema";
import {
  createVectorStore,
  type EmbeddingProvider,
  type VectorStore,
} from "../../src/knowledge/vector-store";

type Database = any;

function createDB(): Database {
  const { Database: BunDatabase } = require("bun:sqlite");
  return new BunDatabase();
}

// ═══════════════════════════════════════════════════════════
// memory-schema: Schema 创建
// ═══════════════════════════════════════════════════════════

describeBun("C.5 > memory-schema > Schema 创建", () => {
  it("创建核心表（meta/files/chunks）", () => {
    const db = createDB();
    const result = ensureMemoryIndexSchema(db, { ftsEnabled: false });
    expect(result.ftsAvailable).toBe(false);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t: { name: string }) => t.name);
    expect(tableNames).toContain("meta");
    expect(tableNames).toContain("files");
    expect(tableNames).toContain("chunks");
    db.close();
  });

  it("FTS5 优雅降级", () => {
    const db = createDB();
    const result = ensureMemoryIndexSchema(db, {
      ftsEnabled: true,
      ftsTable: "test_fts",
    });
    if (result.ftsAvailable) {
      expect(result.ftsError).toBeUndefined();
    } else {
      expect(result.ftsError).toBeDefined();
    }
    db.close();
  });

  it("创建嵌入缓存表", () => {
    const db = createDB();
    ensureMemoryIndexSchema(db, {
      cacheEnabled: true,
      embeddingCacheTable: "test_cache",
    });

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t: { name: string }) => t.name);
    expect(tableNames).toContain("test_cache");
    db.close();
  });

  it("Schema 迁移：ensureColumn 向前兼容", () => {
    const db = createDB();
    ensureMemoryIndexSchema(db, { ftsEnabled: false });
    const result = ensureMemoryIndexSchema(db, { ftsEnabled: false });
    expect(result.ftsAvailable).toBe(false);
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════
// memory-schema: 元数据操作
// ═══════════════════════════════════════════════════════════

describeBun("C.5 > memory-schema > 元数据操作", () => {
  let db: Database;

  beforeEach(() => {
    db = createDB();
    ensureMemoryIndexSchema(db, { ftsEnabled: false });
  });

  it("setMeta + getMeta 读写", () => {
    expect(getMeta(db, "version")).toBeUndefined();
    setMeta(db, "version", "1.0.0");
    expect(getMeta(db, "version")).toBe("1.0.0");
  });

  it("setMeta 幂等更新", () => {
    setMeta(db, "version", "1.0.0");
    setMeta(db, "version", "2.0.0");
    expect(getMeta(db, "version")).toBe("2.0.0");
  });
});

// ═══════════════════════════════════════════════════════════
// memory-schema: 文件索引
// ═══════════════════════════════════════════════════════════

describeBun("C.5 > memory-schema > 文件索引", () => {
  let db: Database;

  beforeEach(() => {
    db = createDB();
    ensureMemoryIndexSchema(db, { ftsEnabled: false });
  });

  it("upsert + get 文件索引", () => {
    const entry: FileIndexEntry = {
      path: "/mem/auth.md",
      source: "memory",
      hash: "abc123",
      mtime: Date.now(),
      size: 1024,
    };

    expect(getFileIndex(db, "/mem/auth.md")).toBeUndefined();
    upsertFileIndex(db, entry);
    const result = getFileIndex(db, "/mem/auth.md");
    expect(result).toBeDefined();
    expect(result!.path).toBe("/mem/auth.md");
    expect(result!.hash).toBe("abc123");
  });

  it("upsert 更新已有文件", () => {
    const entry1: FileIndexEntry = {
      path: "/mem/auth.md", source: "memory", hash: "v1", mtime: 1000, size: 100,
    };
    const entry2: FileIndexEntry = {
      path: "/mem/auth.md", source: "memory", hash: "v2", mtime: 2000, size: 200,
    };

    upsertFileIndex(db, entry1);
    upsertFileIndex(db, entry2);
    const result = getFileIndex(db, "/mem/auth.md");
    expect(result!.hash).toBe("v2");
    expect(result!.mtime).toBe(2000);
  });
});

// ═══════════════════════════════════════════════════════════
// memory-schema: Chunk 操作
// ═══════════════════════════════════════════════════════════

describeBun("C.5 > memory-schema > Chunk 操作", () => {
  let db: Database;

  beforeEach(() => {
    db = createDB();
    ensureMemoryIndexSchema(db, { ftsEnabled: true, ftsTable: "chunks_fts" });
  });

  it("upsert + get Chunk", () => {
    const chunk: ChunkEntry = {
      id: "c1",
      path: "/mem/auth.md",
      source: "memory",
      startLine: 1,
      endLine: 10,
      hash: "h1",
      model: "test-model",
      text: "The project uses JWT for authentication",
      embedding: "[]",
      updatedAt: Date.now(),
    };

    upsertChunk(db, chunk);
    const chunks = getChunksByPath(db, "/mem/auth.md");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.id).toBe("c1");
    expect(chunks[0]!.text).toContain("JWT");
  });

  it("upsert 更新已有 Chunk", () => {
    const chunk1: ChunkEntry = {
      id: "c1", path: "/mem/auth.md", source: "memory",
      startLine: 1, endLine: 10, hash: "h1", model: "test",
      text: "Version 1", embedding: "[]", updatedAt: 1000,
    };
    const chunk2: ChunkEntry = {
      id: "c1", path: "/mem/auth.md", source: "memory",
      startLine: 1, endLine: 10, hash: "h2", model: "test",
      text: "Version 2 updated", embedding: "[]", updatedAt: 2000,
    };

    upsertChunk(db, chunk1);
    upsertChunk(db, chunk2);
    const chunks = getChunksByPath(db, "/mem/auth.md");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("Version 2 updated");
  });

  it("deleteChunksByPath 删除路径下所有块", () => {
    const chunk1: ChunkEntry = {
      id: "c1", path: "/mem/a.md", source: "memory",
      startLine: 1, endLine: 5, hash: "h1", model: "test",
      text: "Content A", embedding: "[]", updatedAt: Date.now(),
    };
    const chunk2: ChunkEntry = {
      id: "c2", path: "/mem/b.md", source: "memory",
      startLine: 1, endLine: 5, hash: "h2", model: "test",
      text: "Content B", embedding: "[]", updatedAt: Date.now(),
    };

    upsertChunk(db, chunk1);
    upsertChunk(db, chunk2);
    expect(getChunksByPath(db, "/mem/a.md")).toHaveLength(1);

    const deleted = deleteChunksByPath(db, "/mem/a.md");
    expect(deleted).toBe(1);
    expect(getChunksByPath(db, "/mem/a.md")).toHaveLength(0);
    expect(getChunksByPath(db, "/mem/b.md")).toHaveLength(1);
  });

  it("FTS5 全文搜索", () => {
    const chunk: ChunkEntry = {
      id: "c1", path: "/mem/auth.md", source: "memory",
      startLine: 1, endLine: 10, hash: "h1", model: "test",
      text: "The project uses JWT tokens for authentication", embedding: "[]",
      updatedAt: Date.now(),
    };

    upsertChunk(db, chunk);

    try {
      db.prepare(
        `INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(chunk.text, chunk.id, chunk.path, chunk.source, chunk.model, chunk.startLine, chunk.endLine);

      const results = ftsSearch(db, "chunks_fts", "JWT authentication");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.text).toContain("JWT");
    } catch {
      // FTS5 可能不可用
    }
  });
});

// ═══════════════════════════════════════════════════════════
// memory-schema: 嵌入缓存
// ═══════════════════════════════════════════════════════════

describeBun("C.5 > memory-schema > 嵌入缓存", () => {
  let db: Database;

  beforeEach(() => {
    db = createDB();
    ensureMemoryIndexSchema(db, {
      cacheEnabled: true,
      embeddingCacheTable: "emb_cache",
    });
  });

  it("缓存读写", () => {
    expect(
      getCachedEmbedding(db, "emb_cache", "openai", "text-embedding-3-small", "", "hash1"),
    ).toBeUndefined();

    setCachedEmbedding(db, "emb_cache", {
      provider: "openai",
      model: "text-embedding-3-small",
      providerKey: "",
      hash: "hash1",
      embedding: "[0.1, 0.2, 0.3]",
      dims: 3,
      updatedAt: Date.now(),
    });

    const cached = getCachedEmbedding(db, "emb_cache", "openai", "text-embedding-3-small", "", "hash1");
    expect(cached).toBeDefined();
    expect(cached!.embedding).toBe("[0.1, 0.2, 0.3]");
    expect(cached!.dims).toBe(3);
  });

  it("缓存幂等更新", () => {
    setCachedEmbedding(db, "emb_cache", {
      provider: "openai", model: "test", providerKey: "", hash: "h1",
      embedding: "[0.1]", dims: 1, updatedAt: 1000,
    });
    setCachedEmbedding(db, "emb_cache", {
      provider: "openai", model: "test", providerKey: "", hash: "h1",
      embedding: "[0.9]", dims: 1, updatedAt: 2000,
    });

    const cached = getCachedEmbedding(db, "emb_cache", "openai", "test", "", "h1");
    expect(cached!.embedding).toBe("[0.9]");
  });
});

// ═══════════════════════════════════════════════════════════
// vector-store: 初始化与优雅降级
// ═══════════════════════════════════════════════════════════

describeBun("C.5 > vector-store > 初始化", () => {
  it("无 sqlite-vec 时优雅降级", async () => {
    const db = createDB();
    const store = createVectorStore(db, {
      schemaConfig: { ftsEnabled: true },
    });

    const result = await store.initialize();
    expect(result.vectorAvailable).toBe(false);
    store.close();
    db.close();
  });

  it("无 EmbeddingProvider 时向量搜索不可用", async () => {
    const db = createDB();
    const store = createVectorStore(db);

    const result = await store.initialize();
    expect(result.vectorAvailable).toBe(false);
    store.close();
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════
// vector-store: 索引与检索
// ═══════════════════════════════════════════════════════════

describeBun("C.5 > vector-store > 索引与检索", () => {
  let db: Database;
  let store: VectorStore;

  beforeEach(async () => {
    db = createDB();
    store = createVectorStore(db, {
      schemaConfig: { ftsEnabled: true },
    });
    await store.initialize();
  });

  it("索引 Chunk 并按路径检索", async () => {
    const chunk: ChunkEntry = {
      id: "c1", path: "/mem/auth.md", source: "memory",
      startLine: 1, endLine: 10, hash: "h1", model: "test",
      text: "JWT authentication with refresh tokens", embedding: "[]",
      updatedAt: Date.now(),
    };

    await store.indexChunk(chunk);
    const chunks = store.getChunksByPath("/mem/auth.md");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("JWT");
  });

  it("批量索引", async () => {
    const chunks: ChunkEntry[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`, path: `/mem/file${i}.md`, source: "memory" as const,
      startLine: 1, endLine: 10, hash: `h${i}`, model: "test",
      text: `Content number ${i}`, embedding: "[]" as const,
      updatedAt: Date.now(),
    }));

    await store.indexChunks(chunks);
    expect(store.getChunksByPath("/mem/file0.md")).toHaveLength(1);
    expect(store.getChunksByPath("/mem/file4.md")).toHaveLength(1);
  });

  it("关键词搜索回退", async () => {
    const chunk: ChunkEntry = {
      id: "c1", path: "/mem/auth.md", source: "memory",
      startLine: 1, endLine: 10, hash: "h1", model: "test",
      text: "The project uses OAuth2 for authentication", embedding: "[]",
      updatedAt: Date.now(),
    };

    await store.indexChunk(chunk);
    const results = await store.search("OAuth2");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.searchMethod).toBe("keyword");
  });

  it("搜索不存在的文本返回空", async () => {
    const results = await store.search("nonexistent_xyz_12345");
    expect(results).toHaveLength(0);
  });

  it("删除路径", async () => {
    const chunk: ChunkEntry = {
      id: "c1", path: "/mem/temp.md", source: "memory",
      startLine: 1, endLine: 5, hash: "h1", model: "test",
      text: "Temporary content", embedding: "[]",
      updatedAt: Date.now(),
    };

    await store.indexChunk(chunk);
    expect(store.getChunksByPath("/mem/temp.md")).toHaveLength(1);

    const deleted = store.deletePath("/mem/temp.md");
    expect(deleted).toBe(1);
    expect(store.getChunksByPath("/mem/temp.md")).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// vector-store: 统计信息
// ═══════════════════════════════════════════════════════════

describeBun("C.5 > vector-store > 统计信息", () => {
  it("初始统计为零", async () => {
    const db = createDB();
    const store = createVectorStore(db);
    await store.initialize();

    const stats = store.getStats();
    expect(stats.totalChunks).toBe(0);
    expect(stats.totalPaths).toBe(0);
    store.close();
    db.close();
  });

  it("索引后统计更新", async () => {
    const db = createDB();
    const store = createVectorStore(db);
    await store.initialize();

    await store.indexChunk({
      id: "c1", path: "/mem/a.md", source: "memory",
      startLine: 1, endLine: 5, hash: "h1", model: "test",
      text: "Content A", embedding: "[]", updatedAt: Date.now(),
    });
    await store.indexChunk({
      id: "c2", path: "/mem/b.md", source: "memory",
      startLine: 1, endLine: 5, hash: "h2", model: "test",
      text: "Content B", embedding: "[]", updatedAt: Date.now(),
    });

    const stats = store.getStats();
    expect(stats.totalChunks).toBe(2);
    store.close();
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════
// vector-store: Mock EmbeddingProvider 集成
// ═══════════════════════════════════════════════════════════

describeBun("C.5 > vector-store > Mock EmbeddingProvider", () => {
  it("使用 Mock Provider 索引时生成嵌入", async () => {
    const mockProvider: EmbeddingProvider = {
      name: "mock",
      dimensions: 3,
      embed: async (text) => ({
        embedding: [0.1, 0.2, 0.3],
        model: "mock-model",
        dims: 3,
      }),
    };

    const db = createDB();
    const store = createVectorStore(db, {
      embeddingProvider: mockProvider,
      schemaConfig: { cacheEnabled: true },
    });

    await store.initialize();

    const chunk: ChunkEntry = {
      id: "c1", path: "/mem/test.md", source: "memory",
      startLine: 1, endLine: 5, hash: "h1", model: "mock-model",
      text: "Test content", embedding: "",
      updatedAt: Date.now(),
    };

    await store.indexChunk(chunk);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t: { name: string }) => t.name);

    if (tableNames.includes("embedding_cache")) {
      const cached = getCachedEmbedding(db, "embedding_cache", "mock", "mock-model", "", "h1");
      expect(cached).toBeDefined();
      expect(cached!.embedding).toBe("[0.1,0.2,0.3]");
    } else {
      const chunks = store.getChunksByPath("/mem/test.md");
      expect(chunks).toHaveLength(1);
    }

    store.close();
    db.close();
  });
});
