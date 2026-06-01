/**
 * 安全存储抽象层 — SEC-07 修复。
 *
 * 设计原则：
 * - 接口 + 注册表模式（RULES_2-4）
 * - Fail-Closed 默认值（RULES_2-2）
 * - 原子写入（RULES_2-7）
 * - 文件权限 chmod 0o600（仅所有者读写）
 *
 * 基于安全最佳实践的 CredentialStore 接口与明文存储实现。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── 安全存储数据 ───

export interface CredentialStoreData {
  readonly apiKeys?: Readonly<Record<string, string>>;
  readonly hmacKey?: string;
  readonly [key: string]: unknown;
}

// ─── 安全存储接口 ───

export interface CredentialStore {
  /** 存储实现名称 */
  readonly name: string;
  /** 同步读取存储数据 */
  read(): CredentialStoreData | null;
  /** 异步读取存储数据 */
  readAsync(): Promise<CredentialStoreData | null>;
  /** 更新存储数据 */
  update(data: CredentialStoreData): { success: boolean; warning?: string };
  /** 删除存储数据 */
  delete(): boolean;
}

// ─── 明文存储实现（回退方案） ───

export interface FileCredentialStoreConfig {
  /** 存储目录路径 */
  readonly storageDir: string;
  /** 存储文件名（默认 .credentials.json） */
  readonly fileName?: string;
}

/**
 * 创建明文文件存储实现。
 *
 * 安全措施：
 * - 写入后立即 chmod 0o600（仅所有者读写）
 * - 使用原子写入（tmp + rename）
 * - update() 返回警告信息提醒用户凭证以明文存储
 *
 * 基于安全最佳实践的明文文件存储实现。
 */
export function createFileCredentialStore(config: FileCredentialStoreConfig): CredentialStore {
  const fileName = config.fileName ?? ".credentials.json";
  const storageDir = config.storageDir;
  const storagePath = join(storageDir, fileName);

  function ensureDir(): void {
    if (!existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true });
    }
  }

  function safeReadFile(): string | null {
    try {
      return readFileSync(storagePath, { encoding: "utf-8" });
    } catch {
      return null;
    }
  }

  function safeParse(text: string): CredentialStoreData | null {
    try {
      return JSON.parse(text) as CredentialStoreData;
    } catch {
      return null;
    }
  }

  return {
    name: "plaintext",

    read(): CredentialStoreData | null {
      const text = safeReadFile();
      if (text === null) return null;
      return safeParse(text);
    },

    async readAsync(): Promise<CredentialStoreData | null> {
      const text = safeReadFile();
      if (text === null) return null;
      return safeParse(text);
    },

    update(data: CredentialStoreData): { success: boolean; warning?: string } {
      try {
        ensureDir();

        // 原子写入：先写临时文件，再重命名
        const tmpPath = `${storagePath}.tmp`;
        const content = JSON.stringify(data, null, 2);
        writeFileSync(tmpPath, content, { encoding: "utf-8" });

        try {
          // 重命名（原子操作）
          renameSync(tmpPath, storagePath);
        } catch {
          // 清理临时文件
          try { unlinkSync(tmpPath); } catch { /* ignore */ }
          throw new Error("Failed to rename temp file");
        }

        // SECURITY: 设置文件权限为仅所有者读写
        chmodSync(storagePath, 0o600);

        return {
          success: true,
          warning: "Warning: Storing credentials in plaintext.",
        };
      } catch {
        return { success: false };
      }
    },

    delete(): boolean {
      try {
        if (existsSync(storagePath)) {
          unlinkSync(storagePath);
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}
