/**
 * Plan Mode — 只读规划模式（硬权限边界）。
 *
 * 在执行修改前，Agent 被限制为只使用只读工具（file_read/glob）
 * 分析代码库并制定执行计划。用户确认后才进入执行阶段。
 *
 * 阶段 B.2: 硬权限集成 — Plan 模式下写入类工具被拦截，
 *   返回 denyPermission 而非静默过滤。使用 AgentModeContext 驱动权限决策。
 *
 * 阶段 B.3: 审批流程 — Plan 生成的执行计划必须经过用户确认，
 *   支持两阶段提交（先注册再等待），防止竞态。
 *
 * 参考：工作原理.md L1136-1204
 */

import type { Tool } from "../../interfaces/tool";
import type { PermissionResult, PermissionDeny, PermissionAllow } from "../../types/permission";
import { denyPermission, allowPermission, isDenied } from "../../types/permission";
import { filterToolsForAgent } from "./tool-filter";
import {
  type AgentModeContext,
  type RestrictedAbility,
  isPlanMode,
  isToolRestricted,
  getToolRestriction,
} from "../../types/mode";
import { EvoAgentError } from "../../utils/errors";
import { defaultLogger } from "../../observability/logger";

// ─── Plan Mode 类型 ───

/** 计划步骤 */
export interface PlanStep {
  readonly id: string;
  readonly description: string;
  readonly files: readonly string[];
  readonly risk: "low" | "medium" | "high";
  readonly reason: string;
}

/** 执行计划 */
export interface ExecutionPlanResult {
  readonly steps: readonly PlanStep[];
  readonly summary: string;
  readonly totalRisk: "low" | "medium" | "high";
  readonly affectedFiles: readonly string[];
  readonly createdAt: number;
  /** M2: 计划文件路径（将计划写入磁盘） */
  readonly planFilePath?: string;
}

/** 计划确认状态 */
export type PlanConfirmationStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "modified";

/** 计划确认结果 */
export interface PlanConfirmation {
  readonly status: PlanConfirmationStatus;
  readonly feedback?: string;
  readonly modifiedSteps?: readonly PlanStep[];
  /** M3: 审批者（支持多级审批） */
  readonly reviewer?: "user" | "agent" | "system";
}

// ─── Plan Mode 配置 ───

export interface PlanModeConfig {
  /** 是否启用 Plan Mode */
  readonly enabled: boolean;
  /** 计划确认回调（返回用户确认结果） */
  readonly onPlanGenerated?: (plan: ExecutionPlanResult) => Promise<PlanConfirmation>;
  /** 自动批准（测试用） */
  readonly autoApprove?: boolean;
}

// ─── B.2: Plan 模式硬权限检查器 ───

/**
 * Plan 模式写入类工具黑名单。
 *
 * 这些工具在 Plan 模式下被硬拦截，返回 denyPermission。
 */
const PLAN_MODE_WRITE_TOOLS = new Set<string>([
  "file_write",
  "file_edit",
  "bash",
  "execute_command",
  "delete_file",
  "create_directory",
]);

/**
 * checkPlanModePermission — B.2: 硬权限检查。
 *
 * 在 Plan 模式下，写入类工具被硬拦截，返回 denyPermission。
 * 使用 AgentModeContext 中的 restrictedAbilities 驱动决策。
 *
 * @param modeContext - 当前 Agent 模式上下文
 * @param toolName - 要使用的工具名称
 * @returns PermissionResult — allow 或 deny
 */
