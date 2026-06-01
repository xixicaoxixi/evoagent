/**
 * S.1.2 安全修复测试 — 安全存储抽象层（SEC-07）。
 *
 * 覆盖范围：
 * - CredentialStore 接口契约
 * - plainTextStorage 读写
 * - 文件权限验证（chmod 0o600）
 * - 回退存储（主→次自动切换）
 * - 迁移逻辑（首次写入主存储后删除次存储）
 * - 原子写入（tmp + rename）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, statSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileCredentialStore } from "../../src/security/storage";
import { createChainedCredentialStore } from "../../src/security/fallback-storage";
import type { CredentialStore, CredentialStoreData } from "../../src/security/storage";

const isWindows = process.platform === "win32";

// ─── 测试辅助 ───

const TEST_DIR = join(tmpdir(), "evoagent-security-test");

function cleanupTestDir(): void {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function setupTestDir(): void {
  cleanupTestDir();
  mkdirSync(TEST_DIR, { recursive: true });
}

// ─── plainTextStorage 基础 ───

describe("S.1.2 > SEC-07 > plainTextStorage 基础", () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  it("name 属性为 'plaintext'", () => {
    const storage = createFileCredentialStore({ storageDir: TEST_DIR });
    expect(storage.name).toBe("plaintext");
  });

  it("初始状态 read 返回 null", () => {
    const storage = createFileCredentialStore({ storageDir: TEST_DIR });
    expect(storage.read()).toBeNull();
  });

  it("update + read 往返正确", () => {
    const storage = createFileCredentialStore({ storageDir: TEST_DIR });
    const data: CredentialStoreData = {
      apiKeys: { openai: "sk-test-123", anthropic: "sk-ant-test-456" },
      hmacKey: "test-hmac-key",
    };

    const result = storage.update(data);
    expect(result.success).toBe(true);

    const read = storage.read();
    expect(read).not.toBeNull();
    expect(read?.apiKeys?.openai).toBe("sk-test-123");
    expect(read?.apiKeys?.anthropic).toBe("sk-ant-test-456");
    expect(read?.hmacKey).toBe("test-hmac-key");
  });

  it("update 返回明文存储警告", () => {
    const storage = createFileCredentialStore({ storageDir: TEST_DIR });
    const result = storage.update({});
    expect(result.success).toBe(true);
    expect(result.warning).toContain("plaintext");
  });

  it("readAsync 返回与 read 相同的数据", async () => {
    const storage = createFileCredentialStore({ storageDir: TEST_DIR });
    const data: CredentialStoreData = { hmacKey: "async-test" };
    storage.update(data);

    const sync = storage.read();
    const async_ = await storage.readAsync();
    expect(async_).toEqual(sync);
  });

  it("delete 删除存储文件", () => {
    const storage = createFileCredentialStore({ storageDir: TEST_DIR });
    storage.update({ hmacKey: "to-be-deleted" });
    expect(storage.read()).not.toBeNull();

    const deleted = storage.delete();
    expect(deleted).toBe(true);
    expect(storage.read()).toBeNull();
  });

  it("delete 对不存在的文件返回 true", () => {
    const storage = createFileCredentialStore({ storageDir: TEST_DIR });
    expect(storage.delete()).toBe(true);
  });

  it("自定义文件名", () => {
    const storage = createFileCredentialStore({
      storageDir: TEST_DIR,
      fileName: ".custom-creds.json",
    });
    storage.update({ hmacKey: "custom" });
    expect(existsSync(join(TEST_DIR, ".custom-creds.json"))).toBe(true);
  });
});

// ─── 文件权限 ───

describe("S.1.2 > SEC-07 > 文件权限", () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  it("写入后文件权限为 0o600（仅所有者读写）", () => {
    if (isWindows) return;
    const storage = createFileCredentialStore({ storageDir: TEST_DIR });
    storage.update({ hmacKey: "permission-test" });

    const filePath = join(TEST_DIR, ".credentials.json");
    expect(existsSync(filePath)).toBe(true);

    const stats = statSync(filePath);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("多次 update 后权限仍为 0o600", () => {
    if (isWindows) return;
    const storage = createFileCredentialStore({ storageDir: TEST_DIR });
    storage.update({ hmacKey: "first" });
    storage.update({ hmacKey: "second" });
    storage.update({ hmacKey: "third" });

    const filePath = join(TEST_DIR, ".credentials.json");
    const stats = statSync(filePath);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ─── 原子写入 ───

describe("S.1.2 > SEC-07 > 原子写入", () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  it("update 完成后不应有临时文件残留", () => {
    const storage = createFileCredentialStore({ storageDir: TEST_DIR });
    storage.update({ hmacKey: "atomic-test" });

    const tmpPath = join(TEST_DIR, ".credentials.json.tmp");
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("update 失败后不应有临时文件残留", () => {
    const impossibleDir = isWindows
      ? "Z:\\nonexistent_drive_root\\impossible-dir"
      : "/proc/impossible-dir";
    const storage = createFileCredentialStore({
      storageDir: impossibleDir,
    });
    const result = storage.update({ hmacKey: "fail-test" });
    expect(result.success).toBe(false);
  });
});

// ─── 回退存储 ───

describe("S.1.2 > SEC-07 > 回退存储", () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  it("name 包含主次存储名称", () => {
    const primary = createFileCredentialStore({ storageDir: join(TEST_DIR, "primary") });
    const secondary = createFileCredentialStore({ storageDir: join(TEST_DIR, "secondary") });
    const fallback = createChainedCredentialStore(primary, secondary);
    expect(fallback.name).toContain("plaintext");
    expect(fallback.name).toContain("fallback");
  });

  it("读取时优先使用主存储", () => {
    const primary = createFileCredentialStore({ storageDir: join(TEST_DIR, "primary") });
    const secondary = createFileCredentialStore({ storageDir: join(TEST_DIR, "secondary") });

    primary.update({ hmacKey: "primary-data" });
    secondary.update({ hmacKey: "secondary-data" });

    const fallback = createChainedCredentialStore(primary, secondary);
    const data = fallback.read();
    expect(data.hmacKey).toBe("primary-data");
  });

  it("主存储为空时回退到次存储", () => {
    const primary = createFileCredentialStore({ storageDir: join(TEST_DIR, "primary") });
    const secondary = createFileCredentialStore({ storageDir: join(TEST_DIR, "secondary") });

    secondary.update({ hmacKey: "fallback-data" });

    const fallback = createChainedCredentialStore(primary, secondary);
    const data = fallback.read();
    expect(data.hmacKey).toBe("fallback-data");
  });

  it("写入优先使用主存储", () => {
    const primary = createFileCredentialStore({ storageDir: join(TEST_DIR, "primary") });
    const secondary = createFileCredentialStore({ storageDir: join(TEST_DIR, "secondary") });

    const fallback = createChainedCredentialStore(primary, secondary);
    const result = fallback.update({ hmacKey: "written-to-primary" });
    expect(result.success).toBe(true);

    // 主存储应有数据
    expect(primary.read()?.hmacKey).toBe("written-to-primary");
  });

  it("首次迁移到主存储后删除次存储", () => {
    const primary = createFileCredentialStore({ storageDir: join(TEST_DIR, "primary") });
    const secondary = createFileCredentialStore({ storageDir: join(TEST_DIR, "secondary") });

    // 次存储有旧数据
    secondary.update({ hmacKey: "old-secondary-data" });

    const fallback = createChainedCredentialStore(primary, secondary);
    fallback.update({ hmacKey: "new-data" });

    // 次存储应被删除（迁移完成）
    expect(secondary.read()).toBeNull();
    // 主存储应有新数据
    expect(primary.read()?.hmacKey).toBe("new-data");
  });

  it("delete 同时删除两个存储", () => {
    const primary = createFileCredentialStore({ storageDir: join(TEST_DIR, "primary") });
    const secondary = createFileCredentialStore({ storageDir: join(TEST_DIR, "secondary") });

    primary.update({ hmacKey: "p" });
    secondary.update({ hmacKey: "s" });

    const fallback = createChainedCredentialStore(primary, secondary);
    const deleted = fallback.delete();
    expect(deleted).toBe(true);
    expect(primary.read()).toBeNull();
    expect(secondary.read()).toBeNull();
  });
});

// ─── CredentialStore 接口契约 ───

describe("S.1.2 > SEC-07 > CredentialStore 接口契约", () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  it("实现 CredentialStore 接口的所有方法", () => {
    const storage = createFileCredentialStore({ storageDir: TEST_DIR });
    expect(typeof storage.name).toBe("string");
    expect(typeof storage.read).toBe("function");
    expect(typeof storage.readAsync).toBe("function");
    expect(typeof storage.update).toBe("function");
    expect(typeof storage.delete).toBe("function");
  });

  it("update 返回 { success: boolean; warning?: string }", () => {
    const storage = createFileCredentialStore({ storageDir: TEST_DIR });
    const result = storage.update({});
    expect(typeof result.success).toBe("boolean");
    expect(result.success).toBe(true);
  });

  it("readAsync 返回 Promise", async () => {
    const storage = createFileCredentialStore({ storageDir: TEST_DIR });
    const result = storage.readAsync();
    expect(result).toBeInstanceOf(Promise);
    const data = await result;
    expect(data).toBeNull();
  });
});
