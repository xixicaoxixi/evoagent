import { createMemoryKnowledgeStore, type KnowledgeStore } from "../server/routes/knowledge";

export function createDefaultKnowledgeStore(): KnowledgeStore {
  return createMemoryKnowledgeStore();
}
