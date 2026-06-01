/**
 * 权限审计日志 — 环形缓冲区 + 慢决策检测。
 *
 * 阶段 C.3: 记录每次权限决策的审计事件，
 * 使用环形缓冲区（O(capacity) 有界）避免内存泄漏，
 * 检测慢决策（>500ms）并记录 warn 日志。
 *
 * RULES_2-15: 环形缓冲去重。
 * RULES_2-16: 滑动窗口限流。
 */

import type { PermissionAuditEntry } from "../types/permission";
import { defaultLogger } from "../observability/logger";

// ─── 环形缓冲区 ───

export class RingBuffer<T> {
  private readonly buffer: Array<T | undefined>;
  private head = 0;
  private count = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array<T | undefined>(capacity);
  }

  /** 添加元素（O(1)，满时覆盖最旧元素） */
  push(item: T): void {
    const index = (this.head + this.count) % this.capacity;
    if (this.count < this.capacity) {
      this.buffer[index] = item;
      this.count++;
    } else {
      // 缓冲区满：覆盖最旧元素
      this.buffer[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** 获取所有元素（按时间顺序，从旧到新） */
  toArray(): readonly T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.capacity;
      const item = this.buffer[index];
      if (item !== undefined) {
        result.push(item);
      }
    }
    return result;
  }

  /** 当前元素数量 */
  get size(): number {
    return this.count;
  }

  /** 是否已满 */
  get isFull(): boolean {
    return this.count >= this.capacity;
  }
}

// ─── 审计日志配置 ───

export interface PermissionAuditConfig {
  /** 环形缓冲区容量（默认 1000） */
  readonly bufferCapacity?: number;
  /** 慢决策阈值（毫秒，默认 500） */
  readonly slowDecisionThresholdMs?: number;
}

// ─── PermissionAuditLog ───

export class PermissionAuditLog {
  private readonly buffer: RingBuffer<PermissionAuditEntry>;
  private readonly slowThresholdMs: number;
  private readonly logger;

  constructor(config?: PermissionAuditConfig) {
    this.buffer = new RingBuffer(config?.bufferCapacity ?? 1000);
    this.slowThresholdMs = config?.slowDecisionThresholdMs ?? 500;
    this.logger = defaultLogger.child("permission-audit");
  }

  /**
   * 记录权限审计事件。
   *
   * - 写入环形缓冲区
   * - 检测慢决策（>slowThresholdMs）并记录 warn 日志
   */
  record(entry: PermissionAuditEntry): void {
    this.buffer.push(entry);

    // 慢决策检测
    if (entry.durationMs > this.slowThresholdMs) {
      this.logger.warn(`Slow permission decision for ${entry.toolName}`, {
        toolName: entry.toolName,
        decision: entry.decision,
        verdictPhase: entry.verdictPhase,
        durationMs: entry.durationMs,
        thresholdMs: this.slowThresholdMs,
      });
    }
  }

  /**
   * 创建审计记录。
   */
  createEntry(options: {
    readonly toolName: string;
    readonly decision: "allow" | "deny" | "ask_user";
    readonly verdictPhase: string;
    readonly reason: string;
    readonly durationMs: number;
    readonly inputSnapshot?: string;
  }): PermissionAuditEntry {
    return {
      timestamp: Date.now(),
      ...options,
    };
  }

  /** 获取所有审计记录（按时间顺序） */
  getEntries(): readonly PermissionAuditEntry[] {
    return this.buffer.toArray();
  }

  /** 获取审计记录数量 */
  get size(): number {
    return this.buffer.size;
  }

  /** 获取指定工具的审计记录 */
  getEntriesForTool(toolName: string): readonly PermissionAuditEntry[] {
    return this.buffer.toArray().filter((e) => e.toolName === toolName);
  }

  /** 获取指定时间范围内的审计记录 */
  getEntriesSince(sinceTimestamp: number): readonly PermissionAuditEntry[] {
    return this.buffer.toArray().filter((e) => e.timestamp >= sinceTimestamp);
  }

  /** 获取拒绝记录 */
  getDenials(): readonly PermissionAuditEntry[] {
    return this.buffer.toArray().filter((e) => e.decision === "deny");
  }

  /** 获取慢决策记录 */
  getSlowDecisions(): readonly PermissionAuditEntry[] {
    return this.buffer.toArray().filter((e) => e.durationMs > this.slowThresholdMs);
  }

  /** 清空审计日志 */
  clear(): void {
    // H5: 重新创建 RingBuffer 实现清空
    const newBuffer = new RingBuffer<PermissionAuditEntry>(this.buffer.capacity);
    (this as unknown as { buffer: RingBuffer<PermissionAuditEntry> }).buffer = newBuffer;
  }
}
