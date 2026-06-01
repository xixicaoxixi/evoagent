/**
 * MCP 技能桥接 — 服务定位器模式解耦循环依赖。
 *
 * 解决 mcpSkills.ts 需要 loadSkillsDir.ts 的函数，
 * 但直接导入会形成循环依赖的问题。
 *
 * 模式：叶子模块（仅导入类型）+ 运行时注册表。
 */

import type { SkillDefinition, SkillFrontmatter } from "../plugins/skills/definition";

// ─── 技能构建器接口 ───

export interface SkillBuilders {
  /** 从 SKILL.md 内容创建技能定义 */
  parseSkillContent(
    name: string,
    content: string,
    source: SkillDefinition["source"],
    dirPath: string,
  ): SkillDefinition | null;
  /** 解析 frontmatter 字段 */
  parseFrontmatterFields(
    content: string,
  ): { frontmatter: SkillFrontmatter | null; body: string };
}

// ─── 服务定位器 ───

let builders: SkillBuilders | null = null;

/** 注册技能构建器（由 loadSkillsDir 在初始化时调用） */
export function registerSkillBuilders(b: SkillBuilders): void {
  builders = b;
}

/** 获取技能构建器 */
export function getSkillBuilders(): SkillBuilders {
  if (builders === null) {
    throw new Error(
      "Skill builders not registered -- skills module has not been evaluated yet",
    );
  }
  return builders;
}

/** 检查是否已注册 */
export function hasSkillBuilders(): boolean {
  return builders !== null;
}

/** 重置（仅用于测试） */
export function resetSkillBuilders(): void {
  builders = null;
}
