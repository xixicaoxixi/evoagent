/**
 * 记忆类型定义 — 分层分类系统。
 *
 * 参考 `代码片段_上下文记忆与通信协议.md` 片段 #16。
 *
 * Session B.3 升级：
 * - 将记忆分为两大类：指令型（instruction）和学习型（learning）
 * - instruction 包含：preference, instruction
 * - learning 包含：fact, skill
 * - 两者混为一体会导致系统行为逐渐偏离预期
 */

// ─── 记忆大类 ───

/** 记忆大类（指令型 vs 学习型） */
export type MemoryCategory = "instruction" | "learning";

// ─── 记忆类型 ───

export type MemoryType = "preference" | "fact" | "instruction" | "skill";

// ─── 记忆条目 ───

export interface MemoryEntry {
  readonly id: string;
  readonly type: MemoryType;
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly mtimeMs: number;
  readonly source: string;
  readonly confidence: number;
}

// ─── 记忆元数据 ───

export interface MemoryHeader {
  readonly filename: string;
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly description: string | null;
  readonly type: MemoryType | undefined;
}

// ─── 记忆提取结果 ───

export interface MemoryExtractionResult {
  readonly memories: readonly MemoryEntry[];
  readonly updated: readonly string[];
  readonly skipped: readonly string[];
}

// ─── 类型解析 ───

const VALID_TYPES: ReadonlySet<string> = new Set<MemoryType>([
  "preference", "fact", "instruction", "skill",
]);

export function parseMemoryType(value: unknown): MemoryType | undefined {
  if (typeof value === "string" && VALID_TYPES.has(value)) {
    return value as MemoryType;
  }
  return undefined;
}

export function isValidMemoryType(value: string): value is MemoryType {
  return VALID_TYPES.has(value);
}

/** 获取记忆所属的大类（指令型 vs 学习型） */
export function getMemoryCategory(type: MemoryType): MemoryCategory {
  if (type === "preference" || type === "instruction") return "instruction";
  return "learning";
}

/** 指令型记忆的权重（高于学习型） */
export const INSTRUCTION_WEIGHT = 1.5;

/** 学习型记忆的权重 */
export const LEARNING_WEIGHT = 1.0;

/** 获取记忆类型的搜索权重 */
export function getMemoryWeight(type: MemoryType): number {
  return getMemoryCategory(type) === "instruction"
    ? INSTRUCTION_WEIGHT
    : LEARNING_WEIGHT;
}

// ─── 四类型描述 ───

export const MEMORY_TYPE_DESCRIPTIONS: Readonly<Record<MemoryType, string>> = {
  preference: "User preferences, style choices, workflow habits, and personal settings",
  fact: "Factual information about the project, codebase, environment, or domain",
  instruction: "Explicit instructions, rules, constraints, and requirements from the user",
  skill: "Learned patterns, techniques, solutions, and reusable knowledge from past interactions",
};

// ─── 四类型分类提示词片段 ───

export const TYPES_SECTION = [
  "## Memory Types",
  "",
  "### preference",
  "User preferences, style choices, workflow habits, and personal settings.",
  "Examples: code style (tabs vs spaces), preferred frameworks, communication style.",
  "",
  "### fact",
  "Factual information about the project, codebase, environment, or domain.",
  "Examples: project structure, API endpoints, configuration values, team conventions.",
  "",
  "### instruction",
  "Explicit instructions, rules, constraints, and requirements from the user.",
  "Examples: coding standards, deployment rules, testing requirements, naming conventions.",
  "",
  "### skill",
  "Learned patterns, techniques, solutions, and reusable knowledge from past interactions.",
  "Examples: debugging approaches, optimization techniques, common error resolutions.",
].join("\n");