export function checkPlanModePermission(
  modeContext: AgentModeContext,
  toolName: string,
): PermissionResult {
  // 非 Plan 模式：放行
  if (!isPlanMode(modeContext)) {
    return allowPermission();
  }

  // 检查 restrictedAbilities（由 switchAgentMode 设置）
  const restriction = getToolRestriction(modeContext, toolName);
  if (restriction) {
    defaultLogger.child("plan-mode").warn(
      `Tool '${toolName}' blocked by Plan mode restriction`,
      { toolName, restriction: restriction.restriction, origin: restriction.origin },
    );
    return denyPermission(
      `Plan 模式限制: ${restriction.restriction} (来源: ${restriction.origin})`,
    );
  }

  // 检查写入类工具黑名单
  if (PLAN_MODE_WRITE_TOOLS.has(toolName)) {
    defaultLogger.child("plan-mode").warn(
      `Tool '${toolName}' blocked in Plan mode (write tool)`,
      { toolName },
    );
    return denyPermission(
      `Plan 模式下禁止使用写入类工具: ${toolName}。请先完成规划，等待用户确认后再执行。`,
    );
  }

  return allowPermission();
}

// ─── B.3: 两阶段提交审批流程 ───

/** 审批状态 */
export type ApprovalState = "idle" | "pending" | "approved" | "rejected" | "expired";

/** 审批票据 */
export interface ApprovalTicket {
  readonly planId: string;
  readonly state: ApprovalState;
  readonly plan: ExecutionPlanResult;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly confirmation?: PlanConfirmation;
}

/** 审批配置 */
export interface ApprovalConfig {
  /** 审批超时（毫秒），默认 300000 (5 分钟) */
  readonly timeoutMs?: number;
}

// ─── Plan Mode 管理器 ───

export interface PlanModeManager {
  /** 是否处于 Plan Mode */
  readonly isActive: boolean;
  /** 获取只读工具列表 */
  getReadonlyTools(allTools: readonly Tool[]): readonly Tool[];
  /** 格式化计划输出 */
  formatPlanOutput(plan: ExecutionPlanResult): string;
  /** 评估计划风险 */
  assessRisk(steps: readonly PlanStep[]): "low" | "medium" | "high";
  /** B.2: 硬权限检查 */
  checkPermission(modeContext: AgentModeContext, toolName: string): PermissionResult;
  /** B.3: 提交计划等待审批（两阶段提交） */
  submitForApproval(plan: ExecutionPlanResult, config?: ApprovalConfig): ApprovalTicket;
  /** B.3: 确认审批 */
  confirmApproval(ticketId: string, confirmation: PlanConfirmation): ApprovalTicket;
  /** B.3: 获取当前审批票据 */
  getCurrentTicket(): ApprovalTicket | undefined;
  /** B.3: 检查审批是否有效 */
  isApprovalValid(ticket: ApprovalTicket): boolean;
  /** 等待用户确认（兼容旧接口） */
  waitForConfirmation(plan: ExecutionPlanResult): Promise<PlanConfirmation>;
}

