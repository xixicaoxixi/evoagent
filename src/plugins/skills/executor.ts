/**
 * Skill 鎵ц鍣?鈥?灏?Skill 澹版槑寮忕紪鎺掕浆鍖栦负骞惰 SubAgent 鎵ц銆? *
 * 褰?Skill 瀹氫箟浜?`parallel-subagents` 鏃讹紝鎵ц鍣ㄨ嚜鍔細
 * 1. 浠庡０鏄庝腑鎻愬彇 SubAgent 閰嶇疆
 * 2. 閫氳繃 Orchestrator 鍒涘缓骞惰鍥㈤槦
 * 3. 鏀堕泦骞惰仛鍚堟墍鏈?SubAgent 鐨勭粨鏋? */

import type { SkillDefinition } from "./definition";
import {
  extractParallelSubagents,
  extractAggregationStrategy,
  hasParallelSubagents,
  type ParallelSubagentDeclaration,
  type SkillAggregationStrategy,
} from "./definition";
import type { Orchestrator, TaskDefinition, ParallelTeamConfig, ParallelTeamResult } from "../../core/agent/orchestrator";
import type { AgentRole } from "../../core/agent/tool-filter";

// 鈹€鈹€鈹€ Skill 鎵ц閰嶇疆 鈹€鈹€鈹€

export interface SkillExecutionConfig {
  /** Orchestrator 瀹炰緥锛堢敤浜庡垱寤哄苟琛屽洟闃燂級 */
  readonly orchestrator: Orchestrator;
  /** 鐢ㄦ埛杈撳叆锛堜紶閫掔粰姣忎釜 SubAgent 浣滀负浠诲姟鎻忚堪鐨勪笂涓嬫枃锛?*/
  readonly userInput: string;
  /** 鍗曚釜鎴愬憳瓒呮椂锛堟绉掞級 */
  readonly memberTimeoutMs?: number;
  /** 瑕嗙洊姹囨€荤瓥鐣?*/
  readonly overrideStrategy?: SkillAggregationStrategy;
}

// 鈹€鈹€鈹€ Skill 鎵ц缁撴灉 鈹€鈹€鈹€

export interface SkillExecutionResult {
  /** 鏄惁澹版槑浜嗗苟琛?SubAgent */
  readonly hasParallelSubagents: boolean;
  /** 鏄惁浣跨敤骞惰妯″紡鎵ц */
  readonly executedInParallel: boolean;
  /** 骞惰鎵ц缁撴灉锛堜粎骞惰妯″紡鏃舵湁鍊硷級 */
  readonly teamResult?: ParallelTeamResult;
  /** 鑱氬悎鍚庣殑鎽樿鏂囨湰 */
  readonly summary: string;
  /** 鎵ц鑰楁椂锛堟绉掞級 */
  readonly durationMs: number;
}

// 鈹€鈹€鈹€ SubAgent 浠诲姟鏋勫缓缁撴灉 鈹€鈹€鈹€

interface SubagentTaskBuildResult {
  readonly tasks: readonly TaskDefinition[];
  readonly config: ParallelTeamConfig;
}

// 鈹€鈹€鈹€ Skill 鎵ц鍣?鈹€鈹€鈹€

export interface SkillExecutor {
  /**
   * 鎵ц Skill銆?   *
   * 濡傛灉 Skill 澹版槑浜?parallel-subagents锛岃嚜鍔ㄥ垱寤哄苟琛屽洟闃熸墽琛屻€?   * 鍚﹀垯杩斿洖鎻愮ず淇℃伅锛堥渶瑕佹墜鍔ㄦ墽琛岋級銆?   */
  execute(skill: SkillDefinition, config: SkillExecutionConfig): Promise<SkillExecutionResult>;
}

// 鈹€鈹€鈹€ 鍒涘缓 Skill 鎵ц鍣?鈹€鈹€鈹€

export function createSkillExecutor(): SkillExecutor {
  /**
   * 鎵ц Skill銆?   */
  async function execute(
    skill: SkillDefinition,
    config: SkillExecutionConfig,
  ): Promise<SkillExecutionResult> {
    const start = Date.now();

    if (!hasParallelSubagents(skill)) {
      return {
        hasParallelSubagents: false,
        executedInParallel: false,
        summary: buildNonParallelSummary(skill),
        durationMs: Date.now() - start,
      };
    }

    // 鏋勫缓骞惰 SubAgent 浠诲姟
    const { tasks, config: teamConfig } = buildSubagentTasks(skill, config);

    // 閫氳繃 Orchestrator 鎵ц骞惰鍥㈤槦
    const teamResult = await config.orchestrator.launchParallelTeam(tasks, teamConfig);

    // 鐢熸垚鑱氬悎鎽樿
    const summary = buildAggregatedSummary(skill, teamResult);

    return {
      hasParallelSubagents: true,
      executedInParallel: true,
      teamResult,
      summary,
      durationMs: Date.now() - start,
    };
  }

  return { execute };
}

