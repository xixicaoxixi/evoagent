import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createFileReadTool, type FileReadInput } from "../../src/tools/file/read";
import { createFileWriteTool, type FileWriteInput } from "../../src/tools/file/write";
import { createMemoryReadFileState, type ReadFileState } from "../../src/tools/file/write";
import type { ToolUseContext } from "../../src/interfaces/tool";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Fix Step 6: file_read 对不存在文件返回空 + markRead", () => {
  let tempDir: string;
  let baseContext: ToolUseContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "evoagent-fix-step6-"));
    baseContext = {
      cwd: tempDir,
      env: {},
      getAppState: () => ({}),
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("file_read 对不存在文件的行为", () => {
    it("返回 exists:false 而非抛错", async () => {
      const tool = createFileReadTool();
      const result = await tool.call(
        { file_path: join(tempDir, "nonexistent.txt") } satisfies FileReadInput,
        baseContext,
      );
      expect(result.isError).toBe(false);
      const data = result.content as { exists: boolean; content: string; lineCount: number; totalLines: number; size: number; truncated: boolean; encoding: string };
      expect(data.exists).toBe(false);
      expect(data.content).toBe("");
      expect(data.lineCount).toBe(0);
      expect(data.totalLines).toBe(0);
      expect(data.size).toBe(0);
      expect(data.truncated).toBe(false);
      expect(data.encoding).toBe("utf-8");
    });

    it("对存在文件返回 exists:true", async () => {
      const filePath = join(tempDir, "exists.txt");
      await writeFile(filePath, "hello world");

      const tool = createFileReadTool();
      const result = await tool.call(
        { file_path: filePath } satisfies FileReadInput,
        baseContext,
      );
      expect(result.isError).toBe(false);
      const data = result.content as { exists: boolean; content: string };
      expect(data.exists).toBe(true);
      expect(data.content).toContain("hello world");
    });
  });

  describe("markRead 调用验证", () => {
    it("不存在文件时 markRead 被调用（isPartialView=false）", async () => {
      const readState = createMemoryReadFileState();
      const tool = createFileReadTool(readState);

      const filePath = join(tempDir, "new_file.txt");
      await tool.call(
        { file_path: filePath } satisfies FileReadInput,
        baseContext,
      );

      const readStatus = readState.wasRead(filePath);
      expect(readStatus.read).toBe(true);
      if (readStatus.read) {
        expect(readStatus.isPartialView).toBe(false);
        expect(readStatus.mtimeMs).toBeUndefined();
      }
    });

    it("存在文件时 markRead 正常调用（含 mtimeMs）", async () => {
      const readState = createMemoryReadFileState();
      const tool = createFileReadTool(readState);

      const filePath = join(tempDir, "existing.txt");
      await writeFile(filePath, "content");
      await tool.call(
        { file_path: filePath } satisfies FileReadInput,
        baseContext,
      );

      const readStatus = readState.wasRead(filePath);
      expect(readStatus.read).toBe(true);
      if (readStatus.read) {
        expect(readStatus.isPartialView).toBe(false);
        expect(readStatus.mtimeMs).toBeDefined();
      }
    });
  });

  describe("file_read → file_write 闭环（核心验证）", () => {
    it("file_read 不存在文件 → file_write 同路径成功", async () => {
      const readState = createMemoryReadFileState();
      const readTool = createFileReadTool(readState);
      const writeTool = createFileWriteTool(readState);

      const filePath = join(tempDir, "brand_new.txt");

      const readResult = await readTool.call(
        { file_path: filePath } satisfies FileReadInput,
        baseContext,
      );
      expect(readResult.isError).toBe(false);
      const readData = readResult.content as { exists: boolean };
      expect(readData.exists).toBe(false);

      const writeResult = await writeTool.call(
        { file_path: filePath, content: "new content" } satisfies FileWriteInput,
        baseContext,
      );
      expect(writeResult.isError).toBe(false);

      const written = await readFile(filePath, "utf-8");
      expect(written).toBe("new content");
    });

    it("file_read 不存在文件 → 文件被创建后 → file_write 同路径成功", async () => {
      const readState = createMemoryReadFileState();
      const readTool = createFileReadTool(readState);
      const writeTool = createFileWriteTool(readState);

      const filePath = join(tempDir, "created_after_read.txt");

      await readTool.call(
        { file_path: filePath } satisfies FileReadInput,
        baseContext,
      );

      await writeFile(filePath, "intermediate content");

      const writeResult = await writeTool.call(
        { file_path: filePath, content: "updated content" } satisfies FileWriteInput,
        baseContext,
      );
      expect(writeResult.isError).toBe(false);

      const written = await readFile(filePath, "utf-8");
      expect(written).toBe("updated content");
    });

    it("无 readFileState 时 file_read 不存在文件仍返回 exists:false", async () => {
      const tool = createFileReadTool();

      const result = await tool.call(
        { file_path: join(tempDir, "no_state.txt") } satisfies FileReadInput,
        baseContext,
      );
      expect(result.isError).toBe(false);
      const data = result.content as { exists: boolean };
      expect(data.exists).toBe(false);
    });
  });

  describe("边界场景", () => {
    it("连续读取多个不存在文件均返回 exists:false", async () => {
      const tool = createFileReadTool();

      for (let i = 0; i < 3; i++) {
        const result = await tool.call(
          { file_path: join(tempDir, `missing_${i}.txt`) } satisfies FileReadInput,
          baseContext,
        );
        expect(result.isError).toBe(false);
        const data = result.content as { exists: boolean };
        expect(data.exists).toBe(false);
      }
    });

    it("file_read 不存在 → file_write → file_read 存在", async () => {
      const readState = createMemoryReadFileState();
      const readTool = createFileReadTool(readState);
      const writeTool = createFileWriteTool(readState);

      const filePath = join(tempDir, "lifecycle.txt");

      const r1 = await readTool.call({ file_path: filePath } satisfies FileReadInput, baseContext);
      expect((r1.content as { exists: boolean }).exists).toBe(false);

      await writeTool.call(
        { file_path: filePath, content: "created" } satisfies FileWriteInput,
        baseContext,
      );

      const r2 = await readTool.call({ file_path: filePath } satisfies FileReadInput, baseContext);
      expect((r2.content as { exists: boolean }).exists).toBe(true);
      expect((r2.content as { content: string }).content).toContain("created");
    });
  });
});
