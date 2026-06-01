/**
 * KnowledgeManager — 知识管理器 + 混合检索。
 *
 * 整合记忆存储、TF-IDF 检索、关键词匹配和时间衰减。
 * 支持知识注入到 LLM 上下文。
 *
 * 管线#6 修复：
 * - MemoryStore 注入：记忆通过 JSONL 持久化后端存储
 * - 内部缓存：同步读 + 防抖异步写
 */

import type { MemoryEntry, MemoryType } from "./memory-types";
import { halfLifeDecay } from "./memory-age";
import { extractKeywords } from "./keywords";
import { getMemoryWeight, getMemoryCategory } from "./memory-types";
import type { SimpleLLMProvider } from "../llm/adapter";
import type { MemoryStore } from "./knowledge-store";
import { createJSONLMemoryStore, createMemoryMemoryStore } from "./knowledge-store";
import { extractJSONArray, safeJSONParse } from "../utils/llm-parse";
import { LRUCache } from "../utils/lru-cache";

// ─── 检索配置 ───

export interface KnowledgeSearchConfig {
  readonly maxResults?: number;
  readonly minScore?: number;
  readonly halfLifeDays?: number;
  readonly typeFilter?: readonly MemoryType[];
}

// ─── 检索结果 ───

export interface KnowledgeSearchResult {
  readonly entry: MemoryEntry;
  readonly score: number;
  readonly matchMethod: "tfidf" | "keyword" | "exact";
  readonly freshnessNote: string;
}

// ─── 知识注入结果 ───

export interface KnowledgeInjectionResult {
  readonly systemPromptAddition: string;
  readonly injectedCount: number;
  readonly totalAvailable: number;
}

// ─── KnowledgeManager 配置 ───

export interface KnowledgeManagerConfig {
  readonly llmProvider?: SimpleLLMProvider;
  readonly memoryStore?: MemoryStore;
}

// ─── KnowledgeManager ───

export interface KnowledgeManager {
  store(entry: MemoryEntry): void;
  get(id: string): MemoryEntry | undefined;
  delete(id: string): boolean;
  getAll(): readonly MemoryEntry[];
  search(query: string, config?: KnowledgeSearchConfig): readonly KnowledgeSearchResult[];
  injectForContext(query: string, maxTokens?: number): KnowledgeInjectionResult;
  count(): number;
  clear(): void;
  deleteByCategory(category: "instruction" | "learning"): number;
  evictLearningMemories(maxCount?: number, minScore?: number): number;
  loadFromStore(): Promise<void>;
  flush(): Promise<void>;
}

// ─── 创建 KnowledgeManager ───

