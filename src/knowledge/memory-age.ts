/**
 * 记忆老化 — 陈旧性检测与警告。
 *
 * 参考 `代码片段_记忆系统与知识管理补充.md` 片段 #1。
 * 为记忆条目提供基于时间的陈旧性评估。
 */

// ─── 常量 ───

const MS_PER_DAY = 86_400_000;

// ─── 老化函数 ───

/**
 * memoryAgeDays — 计算记忆距今天数。
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / MS_PER_DAY));
}

/**
 * memoryAge — 人类可读的年龄字符串。
 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}

/**
 * memoryFreshnessText — 陈旧性警告文本。
 * 超过 1 天的记忆返回警告，提醒模型验证时效性。
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d <= 1) return "";
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  );
}

/**
 * memoryFreshnessNote — 带 system-reminder 标签的陈旧性警告。
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs);
  if (!text) return "";
  return `<system-reminder>${text}</system-reminder>\n`;
}

// ─── 半衰期衰减 ───

/**
 * 半衰期衰减评分 — 基于时间的记忆相关性衰减。
 * 参考 `代码片段_记忆系统与知识管理补充.md` 片段 #7。
 *
 * @param mtimeMs 记忆修改时间
 * @param halfLifeDays 半衰期天数（默认 30 天）
 * @returns 0-1 之间的衰减因子（1 = 全新，0 = 完全衰减）
 */
export function halfLifeDecay(mtimeMs: number, halfLifeDays: number = 30): number {
  const ageDaysFloat = Math.max(0, (Date.now() - mtimeMs) / MS_PER_DAY);
  return Math.pow(0.5, ageDaysFloat / halfLifeDays);
}

/**
 * computeStalenessScore — 计算陈旧性评分（0 = 新鲜，1 = 完全陈旧）。
 */
export function computeStalenessScore(
  mtimeMs: number,
  maxAgeDays: number = 90,
): number {
  const ageDaysFloat = Math.max(0, (Date.now() - mtimeMs) / MS_PER_DAY);
  return Math.min(1.0, ageDaysFloat / maxAgeDays);
}
