/**
 * 记忆索引 Schema — SQLite 表结构定义。
 *
 * 参考 `代码片段_记忆系统与知识管理补充.md` 片段 #5。
 * 核心表：meta / files / chunks / embedding_cache（可选）/ FTS5（可选）。
 *
 * 设计原则：
 * - 优雅降级：FTS5 创建失败时返回 ftsAvailable: false
 * - Schema 迁移：ensureColumn() 向前兼容
 * - 所有 SQL 参数化或使用固定表名（无用户输入拼接）
 */

import { Database } from "bun:sqlite";

// ─── Schema 配置 ───

export interface MemorySchemaConfig {
  /** 嵌入缓存表名 */
  readonly embeddingCacheTable?: string;
  /** 是否启用嵌入缓存表 */
  readonly cacheEnabled?: boolean;
  /** FTS5 表名 */
  readonly ftsTable?: string;
  /** 是否启用 FTS5 全文搜索 */
  readonly ftsEnabled?: boolean;
  /** FTS5 分词器 */
  readonly ftsTokenizer?: "unicode61" | "trigram";
}

// ─── Schema 初始化结果 ───

export interface MemorySchemaResult {
  readonly ftsAvailable: boolean;
  readonly ftsError?: string;
}

// ─── 表名常量 ───

const DEFAULT_CACHE_TABLE = "embedding_cache";
const DEFAULT_FTS_TABLE = "chunks_fts";

// ─── 确保记忆索引 Schema ───

export function ensureMemoryIndexSchema(
  db: Database,
  config?: MemorySchemaConfig,
): MemorySchemaResult {
  const cacheTable = config?.embeddingCacheTable ?? DEFAULT_CACHE_TABLE;
  const cacheEnabled = config?.cacheEnabled ?? false;
  const ftsTable = config?.ftsTable ?? DEFAULT_FTS_TABLE;
  const ftsEnabled = config?.ftsEnabled ?? false;

  // ── meta 表 ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // ── files 表 ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);

  // ── chunks 表 ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // ── embedding_cache 表（可选） ──
  if (cacheEnabled) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${cacheTable} (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, hash)
      );
    `);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${cacheTable}(updated_at);`,
    );
  }

  // ── FTS5 虚拟表（可选，优雅降级） ──
  let ftsAvailable = false;
  let ftsError: string | undefined;

  if (ftsEnabled) {
    try {
      const tokenizer = config?.ftsTokenizer ?? "unicode61";
      const tokenizeClause =
        tokenizer === "trigram"
          ? `, tokenize='trigram case_sensitive 0'`
          : "";
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable} USING fts5(\n` +
          `  text,\n` +
          `  id UNINDEXED,\n` +
          `  path UNINDEXED,\n` +
          `  source UNINDEXED,\n` +
          `  model UNINDEXED,\n` +
          `  start_line UNINDEXED,\n` +
          `  end_line UNINDEXED\n` +
          `${tokenizeClause});`,
      );
      ftsAvailable = true;
    } catch (err) {
      ftsAvailable = false;
      ftsError = err instanceof Error ? err.message : String(err);
    }
  }

  // ── Schema 迁移：确保新增列存在 ──
  ensureColumn(db, "files", "source", "TEXT NOT NULL DEFAULT 'memory'");
  ensureColumn(db, "chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");

  // ── 索引 ──
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);

  return { ftsAvailable, ...(ftsError ? { ftsError } : {}) };
}

// ─── 列迁移辅助 ───

function ensureColumn(
  db: Database,
  table: "files" | "chunks",
  column: string,
  definition: string,
): void {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as ReadonlyArray<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// ─── 元数据读写 ───

export function getMeta(db: Database, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

// ─── 文件索引操作 ───

export interface FileIndexEntry {
  readonly path: string;
  readonly source: string;
  readonly hash: string;
  readonly mtime: number;
  readonly size: number;
}

export function upsertFileIndex(
  db: Database,
  entry: FileIndexEntry,
): void {
  db.prepare(
    `INSERT INTO files (path, source, hash, mtime, size)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET source = excluded.source, hash = excluded.hash, mtime = excluded.mtime, size = excluded.size`,
  ).run(entry.path, entry.source, entry.hash, entry.mtime, entry.size);
}

export function getFileIndex(
  db: Database,
  path: string,
): FileIndexEntry | undefined {
  const row = db
    .prepare("SELECT path, source, hash, mtime, size FROM files WHERE path = ?")
    .get(path) as unknown as FileIndexEntry | null;
  return row ?? undefined;
}

// ─── Chunk 操作 ───

export interface ChunkEntry {
  readonly id: string;
  readonly path: string;
  readonly source: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly hash: string;
  readonly model: string;
  readonly text: string;
  readonly embedding: string;
  readonly updatedAt: number;
}

export function upsertChunk(db: Database, chunk: ChunkEntry): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET text = excluded.text, embedding = excluded.embedding, updated_at = excluded.updated_at`,
  ).run(
    chunk.id,
    chunk.path,
    chunk.source,
    chunk.startLine,
    chunk.endLine,
    chunk.hash,
    chunk.model,
    chunk.text,
    chunk.embedding,
    chunk.updatedAt,
  );
}

