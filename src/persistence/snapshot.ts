/**
 * 快照管理 — 创建/回滚/过期清理。
 *
 * RULES_2-7: 原子写入。
 * RULES_2-16: 代际计数器（版本号检测过期快照）。
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { atomicWriteJSON, atomicReadJSON } from "./atomic-write";

// ─── 快照元数据 ───

export interface SnapshotMeta {
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly reason: string;
  readonly isAuto: boolean;
  readonly version: number;
}

// ─── 快照管理选项 ───

export interface SnapshotManagerOptions {
  readonly snapshotsDir: string;
  readonly maxCount?: number;
  readonly maxAgeDays?: number;
}

// ─── 快照管理器 ───

export class SnapshotManager {
  private readonly snapshotsDir: string;
  private readonly maxCount: number;
  private readonly maxAgeMs: number;

  constructor(options: SnapshotManagerOptions) {
    this.snapshotsDir = options.snapshotsDir;
    this.maxCount = options.maxCount ?? 10;
    this.maxAgeMs = (options.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000;
  }

  /**
   * 创建快照。
   *
   * @param data - 要快照的数据
   * @param reason - 创建原因
   * @param isAuto - 是否自动创建
   * @param version - 当前版本号
   */
  async create(
    data: unknown,
    reason: string,
    isAuto: boolean,
    version: number,
  ): Promise<SnapshotMeta> {
    const snapshotId = `snap_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const meta: SnapshotMeta = {
      snapshotId,
      createdAt: new Date().toISOString(),
      reason,
      isAuto,
      version,
    };

    const filePath = this.getSnapshotPath(snapshotId);
    await atomicWriteJSON(filePath, {
      meta,
      data,
    });

    // 创建后检查是否需要清理
    await this.cleanup();

    return meta;
  }

  /**
   * 回滚到指定快照。
   *
   * @param snapshotId - 快照 ID
   * @returns 快照数据
   */
  async rollback(snapshotId: string): Promise<unknown> {
    const filePath = this.getSnapshotPath(snapshotId);
    const snapshot = await atomicReadJSON<{ meta: SnapshotMeta; data: unknown }>(
      filePath,
    );

    if (snapshot === null) {
      throw new Error(`快照不存在: ${snapshotId}`);
    }

    return snapshot.data;
  }

  /**
   * 列出所有快照。
   */
  async listAll(): Promise<SnapshotMeta[]> {
    if (!existsSync(this.snapshotsDir)) {
      return [];
    }

    const files = await readdir(this.snapshotsDir);
    const metas: SnapshotMeta[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(this.snapshotsDir, file);
      const snapshot = await atomicReadJSON<{ meta: SnapshotMeta }>(filePath);
      if (snapshot !== null) {
        metas.push(snapshot.meta);
      }
    }

    // 按创建时间倒序排列
    return metas.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  /**
   * 获取最新快照。
   */
  async getLatest(): Promise<SnapshotMeta | undefined> {
    const all = await this.listAll();
    return all[0];
  }

  /**
   * 清理过期快照。
   * 优先删除自动创建的快照。
   * RULES_2-10: 两层截断（数量上限 + 时间上限）。
   */
  async cleanup(): Promise<number> {
    const all = await this.listAll();
    if (all.length <= this.maxCount) return 0;

    const now = Date.now();
    let deleted = 0;

    for (const meta of all) {
      if (all.length - deleted <= this.maxCount) break;

      const age = now - new Date(meta.createdAt).getTime();
      // 优先删除自动创建的或过期的快照
      if (meta.isAuto || age > this.maxAgeMs) {
        const filePath = this.getSnapshotPath(meta.snapshotId);
        try {
          const { unlink } = await import("node:fs/promises");
          await unlink(filePath);
          deleted++;
        } catch {
          // 忽略删除失败
        }
      }
    }

    return deleted;
  }

  private getSnapshotPath(snapshotId: string): string {
    return join(this.snapshotsDir, `${snapshotId}.json`);
  }
}

/**
 * 创建快照管理器实例。
 */
export function createSnapshotManager(
  options: SnapshotManagerOptions,
): SnapshotManager {
  return new SnapshotManager(options);
}
