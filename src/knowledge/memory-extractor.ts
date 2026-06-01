/**
 * 记忆提取执行器 — 从对话中提取记忆并分类存储。
 *
 * 参考 `代码片段_上下文记忆与通信协议.md` 片段 #17。
 * 支持四类型分类（preference/fact/instruction/skill）。
 */

import type { Message } from "../types/message";
import type { LLMProvider, LLMMessageParam } from "../interfaces/llm-provider";
import type { MemoryEntry, MemoryType, MemoryExtractionResult } from "./memory-types";
import { parseMemoryType, TYPES_SECTION, MEMORY_TYPE_DESCRIPTIONS } from "./memory-types";
import { buildMemoryScanResult, formatMemoryManifest } from "./memory-scan";
import { sanitizePath } from "../security/llm-sanitize";
import { extractJSONArray, safeJSONParse } from "../utils/llm-parse";
import { z } from "zod";

// ─── 提取器配置 ───

export interface MemoryExtractorConfig {
  readonly provider?: LLMProvider;
  readonly memoryDir?: string;
  readonly minTurnsBetweenExtractions?: number;
  readonly maxMemoriesPerExtraction?: number;
}

// ─── 提取器状态 ───

export interface MemoryExtractorState {
  readonly lastExtractionTurn: number;
  readonly totalExtractions: number;
  readonly totalMemoriesExtracted: number;
  readonly inProgress: boolean;
}

// ─── 创建记忆提取器 ───

export function createMemoryExtractor(config?: MemoryExtractorConfig) {
  const minTurns = config?.minTurnsBetweenExtractions ?? 3;
  const maxMemories = config?.maxMemoriesPerExtraction ?? 10;

  let lastExtractionTurn = 0;
  let totalExtractions = 0;
  let totalMemoriesExtracted = 0;
  let inProgress = false;

  // 内存存储
  const memoryStore = new Map<string, MemoryEntry>();

  function getState(): MemoryExtractorState {
    return {
      lastExtractionTurn,
      totalExtractions,
      totalMemoriesExtracted,
      inProgress,
    };
  }

  function shouldExtract(currentTurn: number, messages: readonly Message[]): boolean {
    if (inProgress) return false;
    if (currentTurn - lastExtractionTurn < minTurns) return false;
    // 至少有 1 条用户消息
    return messages.some((m) => m.role === "user");
  }

  async function extract(
    messages: readonly Message[],
    existingMemories?: readonly MemoryEntry[],
  ): Promise<MemoryExtractionResult> {
    if (inProgress) {
      return { memories: [], updated: [], skipped: [] };
    }

    inProgress = true;
    totalExtractions++;

    try {
      // 构建现有记忆清单
      const existingList = existingMemories ?? Array.from(memoryStore.values());
      const scanResult = buildMemoryScanResult(
        existingList.map((m) => ({
          filename: `${m.type ?? "unknown"}_${m.id}.md`,
          filePath: `${config?.memoryDir ?? "/memory"}/${m.type ?? "unknown"}_${m.id}.md`,
          mtimeMs: m.mtimeMs,
          description: m.title,
          type: m.type,
        })),
      );

      // 构建提取提示词
      const prompt = buildExtractionPrompt(messages, scanResult.manifest);

      // 调用 LLM 或使用规则提取
      let newMemories: MemoryEntry[];
      if (config?.provider) {
        newMemories = await extractWithLLM(prompt, config.provider);
      } else {
        newMemories = extractWithRules(messages);
      }

      // 去重和更新
      const updated: string[] = [];
      const skipped: string[] = [];

      for (const memory of newMemories.slice(0, maxMemories)) {
        const existing = findDuplicate(memory, existingList);
        if (existing) {
          // 更新现有记忆
          const updatedMemory: MemoryEntry = {
            ...existing,
            content: memory.content,
            updatedAt: Date.now(),
            mtimeMs: Date.now(),
          };
          memoryStore.set(existing.id, updatedMemory);
          updated.push(existing.id);
        } else {
          // 新增记忆
          memoryStore.set(memory.id, memory);
          updated.push(memory.id);
        }
      }

      totalMemoriesExtracted += newMemories.length;

      return {
        memories: Array.from(memoryStore.values()),
        updated,
        skipped,
      };
    } finally {
      inProgress = false;
      lastExtractionTurn = messages.length;
    }
  }

  function getMemory(id: string): MemoryEntry | undefined {
    return memoryStore.get(id);
  }

  function getAllMemories(): readonly MemoryEntry[] {
    return Array.from(memoryStore.values());
  }

  function deleteMemory(id: string): boolean {
    return memoryStore.delete(id);
  }

  function clear(): void {
    memoryStore.clear();
  }

  return {
    getState,
    shouldExtract,
    extract,
    getMemory,
    getAllMemories,
    deleteMemory,
    clear,
  };
}

// ─── LLM 提取 ───

