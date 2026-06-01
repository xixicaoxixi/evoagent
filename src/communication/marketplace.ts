/**
 * Marketplace — 实例市场。
 *
 * 规则/知识/工具模板的发布、搜索、评分、订阅。
 */

import type { SimpleLLMProvider } from "../llm/adapter";
import { measureObjectDepth } from "../utils/object";

// ─── 条目类型 ───

export type MarketItemType = "rule" | "knowledge" | "tool_template";

// ─── 条目状态 ───

export type MarketItemStatus = "active" | "deprecated" | "removed";

// ─── 难度 ───

export type MarketDifficulty = "beginner" | "intermediate" | "advanced";

// ─── 分类白名单 ───

const CATEGORY_WHITELIST = new Set([
  "task_planning",
  "code_execution",
  "communication",
  "meta_evolution",
  "knowledge",
  "tool_template",
  "general",
]);

// ─── MarketItem ───

export interface MarketItem {
  readonly itemId: string;
  readonly itemType: MarketItemType;
  readonly title: string;
  readonly description: string;
  readonly authorId: string;
  readonly content: Record<string, unknown>;
  readonly tags: readonly string[];
  readonly category: string;
  readonly difficulty: MarketDifficulty;
  readonly downloads: number;
  readonly ratingSum: number;
  readonly ratingCount: number;
  readonly status: MarketItemStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ─── 搜索选项 ───

export interface MarketSearchOptions {
  readonly query?: string;
  readonly category?: string;
  readonly itemType?: MarketItemType;
  readonly difficulty?: MarketDifficulty;
  readonly sortBy?: "popularity" | "newest" | "rating" | "downloads";
  readonly limit?: number;
  readonly offset?: number;
}

// ─── Marketplace 接口 ───

export interface Marketplace {
  publish(input: {
    itemType: MarketItemType;
    title: string;
    description: string;
    authorId: string;
    content: Record<string, unknown>;
    tags?: readonly string[];
    category: string;
    difficulty?: MarketDifficulty;
  }): MarketItem;

  search(options: MarketSearchOptions): readonly MarketItem[];
  getItem(itemId: string): MarketItem | null;
  getTrending(limit?: number): readonly MarketItem[];
  rateItem(itemId: string, rating: number, userId: string): boolean;
  subscribe(itemId: string, userId: string): boolean;
  unsubscribe(itemId: string, userId: string): boolean;
  getSubscriptions(userId: string): readonly MarketItem[];
  getItemsByAuthor(authorId: string): readonly MarketItem[];
  updateItem(itemId: string, authorId: string, updates: Partial<Pick<MarketItem, "title" | "description" | "content" | "tags" | "category" | "difficulty" | "status">>): boolean;
  removeItem(itemId: string, authorId: string): boolean;
  count(): number;
  clear(): void;
}

// ─── 创建 Marketplace ───

const MAX_ITEMS = 500;
const MAX_SUBSCRIPTIONS_PER_USER = 50;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_CONTENT_SIZE = 50_000;
const MAX_CONTENT_DEPTH = 10;
const MAX_CONTENT_KEYS = 200;
const MAX_TAGS_COUNT = 20;
const MAX_TAG_LENGTH = 50;

// ─── Marketplace 配置 ───

export interface MarketplaceConfig {
  readonly llmProvider?: SimpleLLMProvider;
}

export function createMarketplace(config?: MarketplaceConfig): Marketplace {
  const llmProvider = config?.llmProvider;
  const items = new Map<string, MarketItem>();
  const subscriptions = new Map<string, Set<string>>(); // userId -> Set<itemId>
  const ratings = new Map<string, Set<string>>(); // itemId -> Set<userId>
  const searchCache = new Map<string, readonly MarketItem[]>(); // query -> cached results

function validateContentStructure(content: Record<string, unknown>): string | undefined {
  const serialized = JSON.stringify(content);
  if (serialized.length > MAX_CONTENT_SIZE) {
    return `Content exceeds ${MAX_CONTENT_SIZE} bytes`;
  }
  const depth = measureObjectDepth(content, MAX_CONTENT_DEPTH);
  if (depth > MAX_CONTENT_DEPTH) {
    return `Content nesting depth exceeds ${MAX_CONTENT_DEPTH}`;
  }
  const keyCount = countKeys(content);
  if (keyCount > MAX_CONTENT_KEYS) {
    return `Content key count exceeds ${MAX_CONTENT_KEYS}`;
  }
  return undefined;
}

function countKeys(obj: unknown): number {
  if (obj === null || typeof obj !== "object") return 0;
  let count = Object.keys(obj as Record<string, unknown>).length;
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value !== null && typeof value === "object") {
      count += countKeys(value);
    }
  }
  return count;
}