// 鈹€鈹€鈹€ 杈呭姪鍑芥暟 鈹€鈹€鈹€

/**
 * 浠?Skill 澹版槑鏋勫缓 SubAgent 浠诲姟鍒楄〃鍜屽洟闃熼厤缃€? */
function buildSubagentTasks(
  skill: SkillDefinition,
  config: SkillExecutionConfig,
): SubagentTaskBuildResult {
  const declarations = extractParallelSubagents(skill);
  const strategy = config.overrideStrategy ?? extractAggregationStrategy(skill);

  const tasks: TaskDefinition[] = declarations.map((decl, index) => ({
    taskId: `${skill.name}-subagent-${decl.name}-${index}`,
    description: buildTaskDescription(decl, config.userInput, skill),
    ...(decl.allowedTools !== undefined && decl.allowedTools.length > 0
      ? { tools: decl.allowedTools }
      : {}),
    ...(decl.role !== undefined ? { systemPrompt: buildRoleSystemPrompt(decl) } : {}),
  }));

  const teamConfig: ParallelTeamConfig = {
    strategy,
    ...(config.memberTimeoutMs !== undefined ? { memberTimeoutMs: config.memberTimeoutMs } : {}),
  };

  return { tasks, config: teamConfig };
}

/**
 * 鏋勫缓鍗曚釜 SubAgent 鐨勪换鍔℃弿杩般€? */
function buildTaskDescription(
  decl: ParallelSubagentDeclaration,
  userInput: string,
  skill: SkillDefinition,
): string {
  return `## Skill: ${skill.name}

## Your Role: ${decl.name}
${decl.description}

## User Request
${userInput}

## Instructions
- Focus on your specific area of responsibility
- Report findings concisely
- If you encounter errors, describe them clearly`;
}

/**
 * 鏋勫缓瑙掕壊绯荤粺鎻愮ず銆? */
function buildRoleSystemPrompt(decl: ParallelSubagentDeclaration): string {
  const roleDescriptions: Record<AgentRole, string> = {
    reviewer: "You are a code reviewer. Focus on code quality, correctness, and best practices.",
    debugger: "You are a debugger. Focus on identifying and diagnosing issues.",
    refactorer: "You are a code refactoring specialist. Focus on improving code structure.",
    tester: "You are a test engineer. Focus on test coverage and test quality.",
    full: "You are a full-access agent. You have access to all tools.",
  };

  const roleDesc = decl.role !== undefined
    ? roleDescriptions[decl.role] ?? ""
    : "";

  return `## Role: ${decl.name}
${roleDesc}
${decl.description}`;
}

/**
 * 鏋勫缓闈炲苟琛屾ā寮忕殑鎽樿銆? */
function buildNonParallelSummary(skill: SkillDefinition): string {
  return `Skill "${skill.name}" does not declare parallel subagents. Manual execution required.`;
}

/**
 * 鏋勫缓鑱氬悎鍚庣殑鎽樿鏂囨湰銆? */
function buildAggregatedSummary(
  skill: SkillDefinition,
  teamResult: ParallelTeamResult,
): string {
  const lines: string[] = [
    `## Skill: ${skill.name} 鈥?Parallel Execution Summary`,
    "",
    `**Strategy**: ${teamResult.strategy}`,
    `**Overall**: ${teamResult.success ? "鉁?Success" : "鉂?Failed"}`,
    `**Duration**: ${teamResult.totalDurationMs}ms`,
    "",
    "### Member Results",
    "",
  ];

  for (const member of teamResult.memberResults) {
    const status = member.success ? "Success" : "Failed";
    const duration = `${member.durationMs}ms`;
    const error = member.error !== undefined ? ` (${member.error})` : "";
    lines.push(`- ${status} **${member.taskId}**: ${duration}${error}`);
  }

  if (teamResult.aggregatedResult !== null && teamResult.aggregatedResult !== undefined) {
    lines.push("", "### Aggregated Result", "");
    if (typeof teamResult.aggregatedResult === "string") {
      lines.push(teamResult.aggregatedResult);
    } else if (Array.isArray(teamResult.aggregatedResult)) {
      for (const item of teamResult.aggregatedResult) {
        if (typeof item === "string") {
          lines.push(`- ${item}`);
        } else if (typeof item === "object" && item !== null) {
          const obj = item as Record<string, unknown>;
          if (obj.taskId !== undefined) {
            const status = obj.success ? "Success" : "Failed";
            lines.push(`- ${status} ${String(obj.taskId)}`);
          }
        }
      }
    }
  }

  return lines.join("\n");
}


