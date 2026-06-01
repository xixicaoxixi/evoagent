/**
 * 回退存储 — SEC-07 修复。
 *
 * 当主存储失败时自动回退到次存储。
 * 支持从次存储迁移到主存储。
 *
 * 基于安全最佳实践的回退存储方案。
 */

import type { CredentialStore, CredentialStoreData } from "./storage";

/**
 * 创建回退存储。
 *
 * 逻辑：
 * - 读取：先尝试主存储，失败则回退到次存储
 * - 写入：先尝试主存储，成功则删除次存储中的旧条目（迁移）
 * - 删除：同时删除两个存储
 *
 * @param primary - 主存储（优先使用）
 * @param secondary - 次存储（回退方案）
 */
export function createChainedCredentialStore(
  primary: CredentialStore,
  secondary: CredentialStore,
): CredentialStore {
  return {
    name: `${primary.name}-with-${secondary.name}-fallback`,

    read(): CredentialStoreData {
      const result = primary.read();
      if (result !== null && result !== undefined) {
        return result;
      }
      return secondary.read() ?? {};
    },

    async readAsync(): Promise<CredentialStoreData | null> {
      const result = await primary.readAsync();
      if (result !== null && result !== undefined) {
        return result;
      }
      return (await secondary.readAsync()) ?? {};
    },

    update(data: CredentialStoreData): { success: boolean; warning?: string } {
      // 记录更新前主存储的状态
      const primaryDataBefore = primary.read();

      const result = primary.update(data);

      if (result.success) {
        // 首次迁移到主存储时，删除次存储中的旧凭证
        if (primaryDataBefore === null) {
          secondary.delete();
        }
        return result;
      }

      // 主存储失败，回退到次存储
      const fallbackResult = secondary.update(data);

      if (fallbackResult.success) {
        // 主存储可能有旧的条目会遮盖次存储的新数据
        if (primaryDataBefore !== null) {
          primary.delete();
        }
        const warningOpt = fallbackResult.warning !== undefined ? { warning: fallbackResult.warning } : {};
        return { success: true, ...warningOpt };
      }

      return { success: false };
    },

    delete(): boolean {
      const primarySuccess = primary.delete();
      const secondarySuccess = secondary.delete();
      return primarySuccess || secondarySuccess;
    },
  };
}