function calculatePopularity(item: MarketItem): number {
    const ageHours = (Date.now() - item.createdAt) / (1000 * 60 * 60);
    const timeDecay = 1.0 / (1.0 + ageHours / 168); // 7 天半衰期
    const avgRating = item.ratingCount > 0 ? item.ratingSum / item.ratingCount : 0;
    return avgRating * Math.log(item.downloads + 1) * timeDecay;
  }

  function publish(input: {
    itemType: MarketItemType;
    title: string;
    description: string;
    authorId: string;
    content: Record<string, unknown>;
    tags?: readonly string[];
    category: string;
    difficulty?: MarketDifficulty;
  }): MarketItem {
    // 验证
    if (!CATEGORY_WHITELIST.has(input.category)) {
      throw new Error(`Invalid category: ${input.category}. Must be one of: ${[...CATEGORY_WHITELIST].join(", ")}`);
    }
    if (input.title.length > MAX_TITLE_LENGTH) {
      throw new Error(`Title exceeds ${MAX_TITLE_LENGTH} characters`);
    }
    if (input.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`Description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
    }

    // C.1: content 结构校验
    const contentError = validateContentStructure(input.content);
    if (contentError !== undefined) {
      throw new Error(contentError);
    }

    // C.1: tags 数量和长度校验
    if (input.tags !== undefined) {
      if (input.tags.length > MAX_TAGS_COUNT) {
        throw new Error(`Tags count exceeds ${MAX_TAGS_COUNT}`);
      }
      for (const tag of input.tags) {
        if (tag.length > MAX_TAG_LENGTH) {
          throw new Error(`Tag "${tag.slice(0, 20)}..." exceeds ${MAX_TAG_LENGTH} characters`);
        }
      }
    }

    // 容量限制
    if (items.size >= MAX_ITEMS) {
      const sorted = [...items.values()].sort(
        (a, b) => calculatePopularity(a) - calculatePopularity(b),
      );
      const toRemove = sorted.slice(0, 10);
      for (const item of toRemove) {
        items.delete(item.itemId);
      }
    }

    const now = Date.now();
    const item: MarketItem = {
      itemId: `market_${now}_${input.authorId.slice(0, 8)}`,
      itemType: input.itemType,
      title: input.title,
      description: input.description,
      authorId: input.authorId,
      content: input.content,
      tags: input.tags ?? [],
      category: input.category,
      difficulty: input.difficulty ?? "beginner",
      downloads: 0,
      ratingSum: 0,
      ratingCount: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    items.set(item.itemId, item);
    return item;
  }

  function search(options: MarketSearchOptions): readonly MarketItem[] {
    let results = [...items.values()].filter(
      (item) => item.status === "active",
    );

    // 过滤
    if (options.itemType !== undefined) {
      results = results.filter((i) => i.itemType === options.itemType);
    }
    if (options.category !== undefined) {
      results = results.filter((i) => i.category === options.category);
    }
    if (options.difficulty !== undefined) {
      results = results.filter((i) => i.difficulty === options.difficulty);
    }
    if (options.query !== undefined) {
      const q = options.query.toLowerCase();
      results = results.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          i.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    // 排序
    const sortBy = options.sortBy ?? "popularity";
    switch (sortBy) {
      case "popularity":
        results.sort((a, b) => calculatePopularity(b) - calculatePopularity(a));
        break;
      case "newest":
        results.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case "rating":
        results.sort((a, b) => {
          const avgA = a.ratingCount > 0 ? a.ratingSum / a.ratingCount : 0;
          const avgB = b.ratingCount > 0 ? b.ratingSum / b.ratingCount : 0;
          return avgB - avgA;
        });
        break;
      case "downloads":
        results.sort((a, b) => b.downloads - a.downloads);
        break;
    }

    // 分页
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 20;
    const paged = results.slice(offset, offset + limit);

    // LLM 语义重排序（fire-and-forget + 缓存模式）
    if (llmProvider !== undefined && options.query !== undefined && options.query.length > 0) {
      const cacheKey = options.query;
      const cached = searchCache.get(cacheKey);
      if (cached !== undefined) {
        return cached.slice(offset, offset + limit);
      }

      void llmProvider.invoke([
        { role: "system", content: "Given a search query and a list of items (title: description), return the item indices in order of relevance as a comma-separated list. Only include indices of relevant items." },
        { role: "user", content: `Query: "${options.query}"\n\nItems:\n${results.map((r, i) => `${i}: ${r.title}: ${r.description}`).join("\n")}` },
      ]).then((response) => {
        const indices = response.trim().split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n) && n >= 0 && n < results.length);
        if (indices.length > 0) {
          const reordered = indices.map((i) => results[i]!);
          searchCache.set(cacheKey, reordered);
        }
      }).catch(() => {
        // fire-and-forget: LLM 失败时忽略
      });
    }

    return paged;
  }

  function getItem(itemId: string): MarketItem | null {
    return items.get(itemId) ?? null;
  }

  function getTrending(limit?: number): readonly MarketItem[] {
    const active = [...items.values()].filter((i) => i.status === "active");
    active.sort((a, b) => calculatePopularity(b) - calculatePopularity(a));
    return active.slice(0, limit ?? 10);
  }

  function rateItem(itemId: string, rating: number, userId: string): boolean {
    const item = items.get(itemId);
    if (item === undefined || item.status !== "active") return false;

    const userRatings = ratings.get(itemId) ?? new Set();
    if (userRatings.has(userId)) return false; // 每用户只能评一次

    userRatings.add(userId);
    ratings.set(itemId, userRatings);

    // 不可变更新
    const updated: MarketItem = {
      ...item,
      ratingSum: item.ratingSum + rating,
      ratingCount: item.ratingCount + 1,
      updatedAt: Date.now(),
    };
    items.set(itemId, updated);
    return true;
  }

  function subscribe(itemId: string, userId: string): boolean {
    const item = items.get(itemId);
    if (item === undefined) return false;

    const userSubs = subscriptions.get(userId) ?? new Set();
    if (userSubs.size >= MAX_SUBSCRIPTIONS_PER_USER) return false;

    userSubs.add(itemId);
    subscriptions.set(userId, userSubs);

    // 增加下载计数
    const updated: MarketItem = {
      ...item,
      downloads: item.downloads + 1,
    };
    items.set(itemId, updated);
    return true;
  }

  function unsubscribe(itemId: string, userId: string): boolean {
    const userSubs = subscriptions.get(userId);
    if (userSubs === undefined) return false;

    if (!userSubs.delete(itemId)) return false;
    return true;
  }

  function getSubscriptions(userId: string): readonly MarketItem[] {
    const userSubs = subscriptions.get(userId);
    if (userSubs === undefined) return [];

    return [...userSubs]
      .map((id) => items.get(id))
      .filter((item): item is MarketItem => item !== undefined);
  }

  function getItemsByAuthor(authorId: string): readonly MarketItem[] {
    return [...items.values()].filter((i) => i.authorId === authorId);
  }

  function updateItem(
    itemId: string,
    authorId: string,
    updates: Partial<Pick<MarketItem, "title" | "description" | "content" | "tags" | "category" | "difficulty" | "status">>,
  ): boolean {
    const item = items.get(itemId);
    if (item === undefined || item.authorId !== authorId) return false;

    // C.1: 更新字段验证
    if (updates.title !== undefined && updates.title.length > MAX_TITLE_LENGTH) {
      return false;
    }
    if (updates.description !== undefined && updates.description.length > MAX_DESCRIPTION_LENGTH) {
      return false;
    }
    if (updates.content !== undefined) {
      const contentError = validateContentStructure(updates.content);
      if (contentError !== undefined) return false;
    }
    if (updates.tags !== undefined) {
      if (updates.tags.length > MAX_TAGS_COUNT) return false;
      for (const tag of updates.tags) {
        if (tag.length > MAX_TAG_LENGTH) return false;
      }
    }
    if (updates.category !== undefined && !CATEGORY_WHITELIST.has(updates.category)) {
      return false;
    }

    const updated: MarketItem = {
      ...item,
      ...updates,
      updatedAt: Date.now(),
    };
    items.set(itemId, updated);
    return true;
  }

  function removeItem(itemId: string, authorId: string): boolean {
    const item = items.get(itemId);
    if (item === undefined || item.authorId !== authorId) return false;

    items.delete(itemId);
    return true;
  }

  function count(): number {
    return items.size;
  }

  function clear(): void {
    items.clear();
    subscriptions.clear();
    ratings.clear();
  }

  return {
    publish,
    search,
    getItem,
    getTrending,
    rateItem,
    subscribe,
    unsubscribe,
    getSubscriptions,
    getItemsByAuthor,
    updateItem,
    removeItem,
    count,
    clear,
  };
}
