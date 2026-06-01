import { z } from "zod";
import { readJSONL } from "../persistence/jsonl";
import { atomicWriteText } from "../persistence/atomic-write";
import type { MemoryEntry, MemoryType } from "./memory-types";
import { createAsyncLock, createDebouncedWrite } from "../utils/async-lock";

export const MemoryEntrySchema = z.object({
  id: z.string().min(1),
  type: z.enum(["preference", "fact", "instruction", "skill"]),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  mtimeMs: z.number(),
  source: z.string(),
  confidence: z.number().min(0).max(1),
});

export interface MemoryStore {
  getAll(): Promise<readonly MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry | undefined>;
  getByType(type: MemoryType): Promise<readonly MemoryEntry[]>;
  store(entry: MemoryEntry): Promise<void>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
  clear(): Promise<void>;
  flush(): Promise<void>;
}

let memoriesFilePath = "./data/knowledge/memories.jsonl";

export function setMemoriesFilePath(path: string): void {
  memoriesFilePath = path;
}

export function createMemoryMemoryStore(): MemoryStore {
  const entries = new Map<string, MemoryEntry>();

  return {
    async getAll() {
      return [...entries.values()];
    },
    async get(id: string) {
      return entries.get(id);
    },
    async getByType(type: MemoryType) {
      return [...entries.values()].filter((e) => e.type === type);
    },
    async store(entry: MemoryEntry) {
      entries.set(entry.id, entry);
    },
    async delete(id: string) {
      return entries.delete(id);
    },
    async count() {
      return entries.size;
    },
    async clear() {
      entries.clear();
    },

    async flush() {
    },
  };
}

export function createJSONLMemoryStore(options?: {
  readonly debounceMs?: number;
}): MemoryStore {
  const debounceMs = options?.debounceMs ?? 100;
  let cache: MemoryEntry[] | null = null;
  let dirty = false;

  let typeIndex: Map<string, number[]> | null = null;

  const lock = createAsyncLock();

  function invalidateIndex(): void {
    typeIndex = null;
  }

  function buildTypeIndex(all: MemoryEntry[]): Map<string, number[]> {
    const index = new Map<string, number[]>();
    for (let i = 0; i < all.length; i++) {
      const type = all[i]!.type;
      let entries = index.get(type);
      if (!entries) {
        entries = [];
        index.set(type, entries);
      }
      entries.push(i);
    }
    return index;
  }

  async function loadAll(): Promise<MemoryEntry[]> {
    if (cache !== null && !dirty) return cache;

    try {
      const raw = await readJSONL(memoriesFilePath);
      const parsed: MemoryEntry[] = [];
      for (const item of raw) {
        const result = MemoryEntrySchema.safeParse(item);
        if (result.success) {
          parsed.push({
            id: result.data.id,
            type: result.data.type,
            title: result.data.title,
            content: result.data.content,
            tags: result.data.tags,
            createdAt: result.data.createdAt,
            updatedAt: result.data.updatedAt,
            mtimeMs: result.data.mtimeMs,
            source: result.data.source,
            confidence: result.data.confidence,
          });
        }
      }
      cache = parsed;
    } catch {
      cache = [];
    }

    dirty = false;
    invalidateIndex();
    return cache;
  }

  async function saveAll(entries: MemoryEntry[]): Promise<void> {
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await atomicWriteText(memoriesFilePath, lines);
    cache = entries;
    dirty = false;
    invalidateIndex();
  }

  const debouncedSave = createDebouncedWrite(saveAll, debounceMs);

  async function getAll(): Promise<readonly MemoryEntry[]> {
    return lock.locked(async () => loadAll());
  }

  async function get(id: string): Promise<MemoryEntry | undefined> {
    return lock.locked(async () => {
      const all = await loadAll();
      return all.find((e) => e.id === id);
    });
  }

  async function getByType(type: MemoryType): Promise<readonly MemoryEntry[]> {
    return lock.locked(async () => {
      const all = await loadAll();
      if (typeIndex === null) {
        typeIndex = buildTypeIndex(all);
      }
      const indices = typeIndex.get(type);
      if (indices === undefined) return [];
      return indices.map((i) => all[i]!);
    });
  }

  async function storeEntry(entry: MemoryEntry): Promise<void> {
    return lock.locked(async () => {
      const all = await loadAll();
      const existingIndex = all.findIndex((e) => e.id === entry.id);
      if (existingIndex >= 0) {
        all[existingIndex] = entry;
      } else {
        all.push(entry);
      }
      cache = all;
      dirty = false;
      invalidateIndex();
      debouncedSave.schedule(all);
    });
  }

  async function remove(id: string): Promise<boolean> {
    return lock.locked(async () => {
      const all = await loadAll();
      const index = all.findIndex((e) => e.id === id);
      if (index === -1) return false;

      all.splice(index, 1);
      cache = all;
      dirty = false;
      invalidateIndex();
      debouncedSave.schedule(all);
      return true;
    });
  }

  async function countEntries(): Promise<number> {
    return lock.locked(async () => {
      const all = await loadAll();
      return all.length;
    });
  }

  async function clearAll(): Promise<void> {
    return lock.locked(async () => {
      cache = [];
      dirty = false;
      invalidateIndex();
      await saveAll([]);
    });
  }

  async function flushStore(): Promise<void> {
    await debouncedSave.flush();
  }

  return {
    getAll,
    get,
    getByType,
    store: storeEntry,
    delete: remove,
    count: countEntries,
    clear: clearAll,
    flush: flushStore,
  };
}
