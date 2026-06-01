/**
 * SKILL.md 技能定义 — 声明式技能系统。
 *
 * 技能通过 SKILL.md 文件声明（YAML frontmatter + Markdown 正文）。
 * 支持条件激活（延迟加载模式）和五源扫描。
 */

import { z } from "zod";

// ─── 技能来源 ───

export type SkillSource = "managed" | "user" | "project" | "additional" | "legacy";

// ─── SKILL.md Frontmatter Schema ───

export const SkillFrontmatterSchema = z.object({
  description: z.string().min(1),
  "allowed-tools": z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  context: z.enum(["inline", "fork"]).optional(),
  agent: z.string().optional(),
  paths: z.array(z.string()).optional(),
  "argument-hint": z.string().optional(),
  arguments: z.array(z.string()).optional(),
  "parallel-subagents": z.array(z.object({
    name: z.string().min(1),
    role: z.enum(["reviewer", "debugger", "refactorer", "tester", "full"]).optional(),
    description: z.string().min(1),
    "allowed-tools": z.array(z.string()).optional(),
  })).optional(),
  "aggregation-strategy": z.enum(["all_succeed", "majority", "any_succeed", "collect_all"]).optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

// ─── 并行 SubAgent 定义 ───

/** 单个并行 SubAgent 声明 */
export interface ParallelSubagentDeclaration {
  readonly name: string;
  readonly role?: "reviewer" | "debugger" | "refactorer" | "tester" | "full";
  readonly description: string;
  readonly allowedTools?: readonly string[];
}

/** 结果汇总策略 */
export type SkillAggregationStrategy = "all_succeed" | "majority" | "any_succeed" | "collect_all";

// ─── 技能定义 ───

export interface SkillDefinition {
  /** 技能唯一名称（目录名） */
  readonly name: string;
  /** 技能来源 */
  readonly source: SkillSource;
  /** 技能目录路径 */
  readonly dirPath: string;
  /** Frontmatter 数据 */
  readonly frontmatter: SkillFrontmatter;
  /** Markdown 正文 */
  readonly markdownContent: string;
  /** 是否为条件技能（有 paths 字段） */
  readonly isConditional: boolean;
  /** 是否已激活（条件技能专用） */
  readonly activated: boolean;
}

// ─── 条件技能激活结果 ───

export interface SkillActivationResult {
  readonly activatedNames: readonly string[];
  readonly totalChecked: number;
}

// ─── 技能解析结果 ───

export interface SkillParseResult {
  readonly success: boolean;
  readonly skill?: SkillDefinition;
  readonly error?: string;
}

// ─── Frontmatter 解析 ───

export function parseFrontmatter(
  content: string,
): { frontmatter: SkillFrontmatter | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (match === null) {
    return { frontmatter: null, body: content };
  }

  const yamlStr = match[1]!;
  const body = match[2]!;

  try {
    const parsed = simpleYamlParse(yamlStr);
    const result = SkillFrontmatterSchema.safeParse(parsed);
    if (!result.success) {
      return { frontmatter: null, body };
    }
    return { frontmatter: result.data, body };
  } catch {
    return { frontmatter: null, body };
  }
}

/** 简易 YAML 解析（支持扁平键值对、数组和嵌套对象数组） */
function simpleYamlParse(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");

  // 状态机
  let pendingArrayKey: string | undefined; // 刚看到 "key:" 后等待数组项
  let activeArrayKey: string | undefined; // 当前正在收集的数组
  let activeArrayIndent = -1; // 当前数组的缩进级别
  let currentObj: Record<string, unknown> | undefined; // 当前正在构建的嵌套对象
  let currentObjIndent = -1; // 当前对象的缩进级别
  let nestedArrayKey: string | undefined; // 嵌套对象内的数组键
  let nestedArrayIndent = -1; // 嵌套数组的缩进级别

  function flushObj(): void {
    if (activeArrayKey !== undefined && currentObj !== undefined) {
      const existing = result[activeArrayKey];
      if (Array.isArray(existing)) {
        existing.push(currentObj);
      } else {
        result[activeArrayKey] = [currentObj];
      }
      currentObj = undefined;
      currentObjIndent = -1;
      nestedArrayKey = undefined;
      nestedArrayIndent = -1;
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    // ── 数组项（以 - 开头） ──
    if (trimmed.startsWith("- ")) {
      const inner = trimmed.slice(2).trim();
      const colonIdx = inner.indexOf(":");

      if (colonIdx > 0) {
        // 嵌套对象数组项 "- key: value"
        if (indent === activeArrayIndent || activeArrayKey === undefined) {
          // 同级或新数组 — flush 之前的对象
          flushObj();
          activeArrayIndent = indent;
          // 如果 pendingArrayKey 存在，使用它
          if (pendingArrayKey !== undefined) {
            activeArrayKey = pendingArrayKey;
            pendingArrayKey = undefined;
          }
        }

        currentObj = {};
        currentObjIndent = indent;
        const key = inner.slice(0, colonIdx).trim();
        const value = parseYamlValue(inner.slice(colonIdx + 1).trim());
        currentObj[key] = value;
      } else {
        // 简单字符串数组项 "- value"
        if (currentObj !== undefined && indent > currentObjIndent) {
          // 嵌套在当前对象内的数组
          if (nestedArrayKey === undefined) {
            // 需要确定嵌套数组键 — 从上一个属性推断
            // 这种情况不应该发生（嵌套数组键应该由 "key:" 行设置）
          }
          if (nestedArrayKey !== undefined) {
            const existing = currentObj[nestedArrayKey];
            const item = parseYamlValue(inner);
            if (Array.isArray(existing)) {
              existing.push(item);
            } else {
              currentObj[nestedArrayKey] = [item];
            }
          }
        } else {
          // 顶层简单数组
          flushObj();
          activeArrayIndent = indent;
          currentObjIndent = -1;

          if (pendingArrayKey !== undefined) {
            activeArrayKey = pendingArrayKey;
            pendingArrayKey = undefined;
          }

          if (activeArrayKey !== undefined) {
            const existing = result[activeArrayKey];
            const item = parseYamlValue(inner);
            if (Array.isArray(existing)) {
              existing.push(item);
            } else {
              result[activeArrayKey] = [item];
            }
          }
        }
      }
      continue;
    }

    // ── 键值对 ──
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const rawValue = trimmed.slice(colonIdx + 1).trim();
      const value = parseYamlValue(rawValue);

      if (currentObj !== undefined && indent > currentObjIndent) {
        // 嵌套在当前对象内的属性
        if (value === null || value === "") {
          // 可能是嵌套数组的键
          nestedArrayKey = key;
          nestedArrayIndent = indent;
        } else {
          nestedArrayKey = undefined;
          currentObj[key] = value;
        }
      } else {
        // 顶层属性
        flushObj();
        activeArrayKey = undefined;
        activeArrayIndent = -1;
        currentObjIndent = -1;
        nestedArrayKey = undefined;

        if (value === null || value === "") {
          // 可能是后续数组/对象的键
          pendingArrayKey = key;
          result[key] = null;
        } else {
          pendingArrayKey = undefined;
          result[key] = value;
        }
      }
      continue;
    }
  }

  flushObj();

  return result;
}

/** 解析 YAML 值（去除引号、处理布尔/数字/null） */
function parseYamlValue(value: string): unknown {
  if (typeof value !== "string") return value;

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  if (value === "" || value === "null" || value === "~") {
    return null;
  }

  if (value === "true") return true;
  if (value === "false") return false;

  const num = Number(value);
  if (!isNaN(num) && value !== "") return num;

  return value;
}

// ─── 路径匹配（gitignore 风格简化版） ───

export function matchPathPattern(
  filePath: string,
  patterns: readonly string[],
): boolean {
  for (const pattern of patterns) {
    if (matchSinglePattern(filePath, pattern)) {
      return true;
    }
  }
  return false;
}

function matchSinglePattern(filePath: string, pattern: string): boolean {
  // 简化匹配：支持 * 通配符和目录前缀
  const normalizedPattern = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*");

  try {
    const regex = new RegExp(`(^|/)${normalizedPattern}(/|$)`);
    return regex.test(filePath);
  } catch {
    return false;
  }
}

// ─── 条件技能激活 ───

export function activateConditionalSkills(
  skills: readonly SkillDefinition[],
  filePaths: readonly string[],
  cwd: string,
): SkillActivationResult {
  const activatedNames: string[] = [];

  for (const skill of skills) {
    if (!skill.isConditional || skill.activated) continue;

    const patterns = skill.frontmatter.paths;
    if (patterns === undefined || patterns.length === 0) continue;

    for (const filePath of filePaths) {
      // 计算相对路径
      let relativePath = filePath;
      if (filePath.startsWith(cwd)) {
        relativePath = filePath.slice(cwd.length);
        if (relativePath.startsWith("/")) {
          relativePath = relativePath.slice(1);
        }
      }

      if (
        relativePath &&
        !relativePath.startsWith("..") &&
        matchPathPattern(relativePath, patterns)
      ) {
        activatedNames.push(skill.name);
        break;
      }
    }
  }

  return {
    activatedNames,
    totalChecked: skills.filter((s) => s.isConditional && !s.activated).length,
  };
}

// ─── 并行 SubAgent 提取 ───

/**
 * 从 SkillDefinition 中提取并行 SubAgent 声明。
 *
 * 将 frontmatter 中的 `parallel-subagents` 数组转换为类型安全的声明列表。
 */
export function extractParallelSubagents(
  skill: SkillDefinition,
): readonly ParallelSubagentDeclaration[] {
  const raw = skill.frontmatter["parallel-subagents"];
  if (raw === undefined || !Array.isArray(raw)) return [];

  return raw.map((item) => {
    const role = item.role as ParallelSubagentDeclaration["role"] | undefined;
    return {
      name: String(item.name ?? ""),
      ...(role !== undefined ? { role } : {}),
      description: String(item.description ?? ""),
      ...(Array.isArray(item["allowed-tools"])
        ? { allowedTools: item["allowed-tools"].map(String) }
        : {}),
    };
  });
}

/**
 * 从 SkillDefinition 中提取汇总策略。
 */
export function extractAggregationStrategy(
  skill: SkillDefinition,
): SkillAggregationStrategy {
  const raw = skill.frontmatter["aggregation-strategy"];
  if (raw === undefined) return "all_succeed";
  return raw;
}

/**
 * 检查 Skill 是否声明了并行 SubAgent。
 */
export function hasParallelSubagents(skill: SkillDefinition): boolean {
  const raw = skill.frontmatter["parallel-subagents"];
  return Array.isArray(raw) && raw.length > 0;
}
