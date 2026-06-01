/**
 * 向量存储扩展 — sqlite-vec 动态加载 + 向量索引 + 语义搜索。
 *
 * 参考 `代码片段_记忆系统与知识管理补充.md` 片段 #4、#5、#6。
 *
 * 设计原则：
 * - 优雅降级：sqlite-vec 不可用时回退到 TF-IDF
 * - 接口抽象：EmbeddingProvider 可替换
 * - 原子写入：tmp + rename 模式
 * - 安全优先：所有 SQL 参数化
 */

import type { Database } from "bun:sqlite";
import {
  ensureMemoryIndexSchema,
  type MemorySchemaConfig,
  type MemorySchemaResult,
  upsertChunk,
  getChunksByPath,
  deleteChunksByPath,
  ftsSearch,
  getCachedEmbedding,
  setCachedEmbedding,
  type ChunkEntry,
  type EmbeddingCacheEntry,
} from "./memory-schema";

// ─── sqlite-vec 类型声明（动态加载，可能不存在） ───

interface SqliteVecModule {
  getLoadablePath?(): string;
  load(db: Database): void;
}

// ─── sqlite-vec 加载结果 ───

export interface SqliteVecLoadResult {
  readonly ok: boolean;
  readonly extensionPath?: string | undefined;
  readonly error?: string | undefined;
}

// ─── Embedding Provider 接口 ───

export interface EmbeddingProvider {
  readonly name: string;
  /** 生成文本嵌入向量 */
  embed(text: string): Promise<EmbeddingResult>;
  /** 批量生成嵌入向量 */
  embedBatch?(texts: readonly string[]): Promise<readonly EmbeddingResult[]>;
  /** 嵌入维度 */
  readonly dimensions: number;
}

export interface EmbeddingResult {
  readonly embedding: number[];
  readonly model: string;
  readonly dims: number;
}

// ─── 向量存储配置 ───

export interface VectorStoreConfig {
  /** sqlite-vec 扩展路径（可选，自动解析） */
  readonly extensionPath?: string;
  /** Embedding Provider（可选，不提供则仅支持 FTS5） */
  readonly embeddingProvider?: EmbeddingProvider;
  /** Schema 配置 */
  readonly schemaConfig?: MemorySchemaConfig;
  /** 向量维度（默认 1536，OpenAI text-embedding-3-small） */
  readonly dimensions?: number;
  /** 向量搜索最大结果数 */
  readonly maxSearchResults?: number;
  /** 余弦相似度阈值 */
  readonly similarityThreshold?: number;
}

// ─── 向量搜索结果 ───

export interface VectorSearchResult {
  readonly chunk: ChunkEntry;
  readonly score: number;
  readonly searchMethod: "vector" | "fts" | "keyword";
}

// ─── 向量存储状态 ───

export interface VectorStoreStats {
  readonly totalChunks: number;
  readonly totalPaths: number;
  readonly vectorSearchAvailable: boolean;
  readonly ftsAvailable: boolean;
  readonly embeddingCacheHits: number;
  readonly embeddingCacheMisses: number;
}

// ─── 向量存储 ───

export interface VectorStore {
  /** 初始化 Schema 和扩展 */
  initialize(): Promise<VectorStoreInitResult>;
  /** 索引文本块 */
  indexChunk(chunk: ChunkEntry): Promise<void>;
  /** 批量索引 */
  indexChunks(chunks: readonly ChunkEntry[]): Promise<void>;
  /** 向量搜索 */
  search(query: string, limit?: number): Promise<readonly VectorSearchResult[]>;
  /** FTS5 全文搜索 */
  ftsSearch(query: string, limit?: number): readonly VectorSearchResult[];
  /** 按路径获取块 */
  getChunksByPath(path: string): readonly ChunkEntry[];
  /** 删除路径下所有块 */
  deletePath(path: string): number;
  /** 获取统计信息 */
  getStats(): VectorStoreStats;
  /** 关闭数据库连接 */
  close(): void;
}

// ─── 初始化结果 ───

export interface VectorStoreInitResult {
  readonly vectorAvailable: boolean;
  readonly ftsAvailable: boolean;
  readonly ftsError?: string | undefined;
  readonly vectorError?: string | undefined;
}

// ─── 创建向量存储 ───

