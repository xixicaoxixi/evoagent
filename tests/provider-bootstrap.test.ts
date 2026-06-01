import { describe, expect, it } from "vitest";
import { bootstrapAutoDetectedProvider } from "../src/core/provider-bootstrap";
import { createProviderConfigStore } from "../src/core/provider-config";

describe("Task 8 > provider bootstrap consolidation", () => {
  it("共享 bootstrap 在无显式 provider 时允许沿用环境自动检测", async () => {
    const store = createProviderConfigStore();
    const result = await bootstrapAutoDetectedProvider(store, {
      sourceDetail: "test bootstrap",
    });

    if (result === undefined) {
      expect(store.getContext()).toBeUndefined();
      expect(store.getSnapshot().configured).toBe(false);
      expect(store.getSnapshot().source.effective).toBe("unconfigured");
      return;
    }

    expect(store.getContext()).toBeDefined();
    expect(store.getSnapshot().configured).toBe(true);
    expect(store.getSnapshot().source.effective).toBe("env_auto_detected");
  });

  it("复用统一 sourceDetail 写入 provider source detail", async () => {
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    const originalOllama = process.env.OLLAMA_BASE_URL;
    const originalDeepSeek = process.env.DEEPSEEK_API_KEY;
    const originalKimi = process.env.KIMI_API_KEY;
    const originalGlm = process.env.GLM_API_KEY;

    process.env.ANTHROPIC_API_KEY = "";
    process.env.OLLAMA_BASE_URL = "";
    process.env.DEEPSEEK_API_KEY = "";
    process.env.KIMI_API_KEY = "";
    process.env.GLM_API_KEY = "";
    process.env.OPENAI_API_KEY = "sk-test-12345678";

    try {
      const store = createProviderConfigStore();
      await bootstrapAutoDetectedProvider(store, {
        sourceDetail: "shared bootstrap detail",
      });
      expect(store.getSnapshot().source.effective).toBe("env_auto_detected");
      expect(store.getSnapshot().source.provider.detail).toBe("shared bootstrap detail");
      expect(store.getSnapshot().source.model.detail).toBe("shared bootstrap detail");
      expect(store.getSnapshot().source.baseUrl.detail).toBe("shared bootstrap detail");
    } finally {
      process.env.OPENAI_API_KEY = originalOpenAI;
      process.env.ANTHROPIC_API_KEY = originalAnthropic;
      process.env.OLLAMA_BASE_URL = originalOllama;
      process.env.DEEPSEEK_API_KEY = originalDeepSeek;
      process.env.KIMI_API_KEY = originalKimi;
      process.env.GLM_API_KEY = originalGlm;
    }
  });
});
