import { describe, it, expect } from "vitest";
import { adaptWindowsCommand } from "../../src/tools/bash/bash";
import { BashInputSchema } from "../../src/tools/bash/bash";
import { assemblePrompt, type PromptConfig } from "../../src/core/query/prompt";

describe("Step 9: Windows bash command adaptation", () => {
  describe("adaptWindowsCommand", () => {
    it("adapts set command with setlocal enabledelayedexpansion", () => {
      const result = adaptWindowsCommand("set MY_VAR=hello");
      expect(result).toBe("setlocal enabledelayedexpansion && set MY_VAR=hello");
    });

    it("adapts set command with complex variable name", () => {
      const result = adaptWindowsCommand("set MY_VAR_2=value123");
      expect(result).toBe("setlocal enabledelayedexpansion && set MY_VAR_2=value123");
    });

    it("adapts echo with double-quoted redirect", () => {
      const result = adaptWindowsCommand('echo "hello" > test.txt');
      expect(result).toBe("echo hello > test.txt");
    });

    it("adapts echo with single-quoted redirect", () => {
      const result = adaptWindowsCommand("echo 'hello' > test.txt");
      expect(result).toBe("echo hello > test.txt");
    });

    it("normalizes spacing around > redirect", () => {
      const result = adaptWindowsCommand("dir>output.txt");
      expect(result).toContain(">");
    });

    it("normalizes spacing around >> append redirect", () => {
      const result = adaptWindowsCommand("dir>>output.txt");
      expect(result).toContain(">>");
    });

    it("passes through simple commands without modification", () => {
      const result = adaptWindowsCommand("dir");
      expect(result).toBe("dir");
    });

    it("passes through echo without redirect", () => {
      const result = adaptWindowsCommand("echo hello");
      expect(result).toBe("echo hello");
    });

    it("adapts set command takes priority over echo redirect", () => {
      const result = adaptWindowsCommand("set MY_VAR=hello && echo %MY_VAR%");
      expect(result).toContain("setlocal enabledelayedexpansion");
    });
  });

  describe("BashInputSchema timeout validation", () => {
    it("accepts timeout within valid range", () => {
      const result = BashInputSchema.safeParse({ command: "echo hello", timeout: 5000 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBe(5000);
      }
    });

    it("accepts minimum timeout of 1000ms", () => {
      const result = BashInputSchema.safeParse({ command: "echo hello", timeout: 1000 });
      expect(result.success).toBe(true);
    });

    it("accepts maximum timeout of 120000ms", () => {
      const result = BashInputSchema.safeParse({ command: "echo hello", timeout: 120_000 });
      expect(result.success).toBe(true);
    });

    it("rejects timeout exceeding 120000ms", () => {
      const result = BashInputSchema.safeParse({ command: "echo hello", timeout: 200_000 });
      expect(result.success).toBe(false);
    });

    it("rejects timeout below 1000ms", () => {
      const result = BashInputSchema.safeParse({ command: "echo hello", timeout: 500 });
      expect(result.success).toBe(false);
    });

    it("accepts command without timeout (optional)", () => {
      const result = BashInputSchema.safeParse({ command: "echo hello" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBeUndefined();
      }
    });
  });

  describe("assemblePrompt Windows guidance", () => {
    it("includes Windows guidance on win32 platform", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      const config: PromptConfig = {
        baseSystemPrompt: "You are a helpful assistant.",
      };
      const result = assemblePrompt(config);
      expect(result.systemPrompt).toContain("Windows-compatible commands");
      expect(result.systemPrompt).toContain("file_write/file_read");
      expect(result.systemPrompt).toContain("avoid echo with redirect");

      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    it("does not include Windows guidance on non-win32 platform", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      const config: PromptConfig = {
        baseSystemPrompt: "You are a helpful assistant.",
      };
      const result = assemblePrompt(config);
      expect(result.systemPrompt).not.toContain("Windows-compatible commands");

      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });
  });
});