async function extractWithLLM(prompt: string, provider: LLMProvider): Promise<MemoryEntry[]> {
  try {
    const response = await provider.invoke([
      { role: "user", content: prompt },
    ]);

    const contentStr = typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

    const jsonStr = extractJSONArray(contentStr);
    if (jsonStr === null) {
      return [];
    }

    const rawParsed = safeJSONParse(jsonStr);

    if (!Array.isArray(rawParsed)) {
      return [];
    }

    const LLMMemoryItemSchema = z.object({
      type: z.string(),
      title: z.string(),
      content: z.string(),
      tags: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional(),
    });

    return rawParsed
      .filter((item: unknown): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && "type" in item && "title" in item && "content" in item,
      )
      .map((item) => {
        const validated = LLMMemoryItemSchema.safeParse(item);
        if (!validated.success) return null;
        const v = validated.data;
        const memoryType = parseMemoryType(v.type) ?? "fact";

        return {
          id: crypto.randomUUID(),
          type: memoryType,
          title: v.title.slice(0, 200),
          content: v.content,
          tags: v.tags ?? [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          mtimeMs: Date.now(),
          source: "conversation_llm",
          confidence: v.confidence ?? 0.7,
        } as MemoryEntry;
      })
      .filter((m): m is MemoryEntry => m !== null);
  } catch (err) {
    console.warn(`[MEMORY-EXTRACTOR] LLM extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ─── 规则提取关键词映射 ───

interface ExtractionPattern {
  readonly type: MemoryType;
  readonly enPatterns: readonly RegExp[];
  readonly zhKeywords: readonly string[];
}

const EXTRACTION_PATTERNS: readonly ExtractionPattern[] = [
  {
    type: "preference",
    enPatterns: [
      /\bi\s+prefer\b/i,
      /\bi\s+like\b/i,
      /\bplease\s+always\b/i,
    ],
    zhKeywords: ["我喜欢", "我偏好", "倾向于", "我习惯", "偏好"],
  },
  {
    type: "instruction",
    enPatterns: [
      /\bmust\b/i,
      /\balways\b/i,
      /\bnever\b/i,
      /\bdon't\b/i,
      /\bdo\s+not\b/i,
    ],
    zhKeywords: ["必须", "一定要", "不要", "禁止", "绝不", "切记", "务必"],
  },
  {
    type: "fact",
    enPatterns: [
      /\bthe\s+project\b/i,
      /\bthe\s+api\b/i,
      /\bthe\s+config\b/i,
      /\bour\s+codebase\b/i,
    ],
    zhKeywords: ["项目", "接口", "架构", "配置", "代码库", "数据库", "服务器"],
  },
];

function extractWithRules(messages: readonly Message[]): MemoryEntry[] {
  const memories: MemoryEntry[] = [];
  const userMessages = messages.filter((m) => m.role === "user");
  const seenTypes = new Set<string>();

  for (const msg of userMessages) {
    const content = msg.content;

    for (const pattern of EXTRACTION_PATTERNS) {
      const key = `${msg.id}:${pattern.type}`;
      if (seenTypes.has(key)) continue;

      const enMatch = pattern.enPatterns.some((re) => re.test(content));
      const zhMatch = pattern.zhKeywords.some((kw) => content.includes(kw));

      if (enMatch || zhMatch) {
        seenTypes.add(key);
        memories.push(createMemoryEntry(pattern.type, content));
      }
    }
  }

  return memories;
}

// ─── 辅助函数 ───

function createMemoryEntry(type: MemoryType, content: string): MemoryEntry {
  const id = crypto.randomUUID();
  const title = content.length > 80 ? `${content.slice(0, 77)}...` : content;
  return {
    id,
    type,
    title,
    content,
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mtimeMs: Date.now(),
    source: "conversation",
    confidence: 0.5,
  };
}

function findDuplicate(
  memory: MemoryEntry,
  existing: readonly MemoryEntry[],
): MemoryEntry | undefined {
  // 简单去重：相同类型 + 标题相似度 > 80%
  for (const e of existing) {
    if (e.type === memory.type && e.title === memory.title) {
      return e;
    }
  }
  return undefined;
}

function buildExtractionPrompt(
  messages: readonly Message[],
  existingManifest: string,
): string {
  const recentMessages = messages.slice(-10);
  const conversationText = recentMessages
    .map((m) => {
      let text: string;
      if (m.role === "tool_use") {
        text = JSON.stringify(m.input);
      } else if (m.role === "tool_result") {
        text = m.content;
      } else {
        text = m.content;
      }
      // 路径脱敏：防止文件路径泄露到外部 LLM
      text = sanitizePath(text);
      return `[${m.role}] ${text.slice(0, 200)}`;
    })
    .join("\n");

  return [
    "## Memory Extraction",
    "",
    "Analyze the following conversation and extract important information to save as memories.",
    "",
    TYPES_SECTION,
    "",
    "### Existing Memories",
    existingManifest || "(No existing memories)",
    "",
    "### Recent Conversation",
    conversationText,
    "",
    "Extract any new memories from the conversation. For each memory, specify:",
    "- type: preference | fact | instruction | skill",
    "- title: short descriptive title",
    "- content: the full memory content",
    "",
    "Return a JSON array. Use English field names in JSON output. Output ONLY the JSON array, no additional text.",
  ].join("\n");
}
