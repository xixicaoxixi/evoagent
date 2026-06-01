import type { RouteEntry, HttpRequest } from "../../server";
import { jsonResponse, errorResponse } from "../../server";
import type { EvoAgentContext } from "../../integration/context";
import { createDefaultKnowledgeStore } from "../../knowledge/store";
import { createKnowledgeFacade } from "../../knowledge/knowledge-facade";

export interface KnowledgeEntry {
  readonly id: string;
  readonly content: string;
  readonly type: "fact" | "preference" | "instruction" | "skill";
  readonly confidence: number;
  readonly createdAt: number;
  readonly accessCount: number;
  readonly processingResult?: string;
}

export interface KnowledgeSearchResult {
  readonly entry: KnowledgeEntry;
  readonly score: number;
}

export interface KnowledgeStore {
  search(query: string, limit?: number): readonly KnowledgeSearchResult[];
  inject(entry: Omit<KnowledgeEntry, "id" | "createdAt" | "accessCount">): KnowledgeEntry;
  getMemory(): { total: number; byType: Record<string, number> };
  get(id: string): KnowledgeEntry | undefined;
  readonly loaded: Promise<void>;
}

function keywordScore(query: string, content: string): number {
  const queryLower = query.toLowerCase();
  const contentLower = content.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(Boolean);

  if (queryWords.length === 0) return 0;

  let matches = 0;
  for (const word of queryWords) {
    if (contentLower.includes(word)) matches++;
  }

  return matches / queryWords.length;
}

export function createMemoryKnowledgeStore(): KnowledgeStore {
  const entries = new Map<string, KnowledgeEntry>();
  let nextId = 1;

  function search(query: string, limit: number = 10): readonly KnowledgeSearchResult[] {
    const results: KnowledgeSearchResult[] = [];

    for (const entry of entries.values()) {
      const score = keywordScore(query, entry.content);
      if (score > 0) {
        results.push({ entry: { ...entry, accessCount: entry.accessCount + 1 }, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  function inject(input: Omit<KnowledgeEntry, "id" | "createdAt" | "accessCount">): KnowledgeEntry {
    const entry: KnowledgeEntry = {
      ...input,
      id: `knowledge-${nextId++}`,
      createdAt: Date.now(),
      accessCount: 0,
    };
    entries.set(entry.id, entry);
    return entry;
  }

  function getMemory(): { total: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {
      fact: 0,
      preference: 0,
      instruction: 0,
      skill: 0,
    };
    for (const entry of entries.values()) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
    }
    return { total: entries.size, byType };
  }

  function get(id: string): KnowledgeEntry | undefined {
    return entries.get(id);
  }

  return { search, inject, getMemory, get, loaded: Promise.resolve() };
}

export interface KnowledgeRouteDeps {
  getContext: () => EvoAgentContext | undefined;
  store?: KnowledgeStore;
}

const EMPTY_MEMORY = { total: 0, byType: { fact: 0, preference: 0, instruction: 0, skill: 0 } } as const;

function resolveStore(deps: KnowledgeRouteDeps): KnowledgeStore {
  if (deps.store) return deps.store;
  const ctx = deps.getContext();
  if (ctx) {
    return ctx.getKnowledgeFacade();
  }
  return createDefaultKnowledgeStore();
}

export function createKnowledgeRouteDeps(getContext: () => EvoAgentContext | undefined): KnowledgeRouteDeps {
  return { getContext };
}

export function registerKnowledgeRoutes(deps: KnowledgeRouteDeps): RouteEntry[] {
  return [
    {
      method: "GET",
      pattern: "/knowledge",
      handler: async () => {
        const store = resolveStore(deps);
        await store.loaded;
        return jsonResponse(store.getMemory());
      },
    },
    {
      method: "GET",
      pattern: "/knowledge/search",
      handler: async (req: HttpRequest) => {
        const store = resolveStore(deps);
        await store.loaded;
        const query = req.query.get("q");
        if (!query) {
          return errorResponse("Missing 'q' query parameter", 400);
        }
        const limit = parseInt(req.query.get("limit") ?? "10", 10);
        const results = store.search(query, isNaN(limit) ? 10 : limit);
        return jsonResponse(results);
      },
    },
    {
      method: "POST",
      pattern: "/knowledge/inject",
      auth: true,
      handler: async (req: HttpRequest) => {
        const body = req.body as Record<string, unknown> | null;
        if (!body || typeof body.content !== "string") {
          return errorResponse("Missing 'content' field", 400);
        }

        const ctx = deps.getContext();
        let processingResult: string | undefined;

        if (ctx) {
          try {
            const critic = ctx.getCritic();
            const analysis = await critic.analyzeMessage(
              typeof body.sourceAgent === "string" ? body.sourceAgent : "api_user",
              body.content as string,
              typeof body.confidence === "number" ? body.confidence : 0.8,
            );
            processingResult = analysis.processingResult;

            if (analysis.processingResult === "REJECT") {
              return jsonResponse({
                rejected: true,
                reason: "Critic rejected the knowledge",
                processingResult: analysis.processingResult,
                analysis: {
                  flawedAspects: analysis.flawedAspects,
                },
              }, 200);
            }
          } catch {
            void 0;
          }
        }

        const store = resolveStore(deps);
        const entry = store.inject({
          content: body.content,
          type: (body.type as KnowledgeEntry["type"]) ?? "fact",
          confidence: typeof body.confidence === "number" ? body.confidence : 0.8,
          ...(processingResult ? { processingResult } : {}),
        });
        return jsonResponse(entry, 201);
      },
    },
    {
      method: "GET",
      pattern: "/knowledge/memory",
      handler: async () => {
        const store = resolveStore(deps);
        await store.loaded;
        return jsonResponse(store.getMemory());
      },
    },
  ];
}