export function createVectorStore(
  db: Database,
  config?: VectorStoreConfig,
): VectorStore {
  const dimensions = config?.dimensions ?? 1536;
  const maxSearchResults = config?.maxSearchResults ?? 20;
  const similarityThreshold = config?.similarityThreshold ?? 0.3;
  const embeddingProvider = config?.embeddingProvider;

  let initialized = false;
  let vectorAvailable = false;
  let ftsAvailable = false;
  let ftsError: string | undefined;
  let vectorError: string | undefined;

  let cacheHits = 0;
  let cacheMisses = 0;

  const ftsTable = config?.schemaConfig?.ftsTable ?? "chunks_fts";
  const cacheTable = config?.schemaConfig?.embeddingCacheTable ?? "embedding_cache";

  // ── 初始化 ──

  async function initialize(): Promise<VectorStoreInitResult> {
    if (initialized) {
      return { vectorAvailable, ftsAvailable, ftsError, vectorError };
    }

    // 1. 创建 Schema
    const schemaResult: MemorySchemaResult = ensureMemoryIndexSchema(db, {
      ...config?.schemaConfig,
      ftsEnabled: true,
    });
    ftsAvailable = schemaResult.ftsAvailable;
    ftsError = schemaResult.ftsError;

    // 2. 尝试加载 sqlite-vec
    if (embeddingProvider) {
      const loadResult = await loadSqliteVecExtension(db, config?.extensionPath);
      if (loadResult.ok) {
        // 创建向量虚拟表
        try {
          db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
              id TEXT PRIMARY KEY,
              embedding float[${dimensions}]
            );
          `);
          vectorAvailable = true;
        } catch (err) {
          vectorAvailable = false;
          vectorError = err instanceof Error ? err.message : String(err);
        }
      } else {
        vectorAvailable = false;
        vectorError = loadResult.error;
      }
    }

    initialized = true;
    return { vectorAvailable, ftsAvailable, ftsError, vectorError };
  }

  // ── 索引单个块 ──

  async function indexChunk(chunk: ChunkEntry): Promise<void> {
    // 如果有 embedding provider 且块还没有 embedding，生成一个
    let embeddingStr = chunk.embedding;

    if (
      embeddingProvider &&
      (!embeddingStr || embeddingStr === "[]")
    ) {
      embeddingStr = await generateAndCacheEmbedding(chunk);
    }

    const enrichedChunk: ChunkEntry = {
      ...chunk,
      embedding: embeddingStr,
    };

    upsertChunk(db, enrichedChunk);

    // 同步到 FTS5
    if (ftsAvailable) {
      try {
        db.prepare(
          `INSERT INTO ${ftsTable} (text, id, path, source, model, start_line, end_line)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET text = excluded.text`,
        ).run(
          enrichedChunk.text,
          enrichedChunk.id,
          enrichedChunk.path,
          enrichedChunk.source,
          enrichedChunk.model,
          enrichedChunk.startLine,
          enrichedChunk.endLine,
        );
      } catch {
        // FTS5 同步失败不影响主流程
      }
    }

    // 同步到向量索引
    if (vectorAvailable && embeddingStr && embeddingStr !== "[]") {
      try {
        db.prepare(
          `INSERT INTO chunks_vec (id, embedding)
           VALUES (?, ?)
           ON CONFLICT(id) DO UPDATE SET embedding = excluded.embedding`,
        ).run(enrichedChunk.id, serializeEmbedding(embeddingStr));
      } catch {
        // 向量索引同步失败不影响主流程
      }
    }
  }

  // ── 批量索引 ──

  async function indexChunks(chunks: readonly ChunkEntry[]): Promise<void> {
    for (const chunk of chunks) {
      await indexChunk(chunk);
    }
  }

  // ── 向量搜索 ──

  async function search(
    query: string,
    limit?: number,
  ): Promise<readonly VectorSearchResult[]> {
    if (!initialized) {
      await initialize();
    }

    const maxResults = limit ?? maxSearchResults;
    const results: VectorSearchResult[] = [];

    // 策略 1：向量搜索（如果可用）
    if (vectorAvailable && embeddingProvider) {
      try {
        const queryEmbedding = await getQueryEmbedding(query);
        if (queryEmbedding) {
          const vectorResults = vectorKNNSearch(queryEmbedding, maxResults);
          for (const vr of vectorResults) {
            if (vr.score >= similarityThreshold) {
              results.push({ chunk: vr.chunk, score: vr.score, searchMethod: "vector" });
            }
          }
        }
      } catch {
        // 向量搜索失败，继续尝试 FTS
      }
    }

    // 策略 2：FTS5 全文搜索（补充或替代）
    if (ftsAvailable && results.length < maxResults) {
      try {
        const ftsResults = ftsSearchResults(query, maxResults - results.length);
        // 去重：已通过向量搜索返回的不再重复
        const existingIds = new Set(results.map((r) => r.chunk.id));
        for (const fr of ftsResults) {
          if (!existingIds.has(fr.chunk.id)) {
            results.push(fr);
          }
        }
      } catch {
        // FTS 搜索失败
      }
    }

    // 策略 3：关键词回退（SQL LIKE）
    if (results.length === 0) {
      const keywordResults = keywordSearch(query, maxResults);
      for (const kr of keywordResults) {
        results.push(kr);
      }
    }

    // 按分数降序
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  // ── FTS5 搜索 ──

  function ftsSearchOnly(
    query: string,
    limit?: number,
  ): readonly VectorSearchResult[] {
    if (!initialized || !ftsAvailable) {
      return [];
    }
    return ftsSearchResults(query, limit ?? maxSearchResults);
  }

  // ── 按路径获取 ──

  function getChunksByPathOnly(path: string): readonly ChunkEntry[] {
    return getChunksByPath(db, path);
  }

  // ── 删除路径 ──

  function deletePathOnly(path: string): number {
    const deleted = deleteChunksByPath(db, path);
    // 清理 FTS5
    if (ftsAvailable) {
      try {
        db.prepare(`DELETE FROM ${ftsTable} WHERE path = ?`).run(path);
      } catch {
        // ignore
      }
    }
    // 清理向量索引
    if (vectorAvailable) {
      try {
        const chunks = getChunksByPath(db, path);
        for (const chunk of chunks) {
          db.prepare("DELETE FROM chunks_vec WHERE id = ?").run(chunk.id);
        }
      } catch {
        // ignore
      }
    }
    return deleted;
  }

  // ── 统计 ──

  function getStats(): VectorStoreStats {
    const totalChunks = (
      db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number }
    ).cnt;
    const totalPaths = (
      db.prepare("SELECT COUNT(DISTINCT path) as cnt FROM files").get() as { cnt: number }
    ).cnt;

    return {
      totalChunks,
      totalPaths,
      vectorSearchAvailable: vectorAvailable,
      ftsAvailable,
      embeddingCacheHits: cacheHits,
      embeddingCacheMisses: cacheMisses,
    };
  }

  // ── 关闭 ──

  function close(): void {
    // Database 由调用方管理生命周期
    initialized = false;
  }

  // ═══════════════════════════════════════════════════════════
  // 私有方法
  // ═══════════════════════════════════════════════════════════

  /** 加载 sqlite-vec 扩展 */
  async function loadSqliteVecExtension(
    database: Database,
    extensionPath?: string,
  ): Promise<SqliteVecLoadResult> {
    try {
      // sqlite-vec 是可选依赖，动态加载
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require("sqlite-vec") as unknown as SqliteVecModule;
      const resolvedPath = extensionPath ?? sqliteVec.getLoadablePath?.();

      // bun:sqlite 不需要 enableLoadExtension，直接 loadExtension
      if (resolvedPath) {
        database.loadExtension(resolvedPath);
      } else if (typeof sqliteVec.load === "function") {
        sqliteVec.load(database);
      } else {
        return {
          ok: false,
          error: "sqlite-vec loaded but no load method or path available",
        };
      }

      return { ok: true, extensionPath: resolvedPath };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 生成嵌入向量并缓存 */
  async function generateAndCacheEmbedding(
    chunk: ChunkEntry,
  ): Promise<string> {
    if (!embeddingProvider) return "[]";

    const cacheKey = chunk.hash;
    const cacheEntry = getCachedEmbedding(
      db,
      cacheTable,
      embeddingProvider.name,
      embeddingProvider.name,
      "",
      cacheKey,
    );

    if (cacheEntry) {
      cacheHits++;
      return cacheEntry.embedding;
    }

    cacheMisses++;
    const result = await embeddingProvider.embed(chunk.text);

    // 缓存
    if (config?.schemaConfig?.cacheEnabled) {
      try {
        setCachedEmbedding(db, cacheTable, {
          provider: embeddingProvider.name,
          model: result.model,
          providerKey: "",
          hash: cacheKey,
          embedding: JSON.stringify(result.embedding),
          dims: result.dims,
          updatedAt: Date.now(),
        });
      } catch (e) {
        // 缓存写入失败不影响主流程
        console.warn("[VectorStore] Failed to cache embedding:", e);
      }
    }

    return JSON.stringify(result.embedding);
  }

  /** 获取查询的嵌入向量 */
  async function getQueryEmbedding(
    query: string,
  ): Promise<number[] | undefined> {
    if (!embeddingProvider) return undefined;

    const cacheKey = `query:${query}`;
    const cacheEntry = getCachedEmbedding(
      db,
      cacheTable,
      embeddingProvider.name,
      embeddingProvider.name,
      "",
      cacheKey,
    );

    if (cacheEntry) {
      cacheHits++;
      try {
        return JSON.parse(cacheEntry.embedding) as number[];
      } catch {
        return undefined;
      }
    }

    cacheMisses++;
    const result = await embeddingProvider.embed(query);

    if (config?.schemaConfig?.cacheEnabled) {
      setCachedEmbedding(db, cacheTable, {
        provider: embeddingProvider.name,
        model: result.model,
        providerKey: "",
        hash: cacheKey,
        embedding: JSON.stringify(result.embedding),
        dims: result.dims,
        updatedAt: Date.now(),
      });
    }

    return result.embedding;
  }

  /**
   * sqlite-vec KNN 搜索。
   *
   * ⚠️ 距离语义说明：
   * sqlite-vec ≥ 0.1.0 的 vec0 表返回 **L2 欧氏距离**（非 L2 平方距离）。
   * 对于归一化单位向量（如 OpenAI text-embedding-3-small 输出），
   * 余弦距离 = L2² / 2，即：cosine_similarity ≈ 1 - distance² / 2。
   *
   * 若升级 sqlite-vec 版本，需验证 distance 语义未变化。
   * 参考测试：tests/knowledge/vector-store.test.ts → "distance semantics"。
   */
  function vectorKNNSearch(
    queryEmbedding: number[],
    limit: number,
  ): ReadonlyArray<{ chunk: ChunkEntry; score: number }> {
    if (!vectorAvailable) return [];

    try {
      const serialized = serializeEmbedding(JSON.stringify(queryEmbedding));
      const rows = db
        .prepare(
          `SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.hash, c.model, c.text, c.embedding, c.updated_at, v.distance
           FROM chunks_vec v
           JOIN chunks c ON c.id = v.id
           WHERE v.embedding MATCH ?
           ORDER BY v.distance
           LIMIT ?`,
        )
        .all(serialized, limit) as unknown as ReadonlyArray<
        ChunkEntry & { distance: number }
      >;

      return rows.map((row) => ({
        chunk: row,
        // sqlite-vec 返回欧氏距离，转换为余弦相似度近似值
        score: distanceToSimilarity(row.distance),
      }));
    } catch {
      return [];
    }
  }

  /** FTS5 搜索结果 */
  function ftsSearchResults(
    query: string,
    limit: number,
  ): readonly VectorSearchResult[] {
    const chunks = ftsSearch(db, ftsTable, query, limit);
    return chunks.map((chunk) => ({
      chunk,
      score: 0.5, // FTS 搜索无精确分数，使用固定中等分数
      searchMethod: "fts" as const,
    }));
  }

  /** 关键词搜索回退 */
  function keywordSearch(
    query: string,
    limit: number,
  ): readonly VectorSearchResult[] {
    const escapedQuery = query.replace(/[%_\\]/g, "\\$&");
    const pattern = `%${escapedQuery}%`;
    const rows = db
      .prepare(
        `SELECT id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
         FROM chunks
         WHERE text LIKE ? ESCAPE '\\'
         LIMIT ?`,
      )
      .all(pattern, limit) as unknown as ChunkEntry[];

    return rows.map((chunk) => ({
      chunk,
      score: 0.2, // 关键词搜索最低分数
      searchMethod: "keyword" as const,
    }));
  }

  /** 序列化嵌入向量为 sqlite-vec 格式 */
  function serializeEmbedding(jsonStr: string): string {
    try {
      const arr = JSON.parse(jsonStr) as number[];
      // sqlite-vec 期望 '[0.1, 0.2, ...]' 格式
      return `[${arr.join(",")}]`;
    } catch {
      return "[]";
    }
  }

  /** 欧氏距离转余弦相似度近似值 */
  function distanceToSimilarity(distance: number): number {
    // 对于归一化向量，余弦距离 ≈ 欧氏距离² / 2
    // 余弦相似度 = 1 - 余弦距离
    const cosineDistance = (distance * distance) / 2;
    return Math.max(0, 1 - cosineDistance);
  }

  return {
    initialize,
    indexChunk,
    indexChunks,
    search,
    ftsSearch: ftsSearchOnly,
    getChunksByPath: getChunksByPathOnly,
    deletePath: deletePathOnly,
    getStats,
    close,
  };
}

// ─── 工厂函数：创建内存向量存储（测试用） ───

export function createInMemoryVectorStore(
  config?: VectorStoreConfig,
): VectorStore {
  // 使用 :memory: SQLite 数据库
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database: BunDatabase } = require("bun:sqlite");
  const db = new BunDatabase(":memory:");
  return createVectorStore(db, config);
}
