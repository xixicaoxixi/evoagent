import type { KnowledgeManager } from "./knowledge-manager";
import type { KnowledgeStore, KnowledgeEntry, KnowledgeSearchResult } from "../server/routes/knowledge";
import type { MemoryEntry, MemoryType } from "./memory-types";
import { isValidMemoryType } from "./memory-types";
import { defaultLogger } from "../observability/logger";

const logger = defaultLogger.child("knowledge-facade");

export interface KnowledgeFacadeConfig {
  readonly knowledgeManager: KnowledgeManager;
}

function memoryEntryToKnowledgeEntry(entry: MemoryEntry): KnowledgeEntry {
  return {
    id: entry.id,
    content: entry.content,
    type: entry.type,
    confidence: entry.confidence,
    createdAt: entry.createdAt,
    accessCount: 0,
  };
}

let facadeNextId = 1;

function injectInputToMemoryEntry(
  input: Omit<KnowledgeEntry, "id" | "createdAt" | "accessCount">,
): MemoryEntry {
  const now = Date.now();
  const id = `facade-${facadeNextId++}`;

  return {
    id,
    type: isValidMemoryType(input.type) ? input.type : "fact",
    title: input.content.slice(0, 80),
    content: input.content,
    tags: [],
    createdAt: now,
    updatedAt: now,
    mtimeMs: now,
    source: "http-api",
    confidence: input.confidence,
  };
}

export function createKnowledgeFacade(config: KnowledgeFacadeConfig): KnowledgeStore {
  const km = config.knowledgeManager;

  let loadPromise: Promise<void> | null = null;

  function ensureLoaded(): Promise<void> {
    if (!loadPromise) {
      loadPromise = km.loadFromStore().catch((err) => {
        logger.warn("Failed to load knowledge from store", { error: String(err) });
      });
    }
    return loadPromise;
  }

  void ensureLoaded();

  function search(query: string, limit: number = 10): readonly KnowledgeSearchResult[] {
    const results = km.search(query, { maxResults: limit, minScore: 0.01 });

    return results.map((r) => ({
      entry: memoryEntryToKnowledgeEntry(r.entry),
      score: r.score,
    }));
  }

  function inject(
    input: Omit<KnowledgeEntry, "id" | "createdAt" | "accessCount">,
  ): KnowledgeEntry {
    const memoryEntry = injectInputToMemoryEntry(input);
    km.store(memoryEntry);

    logger.debug("Knowledge injected via facade", {
      id: memoryEntry.id,
      type: memoryEntry.type,
    });

    return memoryEntryToKnowledgeEntry(memoryEntry);
  }

  function getMemory(): { total: number; byType: Record<string, number> } {
    const all = km.getAll();
    const byType: Record<string, number> = {
      fact: 0,
      preference: 0,
      instruction: 0,
      skill: 0,
    };

    for (const entry of all) {
      if (entry.type in byType) {
        byType[entry.type as keyof typeof byType] = (byType[entry.type as keyof typeof byType] ?? 0) + 1;
      }
    }

    return { total: all.length, byType };
  }

  function get(id: string): KnowledgeEntry | undefined {
    const entry = km.get(id);
    if (entry === undefined) return undefined;
    return memoryEntryToKnowledgeEntry(entry);
  }

  return { search, inject, getMemory, get, loaded: loadPromise ?? Promise.resolve() };
}