export function createPlanModeManager(config: PlanModeConfig): PlanModeManager {
  const isActive = config.enabled;
  const logger = defaultLogger.child("plan-mode");

  // B.3: 审批状态管理
  let currentTicket: ApprovalTicket | undefined;

  function getReadonlyTools(allTools: readonly Tool[]): readonly Tool[] {
    if (!isActive) return allTools;
    const result = filterToolsForAgent(allTools, { planMode: true });
    return result.tools;
  }

  function formatPlanOutput(plan: ExecutionPlanResult): string {
    const riskEmoji = {
      low: "🟢",
      medium: "🟡",
      high: "🔴",
    };

    const sections: string[] = [
      "# 📋 Execution Plan",
      "",
      `**Summary**: ${plan.summary}`,
      `**Overall Risk**: ${riskEmoji[plan.totalRisk]} ${plan.totalRisk.toUpperCase()}`,
      `**Affected Files**: ${plan.affectedFiles.length}`,
      "",
      "## Steps",
      "",
    ];

    for (const step of plan.steps) {
      sections.push(
        `### Step ${step.id}: ${step.description}`,
        "",
        `- **Risk**: ${riskEmoji[step.risk]} ${step.risk.toUpperCase()}`,
        `- **Reason**: ${step.reason}`,
        `- **Files**: ${step.files.length > 0 ? step.files.join(", ") : "None"}`,
        "",
      );
    }

    sections.push("---", "", "⏳ Waiting for confirmation... (approve/reject/modify)");

    return sections.join("\n");
  }

  function assessRisk(steps: readonly PlanStep[]): "low" | "medium" | "high" {
    if (steps.length === 0) return "low";

    let highCount = 0;
    let mediumCount = 0;

    for (const step of steps) {
      if (step.risk === "high") highCount++;
      else if (step.risk === "medium") mediumCount++;
    }

    if (highCount > 0) return "high";
    if (mediumCount > steps.length / 2) return "high";
    if (mediumCount > 0) return "medium";
    return "low";
  }

  // B.2: 硬权限检查
  function checkPermission(modeContext: AgentModeContext, toolName: string): PermissionResult {
    return checkPlanModePermission(modeContext, toolName);
  }

  // B.3: 两阶段提交 — 先注册再等待
  function submitForApproval(
    plan: ExecutionPlanResult,
    approvalConfig?: ApprovalConfig,
  ): ApprovalTicket {
    const timeoutMs = approvalConfig?.timeoutMs ?? 300_000;
    const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const ticket: ApprovalTicket = {
      planId,
      state: "pending",
      plan,
      createdAt: Date.now(),
      expiresAt: Date.now() + timeoutMs,
    };

    currentTicket = ticket;
    logger.info(`Plan submitted for approval: ${planId}`, {
      planId,
      steps: plan.steps.length,
      totalRisk: plan.totalRisk,
      timeoutMs,
    });

    return ticket;
  }

  function confirmApproval(
    ticketId: string,
    confirmation: PlanConfirmation,
  ): ApprovalTicket {
    if (!currentTicket || currentTicket.planId !== ticketId) {
      throw new EvoAgentError(
        `Invalid approval ticket: ${ticketId}`,
        "INVALID_APPROVAL_TICKET",
        { context: { ticketId, currentTicketId: currentTicket?.planId } },
      );
    }

    if (currentTicket.state !== "pending") {
      throw new EvoAgentError(
        `Approval ticket already processed: ${currentTicket.state}`,
        "APPROVAL_ALREADY_PROCESSED",
        { context: { ticketId, state: currentTicket.state } },
      );
    }

    // 检查是否过期
    if (Date.now() > currentTicket.expiresAt) {
      const expiredTicket: ApprovalTicket = {
        ...currentTicket,
        state: "expired",
        confirmation,
      };
      currentTicket = expiredTicket;
      logger.warn(`Approval ticket expired: ${ticketId}`, { ticketId });
      throw new EvoAgentError(
        `Approval ticket expired: ${ticketId}`,
        "APPROVAL_EXPIRED",
        { context: { ticketId, expiresAt: currentTicket.expiresAt } },
      );
    }

    const newState: ApprovalState = confirmation.status === "approved" ? "approved" : "rejected";
    const updatedTicket: ApprovalTicket = {
      ...currentTicket,
      state: newState,
      confirmation,
    };
    currentTicket = updatedTicket;

    logger.info(`Plan approval ${newState}: ${ticketId}`, {
      planId: ticketId,
      status: confirmation.status,
    });

    return updatedTicket;
  }

  function getCurrentTicket(): ApprovalTicket | undefined {
    return currentTicket;
  }

  function isApprovalValid(ticket: ApprovalTicket): boolean {
    if (ticket.state !== "approved") return false;
    if (Date.now() > ticket.expiresAt) return false;
    return true;
  }

  async function waitForConfirmation(plan: ExecutionPlanResult): Promise<PlanConfirmation> {
    if (config.autoApprove) {
      return { status: "approved" };
    }

    if (config.onPlanGenerated) {
      return config.onPlanGenerated(plan);
    }

    return { status: "approved" };
  }

  return {
    isActive,
    getReadonlyTools,
    formatPlanOutput,
    assessRisk,
    checkPermission,
    submitForApproval,
    confirmApproval,
    getCurrentTicket,
    isApprovalValid,
    waitForConfirmation,
  };
}
