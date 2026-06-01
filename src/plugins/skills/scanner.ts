/**
 * 五源技能扫描器 — builtin/managed/user/workspace/remote 五源扫描。
 *
 * 参考 `代码片段_状态管理与插件扩展` #19 getSkillDirCommands()。
 *
 * 设计原则：
 * - 五源并行扫描 + 去重
 * - 按优先级排序：builtin > managed > user > workspace > remote
 * - 条件技能分离（带 paths frontmatter 的技能按需激活）
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

// ─── 技能来源 ───

export type SkillSource = "builtin" | "managed" | "user" | "workspace" | "remote";

// ─── 扫描到的技能 ───

export interface ScannedSkill {
  readonly name: string;
  readonly source: SkillSource;
  readonly dirPath: string;
  readonly filePath: string;
  readonly priority: number;
  readonly conditional?: boolean;
}

// ─── 扫描器配置 ───

export interface SkillScannerConfig {
  /** 扫描目录列表（按优先级排序） */
  readonly scanDirs?: ReadonlyArray<{
    readonly dir: string;
    readonly source: SkillSource;
  }>;
}

// ─── 扫描器接口 ───

export interface SkillScanner {
  /** 扫描所有目录 */
  scan(): ScannedSkill[];
  /** 获取统计 */
  getStats(): { total: number; bySource: Record<SkillSource, number> };
}

// ─── 创建扫描器 ───

export function createSkillScanner(config?: SkillScannerConfig): SkillScanner {
  const scanDirs = config?.scanDirs ?? [];

  function scan(): ScannedSkill[] {
    const results: ScannedSkill[] = [];
    const seenPaths = new Set<string>();

    for (let priority = 0; priority < scanDirs.length; priority++) {
      const { dir, source } = scanDirs[priority]!;

      if (!existsSync(dir)) continue;

      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const skillDir = join(dir, entry.name);
          const skillFile = join(skillDir, "SKILL.md");

          if (!existsSync(skillFile)) continue;

          // realpath 去重
          const realPath = resolve(skillFile);
          if (seenPaths.has(realPath)) continue;
          seenPaths.add(realPath);

          results.push({
            name: entry.name,
            source,
            dirPath: skillDir,
            filePath: skillFile,
            priority,
          });
        }
      } catch {
        // 目录不可读，跳过
      }
    }

    return results;
  }

  function getStats(): { total: number; bySource: Record<SkillSource, number> } {
    const skills = scan();
    const bySource: Record<SkillSource, number> = {
      builtin: 0,
      managed: 0,
      user: 0,
      workspace: 0,
      remote: 0,
    };
    for (const skill of skills) {
      bySource[skill.source]++;
    }
    return { total: skills.length, bySource };
  }

  return { scan, getStats };
}
