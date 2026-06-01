/**
 * 多步权限检查链 — 有序多步检查管线。
 *
 * 阶段 C.1: 将单次 canUseTool 检查升级为有序多步检查链。
 * 阶段 C.2: 集成拒绝追踪断路器。
 *
 * 检查链设计（按优先级从高到低）：
 * Phase 0:   Hardline 无条件阻止 → 立即返回 deny（绝对不可绕过）
 * Phase 1.1: Deny 规则匹配 → 立即返回 deny（override-proof）
 * Phase 1.2: Ask 规则匹配 → 返回 ask
 * Plan 模式硬权限检查（override-proof）
 * Phase 1.3: tool.checkPermissions() → 工具自身判断
 * Phase 1.4: 工具返回 deny → 返回 deny
 * Phase 1.5: requiresUserInteraction → 返回 ask
 * Phase 1.6: 内容级 Ask 规则 → 返回 ask（override-proof）
 * Phase 1.7: 安全检查（敏感路径）→ 返回 ask（override-proof）
 * Phase 2.1: override 模式 → 返回 allow
 * Phase 2.2: Allow 规则 → 返回 allow
 * Phase 3: 默认 → 返回 ask（Fail-Closed）
 *
 * RULES_2-2: Fail-Closed 默认值 — 不确定时选更安全的默认值。
 * RULES_2-5: 策略模式 > 条件分支。
 */

import type { Tool, ToolUseContext } from "../interfaces/tool";
import type {
  PermissionResult,
  PermissionVerdict,
  PermissionRule,
} from "../types/permission";
import {
  denyPermission,
  askUserPermission,
  allowPermission,
  isDenied,
  isAskUser,
  isAllowed,
} from "../types/permission";
import type { AgentModeContext } from "../types/mode";
import { isPlanMode } from "../types/mode";
import { checkPlanModePermission } from "../core/agent/plan-mode";
import {
  countRejection,
  countApproval,
  requiresUserFallback,
  type RejectionCounter,
} from "./rejection-counter";
import { PermissionAuditLog, type PermissionAuditConfig } from "./permission-audit";
import { defaultLogger } from "../observability/logger";
import { checkHardline, type HardlinePattern } from "../security/hardline";

// ─── 权限检查链配置 ───

export interface PermissionChainConfig {
  /** 自定义权限规则（按优先级排序） */
  readonly rules?: readonly PermissionRule[];
  /** 是否启用 override 模式（跳过 Phase 2 之前的非 override-proof 检查） */
  readonly overrideMode?: boolean;
  /** Agent 模式上下文（用于 Plan 模式硬权限检查） */
  readonly modeContext?: AgentModeContext;
  /** 安全检查回调（敏感路径检测） */
  readonly safetyCheck?: (toolName: string, input: Record<string, unknown>) => PermissionResult | undefined;
  /** 内容安全检查回调 */
  readonly contentSafetyCheck?: (toolName: string, input: Record<string, unknown>) => PermissionResult | undefined;
  /** C.2: 拒绝追踪断路器状态（传入当前状态，返回更新后状态） */
  readonly rejectionCounter?: RejectionCounter;
  /** C.3: 权限审计日志实例 */
  readonly auditLog?: PermissionAuditLog;
  /** Phase 0: 额外的 Hardline 模式（内置模式不可移除，仅可追加） */
  readonly additionalHardlinePatterns?: readonly HardlinePattern[];
}

// ─── 权限检查结果（含决策原因） ───

export interface PermissionChainResult {
  readonly result: PermissionResult;
  readonly verdict: PermissionVerdict;
  readonly durationMs: number;
  /** C.2: 更新后的断路器状态（如果配置了 rejectionCounter） */
  readonly updatedRejectionCounter?: RejectionCounter;
}

// ─── 规则匹配辅助 ───

function matchPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${regexStr}$`).test(toolName);
  } catch {
    return pattern === toolName;
  }
}

// ─── evaluateToolAccess ───

/**
 * 多步权限检查链 — 有序评估工具访问权限。
 *
 * C.2: 所有返回路径统一经过断路器更新。
 *
 * @param toolName - 工具名称
 * @param input - 工具输入
 * @param tool - 工具实例
 * @param context - 工具使用上下文
 * @param config - 检查链配置
 * @returns PermissionChainResult - 权限结果 + 决策原因 + 耗时 + 断路器状态
 */
export async function evaluateToolAccess(
  toolName: string,
  input: Record<string, unknown>,
  tool: Tool,
  context: ToolUseContext,
  config?: PermissionChainConfig,
): Promise<PermissionChainResult> {
  const startTime = Date.now();
  const rules = config?.rules ?? [];
  const overrideMode = config?.overrideMode ?? false;
  const logger = defaultLogger.child("permission-chain");

  // 内部构建结果，最后统一经过断路器
  let chainResult: { result: PermissionResult; verdict: PermissionVerdict } | undefined;

  // ─── Phase 0: Hardline 无条件阻止（绝对不可绕过） ───
  const hardlineResult = checkHardline(toolName, input, config?.additionalHardlinePatterns);
  if (hardlineResult.blocked) {
    chainResult = {
      result: denyPermission(`HARDLINE: ${hardlineResult.reason}`),
      verdict: {
        phase: "hardlineBlock",
        reason: hardlineResult.reason,
        patternId: hardlineResult.patternId,
      },
    };
  }

  if (!chainResult) {
  // ─── Phase 1.1: Deny 规则匹配（override-proof） ───
  for (const rule of rules) {
    if (rule.behavior === "deny" && matchPattern(rule.pattern, toolName)) {
      chainResult = {
        result: denyPermission(rule.reason),
        verdict: { phase: "matchedDenyRule", reason: rule.reason, ruleId: rule.id },
      };
      break;
    }
  }

  if (!chainResult) {
    // ─── Phase 1.2: Ask 规则匹配 ───
    for (const rule of rules) {
      if (rule.behavior === "ask" && matchPattern(rule.pattern, toolName)) {
        chainResult = {
          result: askUserPermission(rule.reason),
          verdict: { phase: "matchedAskRule", reason: rule.reason, ruleId: rule.id },
        };
        break;
      }
    }
  }

  if (!chainResult) {
    // ─── Plan 模式硬权限检查（override-proof） ───
    if (config?.modeContext && isPlanMode(config.modeContext)) {
      const modeResult = checkPlanModePermission(config.modeContext, toolName);
      if (isDenied(modeResult)) {
        chainResult = {
          result: modeResult,
          verdict: { phase: "safetyCheck", reason: modeResult.reason },
        };
      }
    }
  }

  if (!chainResult) {
    // ─── Phase 1.3-1.5: 工具自身 checkPermissions ───
    try {
      const toolResult = await tool.checkPermissions(input, context);

      if (isDenied(toolResult)) {
        chainResult = {
          result: toolResult,
          verdict: { phase: "toolDeny", reason: toolResult.reason },
        };
      } else if (isAskUser(toolResult)) {
        chainResult = {
          result: toolResult,
          verdict: {
            phase: "requiresUserInteraction",
            reason: toolResult.reason ?? "Tool requires user interaction",
          },
        };
      }
    } catch (error) {
      logger.warn(`Tool ${toolName} checkPermissions threw error, falling back to ask`, {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      chainResult = {
        result: askUserPermission(
          `Tool ${toolName} permission check failed`,
          `Tool ${toolName} 的权限检查发生异常，需要人工确认。`,
        ),
        verdict: { phase: "toolSelfCheck", reason: "Tool checkPermissions threw error" },
      };
    }
  }

  if (!chainResult) {
    // ─── Phase 1.6: 内容级 Ask 规则（override-proof） ───
    if (config?.contentSafetyCheck) {
      const contentResult = config.contentSafetyCheck(toolName, input);
      if (contentResult !== undefined && (isDenied(contentResult) || isAskUser(contentResult))) {
        chainResult = {
          result: contentResult,
          verdict: {
            phase: "contentSafetyAsk",
            reason: isDenied(contentResult) ? contentResult.reason : (contentResult.reason ?? "Content safety check"),
          },
        };
      }
    }
  }

  if (!chainResult) {
    // ─── Phase 1.7: 安全检查（敏感路径，override-proof） ───
    if (config?.safetyCheck) {
      const safetyResult = config.safetyCheck(toolName, input);
      if (safetyResult !== undefined && (isDenied(safetyResult) || isAskUser(safetyResult))) {
        chainResult = {
          result: safetyResult,
          verdict: {
            phase: "safetyCheck",
            reason: isDenied(safetyResult) ? safetyResult.reason : (safetyResult.reason ?? "Safety check"),
          },
        };
      }
    }
  }

  if (!chainResult) {
    // ─── Phase 2.1: Override 模式 ───
    if (overrideMode) {
      chainResult = {
        result: allowPermission(),
        verdict: { phase: "overrideMode", reason: "Override mode enabled" },
      };
    }
  }

  if (!chainResult) {
    // ─── Phase 2.2: Allow 规则匹配 ───
    for (const rule of rules) {
      if (rule.behavior === "allow" && matchPattern(rule.pattern, toolName)) {
        chainResult = {
          result: allowPermission(),
          verdict: { phase: "matchedAllowRule", reason: rule.reason, ruleId: rule.id },
        };
        break;
      }
    }
  }

  if (!chainResult) {
    // ─── Phase 3: 默认 → ask（Fail-Closed） ───
    chainResult = {
      result: askUserPermission(
        `Tool ${toolName} requires user confirmation`,
        `工具 ${toolName} 需要用户确认才能执行。`,
      ),
      verdict: { phase: "defaultAsk", reason: "No matching rule, default to ask" },
    };
  }
  }

  // ─── C.2: 断路器更新（统一处理所有路径） ───
  const durationMs = Date.now() - startTime;
  const baseResult: PermissionChainResult = {
    result: chainResult.result,
    verdict: chainResult.verdict,
    durationMs,
  };

  // ─── C.3: 审计日志记录 ───
  if (config?.auditLog) {
    const decision = isDenied(baseResult.result)
      ? "deny"
      : isAskUser(baseResult.result)
        ? "ask_user"
        : "allow";

    config.auditLog.record(
      config.auditLog.createEntry({
        toolName,
        decision,
        verdictPhase: baseResult.verdict.phase,
        reason: baseResult.verdict.reason,
        durationMs,
      }),
    );
  }

  if (config?.rejectionCounter !== undefined) {
    const isDenyResult = isDenied(baseResult.result);
    const updatedCounter = isDenyResult
      ? countRejection(config.rejectionCounter)
      : countApproval(config.rejectionCounter);

    if (isDenyResult && requiresUserFallback(updatedCounter)) {
      logger.warn(`Rejection circuit breaker threshold reached for ${toolName}`, {
        toolName,
        consecutiveRejections: updatedCounter.consecutiveRejections,
        totalRejections: updatedCounter.totalRejections,
      });
    }

    return { ...baseResult, updatedRejectionCounter: updatedCounter };
  }

  return baseResult;
}