export function getChunksByPath(
  db: Database,
  path: string,
): readonly ChunkEntry[] {
  return db
    .prepare(
      "SELECT id, path, source, start_line, end_line, hash, model, text, embedding, updated_at FROM chunks WHERE path = ?",
    )
    .all(path) as unknown as ChunkEntry[];
}

export function deleteChunksByPath(db: Database, path: string): number {
  const result = db
    .prepare("DELETE FROM chunks WHERE path = ?")
    .run(path);
  return Number(result.changes);
}

// ─── FTS5 全文搜索 ───

export function ftsSearch(
  db: Database,
  ftsTable: string,
  query: string,
  limit?: number,
): readonly ChunkEntry[] {
  const maxResults = limit ?? 20;
  // FTS5 MATCH 语法：使用简单词组匹配
  const safeQuery = query.replace(/['"]/g, "");
  return db
    .prepare(
      `SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.hash, c.model, c.text, c.embedding, c.updated_at
       FROM ${ftsTable} f
       JOIN chunks c ON c.id = f.id
       WHERE ${ftsTable} MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(safeQuery, maxResults) as unknown as ChunkEntry[];
}

// ─── 嵌入缓存操作 ───

export interface EmbeddingCacheEntry {
  readonly provider: string;
  readonly model: string;
  readonly providerKey: string;
  readonly hash: string;
  readonly embedding: string;
  readonly dims?: number;
  readonly updatedAt: number;
}

export function getCachedEmbedding(
  db: Database,
  cacheTable: string,
  provider: string,
  model: string,
  providerKey: string,
  hash: string,
): EmbeddingCacheEntry | undefined {
  const row = db
    .prepare(
      `SELECT provider, model, provider_key, hash, embedding, dims, updated_at
       FROM ${cacheTable}
       WHERE provider = ? AND model = ? AND provider_key = ? AND hash = ?`,
    )
    .get(provider, model, providerKey, hash) as unknown as EmbeddingCacheEntry | null;
  return row ?? undefined;
}

export function setCachedEmbedding(
  db: Database,
  cacheTable: string,
  entry: EmbeddingCacheEntry,
): void {
  db.prepare(
    `INSERT INTO ${cacheTable} (provider, model, provider_key, hash, embedding, dims, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET embedding = excluded.embedding, dims = excluded.dims, updated_at = excluded.updated_at`,
  ).run(
    entry.provider,
    entry.model,
    entry.providerKey,
    entry.hash,
    entry.embedding,
    entry.dims ?? null,
    entry.updatedAt,
  );
}