export function createKnowledgeManager(config?: KnowledgeManagerConfig): KnowledgeManager {
  const persistentStore = config?.memoryStore ?? createMemoryMemoryStore();
  const llmProvider = config?.llmProvider;

  const memoryCache = new Map<string, MemoryEntry>();

  const llmSemanticCache = new LRUCache<readonly string[]>({ maxSize: 1000, ttlMs: 30 * 60 * 1000 });

  const inFlightLLMRequests = new Map<string, Promise<readonly string[]>>();

  const injectedMemoryIds = new Set<string>();

  // TF-IDF 索引（简化版）
  const documentFrequencies = new Map<string, number>();
  let totalDocuments = 0;

  async function loadFromStore(): Promise<void> {
    const entries = await persistentStore.getAll();
    memoryCache.clear();
    documentFrequencies.clear();
    totalDocuments = 0;
    for (const entry of entries) {
      memoryCache.set(entry.id, entry);
      updateIndex(entry);
    }
  }

  function store(entry: MemoryEntry): void {
    memoryCache.set(entry.id, entry);
    updateIndex(entry);
    llmSemanticCache.clear();
    void persistentStore.store(entry);
  }

  function get(id: string): MemoryEntry | undefined {
    return memoryCache.get(id);
  }

  function removeEntry(id: string): boolean {
    const existed = memoryCache.delete(id);
    if (existed) {
      llmSemanticCache.clear();
      void persistentStore.delete(id);
    }
    return existed;
  }

  function getAll(): readonly MemoryEntry[] {
    return Array.from(memoryCache.values());
  }

  function count(): number {
    return memoryCache.size;
  }

  function clear(): void {
    memoryCache.clear();
    documentFrequencies.clear();
    totalDocuments = 0;
    llmSemanticCache.clear();
    inFlightLLMRequests.clear();
    injectedMemoryIds.clear();
    void persistentStore.clear();
  }

  function search(
    query: string,
    config?: KnowledgeSearchConfig,
  ): readonly KnowledgeSearchResult[] {
    const maxResults = config?.maxResults ?? 10;
    const minScore = config?.minScore ?? 0.1;
    const halfLifeDays = config?.halfLifeDays ?? 30;
    const typeFilter = config?.typeFilter;

    const queryKeywords = extractKeywords(query);
    if (queryKeywords.length === 0 && query.trim().length > 0) {
      queryKeywords.push(query.toLowerCase().trim());
    }

    // C6: LLM 语义增强 — 去重并发请求
    const normalizedQuery = query.toLowerCase().trim();
    const cachedSemantics = llmSemanticCache.get(normalizedQuery);
    const hasLLMSemantics = cachedSemantics !== undefined;

    if (llmProvider && query.trim().length > 0 && !hasLLMSemantics) {
      const existing = inFlightLLMRequests.get(normalizedQuery);
      if (existing === undefined) {
        const request = (async (): Promise<readonly string[]> => {
          try {
            const response = await llmProvider.invoke([
              { role: "system", content: "Extract key semantic concepts from this knowledge search query. Return a JSON array of keywords/phrases. Use English field names in JSON output." },
              { role: "user", content: query },
            ], { temperature: 0 });

            const jsonStr = extractJSONArray(response);
            if (jsonStr === null) {
              console.warn(`[KNOWLEDGE] LLM semantic extraction returned non-JSON response for query "${normalizedQuery.slice(0, 50)}"`);
              return [];
            }

            const rawParsed = safeJSONParse(jsonStr);
            if (Array.isArray(rawParsed)) {
              const keywords = rawParsed
                .filter((item): item is string => typeof item === "string")
                .map((s) => s.toLowerCase().trim())
                .filter((s) => s.length > 0);
              llmSemanticCache.set(normalizedQuery, keywords);
              return keywords;
            }
            console.warn(`[KNOWLEDGE] LLM semantic extraction returned non-array JSON for query "${normalizedQuery.slice(0, 50)}"`);
            return [];
          } catch (err) {
            console.warn(`[KNOWLEDGE] LLM semantic extraction failed for query "${normalizedQuery.slice(0, 50)}": ${err instanceof Error ? err.message : String(err)}`);
            return [];
          } finally {
            inFlightLLMRequests.delete(normalizedQuery);
          }
        })();
        inFlightLLMRequests.set(normalizedQuery, request);
        void request;
      }
    }

    const effectiveKeywords = hasLLMSemantics && cachedSemantics!.length > 0
      ? [...queryKeywords, ...cachedSemantics!]
      : queryKeywords;

    const results: KnowledgeSearchResult[] = [];

    for (const entry of memoryCache.values()) {
      if (typeFilter && !typeFilter.includes(entry.type)) continue;

      const tfidfScore = computeTFIDF(entry, effectiveKeywords);
      const keywordScore = computeKeywordMatch(entry, effectiveKeywords);
      const exactScore = computeExactMatch(entry, query);

      const bestScore = Math.max(tfidfScore, keywordScore, exactScore);
      if (bestScore < minScore) continue;

      const decay = halfLifeDecay(entry.mtimeMs, halfLifeDays);
      const weight = getMemoryWeight(entry.type);
      const finalScore = bestScore * decay * weight;

      let matchMethod: "tfidf" | "keyword" | "exact";
      if (exactScore >= keywordScore && exactScore >= tfidfScore) {
        matchMethod = "exact";
      } else if (keywordScore >= tfidfScore) {
        matchMethod = "keyword";
      } else {
        matchMethod = "tfidf";
      }

      const ageDays = Math.floor((Date.now() - entry.mtimeMs) / 86_400_000);
      const freshnessNote = ageDays > 1
        ? `[${ageDays} days old - verify before use]`
        : "";

      results.push({
        entry,
        score: finalScore,
        matchMethod,
        freshnessNote,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  function estimateCharsPerToken(text: string): number {
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f]/gu) ?? []).length;
    const ratio = text.length > 0 ? cjkCount / text.length : 0;
    return 4.0 * (1 - ratio) + 2.0 * ratio;
  }

  function injectForContext(
    query: string,
    maxTokens?: number,
  ): KnowledgeInjectionResult {
    const results = search(query, { maxResults: 5 });
    const dedupedResults = results.filter((r) => !injectedMemoryIds.has(r.entry.id));
    const allText = dedupedResults.map((r) => `${r.entry.title} ${r.entry.content}`).join(" ");
    const charsPerToken = estimateCharsPerToken(allText);
    const maxChars = (maxTokens ?? 2000) * charsPerToken;

    if (dedupedResults.length === 0) {
      return {
        systemPromptAddition: "",
        injectedCount: 0,
        totalAvailable: memoryCache.size,
      };
    }

    const sections: string[] = [
      "<knowledge-context>",
      "The following knowledge may be relevant to the current query:",
      "",
    ];

    let totalChars = 0;
    let injected = 0;

    for (const result of dedupedResults) {
      const block = formatKnowledgeBlock(result);
      if (totalChars + block.length > maxChars) break;
      sections.push(block);
      totalChars += block.length;
      injected++;
      injectedMemoryIds.add(result.entry.id);
    }

    sections.push("", "</knowledge-context>");

    return {
      systemPromptAddition: sections.join("\n"),
      injectedCount: injected,
      totalAvailable: memoryCache.size,
    };
  }

  // ─── 私有方法 ───

  function updateIndex(entry: MemoryEntry): void {
    totalDocuments++;
    const words = extractKeywords(`${entry.title} ${entry.content}`);
    const uniqueWords = new Set(words);

    for (const word of uniqueWords) {
      documentFrequencies.set(word, (documentFrequencies.get(word) ?? 0) + 1);
    }
  }

  function computeTFIDF(entry: MemoryEntry, queryKeywords: readonly string[]): number {
    const docWords = extractKeywords(`${entry.title} ${entry.content}`);
    const docTermFreq = new Map<string, number>();
    for (const word of docWords) {
      docTermFreq.set(word, (docTermFreq.get(word) ?? 0) + 1);
    }

    let score = 0;
    for (const keyword of queryKeywords) {
      const tf = (docTermFreq.get(keyword) ?? 0) / Math.max(docWords.length, 1);
      const df = documentFrequencies.get(keyword) ?? 0;
      const idf = totalDocuments > 0 && df > 0
        ? Math.log((totalDocuments + 1) / (df + 1)) + 1
        : 1;
      score += tf * idf;
    }

    return queryKeywords.length > 0 ? score / queryKeywords.length : 0;
  }

  function computeKeywordMatch(entry: MemoryEntry, queryKeywords: readonly string[]): number {
    const entryText = `${entry.title} ${entry.content}`.toLowerCase();
    let matches = 0;
    for (const keyword of queryKeywords) {
      if (entryText.includes(keyword)) matches++;
    }
    return queryKeywords.length > 0 ? matches / queryKeywords.length : 0;
  }

  function computeExactMatch(entry: MemoryEntry, query: string): number {
    const entryText = `${entry.title} ${entry.content}`.toLowerCase();
    const normalizedQuery = query.toLowerCase().trim();
    if (entryText.includes(normalizedQuery)) return 1.0;
    return 0;
  }

  function formatKnowledgeBlock(result: KnowledgeSearchResult): string {
    const { entry, score, matchMethod, freshnessNote } = result;
    return [
      `[${entry.type}] ${entry.title} (score: ${score.toFixed(2)}, ${matchMethod})`,
      freshnessNote ? `  ${freshnessNote}` : "",
      `  ${entry.content.slice(0, 300)}${entry.content.length > 300 ? "..." : ""}`,
    ].filter(Boolean).join("\n");
  }

  function deleteByCategory(category: "instruction" | "learning"): number {
    let deleted = 0;
    for (const [id, entry] of memoryCache) {
      if (getMemoryCategory(entry.type) === category) {
        memoryCache.delete(id);
        void persistentStore.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  function evictLearningMemories(maxCount?: number, minScore?: number): number {
    const limit = maxCount ?? 10;
    const threshold = minScore ?? 0.1;
    let evicted = 0;

    const learningEntries: Array<{ id: string; entry: MemoryEntry; score: number }> = [];
    for (const [id, entry] of memoryCache) {
      if (getMemoryCategory(entry.type) === "learning") {
        const decay = halfLifeDecay(entry.mtimeMs, 30);
        const score = entry.confidence * decay;
        learningEntries.push({ id, entry, score });
      }
    }

    learningEntries.sort((a, b) => a.score - b.score);

    for (const { id, score } of learningEntries) {
      if (evicted >= limit) break;
      if (score < threshold) {
        memoryCache.delete(id);
        void persistentStore.delete(id);
        evicted++;
      }
    }

    return evicted;
  }

  async function flushStore(): Promise<void> {
    await persistentStore.flush();
  }

  return {
    store,
    get,
    delete: removeEntry,
    getAll,
    search,
    injectForContext,
    count,
    clear,
    deleteByCategory,
    evictLearningMemories,
    loadFromStore,
    flush: flushStore,
  };
}

export { createJSONLMemoryStore, createMemoryMemoryStore } from "./knowledge-store";
