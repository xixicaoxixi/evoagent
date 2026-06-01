/**
 * Token 计费追踪 — 按模型聚合 + 会话持久化。
 *
 * 参考 `代码片段_上下文记忆与通信协议` #54 `formatTotalCost()`。
 *
 * 设计原则：
 * - 按模型归一化聚合 token 用量和成本
 * - 支持多维度用量追踪（input/output/cache_read/cache_write）
 * - 成本格式化（大额 2 位小数，小额 4 位）
 */

// ─── 模型用量 ───

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly costUSD: number;
}

// ─── 成本追踪条目 ───

export interface CostEntry {
  readonly model: string;
  readonly usage: ModelUsage;
  readonly timestamp: number;
}

// ─── 成本追踪器接口 ───

export interface CostTracker {
  /** 记录一次 API 调用的 token 用量 */
  recordUsage(model: string, usage: ModelUsage): void;
  /** 获取总成本（USD） */
  getTotalCost(): number;
  /** 按模型获取聚合用量 */
  getUsageByModel(): ReadonlyMap<string, ModelUsage>;
  /** 获取总用量 */
  getTotalUsage(): ModelUsage;
  /** 格式化总成本 */
  formatTotalCost(): string;
  /** 格式化模型用量 */
  formatModelUsage(): string;
  /** 重置所有记录 */
  reset(): void;
}

// ─── 模型名称归一化 ───

function getCanonicalName(model: string): string {
  const lower = model.toLowerCase();

  if (lower.startsWith("kimi") || lower.startsWith("moonshot")) {
    return lower.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  }

  if (lower.startsWith("glm") || lower.startsWith("chatglm")) {
    return lower.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  }

  if (lower.startsWith("deepseek")) {
    return lower.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  }

  const match = model.match(/^([a-z]+-[0-9.]+(?:-[a-z]+)?)(?:-\d{4}-\d{2}-\d{2})?$/i);
  if (match) return match[1]!.toLowerCase();
  return lower;
}

// ─── 成本格式化 ───

function formatCost(cost: number): string {
  if (cost > 0.5) {
    return `$${Math.round(cost * 100) / 100}`;
  }
  return `$${cost.toFixed(4)}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// ─── 创建成本追踪器 ───

export function createCostTracker(): CostTracker {
  const usageByModel = new Map<string, ModelUsage>();

  function recordUsage(model: string, usage: ModelUsage): void {
    const canonical = getCanonicalName(model);
    const existing = usageByModel.get(canonical);

    if (existing) {
      usageByModel.set(canonical, {
        inputTokens: existing.inputTokens + usage.inputTokens,
        outputTokens: existing.outputTokens + usage.outputTokens,
        cacheReadInputTokens: existing.cacheReadInputTokens + usage.cacheReadInputTokens,
        cacheCreationInputTokens: existing.cacheCreationInputTokens + usage.cacheCreationInputTokens,
        costUSD: existing.costUSD + usage.costUSD,
      });
    } else {
      usageByModel.set(canonical, { ...usage });
    }
  }

  function getTotalCost(): number {
    let total = 0;
    for (const usage of usageByModel.values()) {
      total += usage.costUSD;
    }
    return total;
  }

  function getUsageByModel(): ReadonlyMap<string, ModelUsage> {
    return usageByModel;
  }

  function getTotalUsage(): ModelUsage {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens = 0;
    let cacheCreationInputTokens = 0;
    let costUSD = 0;

    for (const usage of usageByModel.values()) {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      cacheReadInputTokens += usage.cacheReadInputTokens;
      cacheCreationInputTokens += usage.cacheCreationInputTokens;
      costUSD += usage.costUSD;
    }

    return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD };
  }

  function formatTotalCost(): string {
    const total = getTotalUsage();
    const costStr = formatCost(total.costUSD);
    return [
      `Total cost: ${costStr}`,
      `Usage: ${formatNumber(total.inputTokens)} input, ${formatNumber(total.outputTokens)} output, ${formatNumber(total.cacheReadInputTokens)} cache read, ${formatNumber(total.cacheCreationInputTokens)} cache write`,
    ].join("\n");
  }

  function formatModelUsage(): string {
    if (usageByModel.size === 0) {
      return "Usage: 0 input, 0 output, 0 cache read, 0 cache write";
    }

    const lines: string[] = ["Usage by model:"];
    for (const [model, usage] of usageByModel) {
      const usageStr =
        `${formatNumber(usage.inputTokens)} input, ` +
        `${formatNumber(usage.outputTokens)} output, ` +
        `${formatNumber(usage.cacheReadInputTokens)} cache read, ` +
        `${formatNumber(usage.cacheCreationInputTokens)} cache write ` +
        `(${formatCost(usage.costUSD)})`;
      lines.push(`  ${model}: ${usageStr}`);
    }
    return lines.join("\n");
  }

  function reset(): void {
    usageByModel.clear();
  }

  return {
    recordUsage,
    getTotalCost,
    getUsageByModel,
    getTotalUsage,
    formatTotalCost,
    formatModelUsage,
    reset,
  };
}
