import { describe, expect, it } from "vitest";
import { detectProviders } from "../src/core/provider-detect";
import { createProviderConfigStore } from "../src/core/provider-config";
import { createProvider } from "../src/llm/provider";
import { getProviderDefaults } from "../src/types/provider-defaults";

const ENV_KEYS = [
  "PROVIDER_PRIORITY",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "KIMI_API_KEY",
  "KIMI_MODEL",
  "GLM_API_KEY",
  "GLM_MODEL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
] as const;

describe("provider defaults unification", () => {
  it("统一默认值真源与 .env.example 保持一致", () => {
    expect(getProviderDefaults("openai")).toEqual({
      model: "gpt-5.4",
      baseUrl: "https://api.openai.com/v1",
      temperature: 0.1,
    });
    expect(getProviderDefaults("anthropic")).toEqual({
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com",
      temperature: 0.1,
    });
    expect(getProviderDefaults("kimi")).toEqual({
      model: "kimi-k2.6",
      baseUrl: "https://api.moonshot.cn/v1",
    });
    expect(getProviderDefaults("glm")).toEqual({
      model: "glm-5.1",
    });
    expect(getProviderDefaults("deepseek")).toEqual({
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com",
    });
  });

  it("自动检测 provider 时优先采用 .env 中模型值", () => {
    const backup = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
    try {
      process.env.PROVIDER_PRIORITY = "kimi,deepseek";
      process.env.KIMI_API_KEY = "sk-kimi-real";
      process.env.KIMI_MODEL = "kimi-k2.6";
      process.env.DEEPSEEK_API_KEY = "sk-deepseek-real";
      process.env.DEEPSEEK_MODEL = "deepseek-v4-pro";

      const providers = detectProviders();
      expect(providers).toHaveLength(2);
      expect(providers[0]).toMatchObject({
        type: "kimi",
        model: "kimi-k2.6",
        baseUrl: "https://api.moonshot.cn/v1",
      });
      expect(providers[1]).toMatchObject({
        type: "deepseek",
        model: "deepseek-v4-pro",
        baseUrl: "https://api.deepseek.com",
      });
    } finally {
      for (const [key, value] of backup) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("config store 在未显式传入 model/baseUrl 时使用统一默认值", async () => {
    const store = createProviderConfigStore();
    await store.applyRecord({
      providerType: "deepseek",
      apiKey: "sk-test",
      source: "env_auto_detected",
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.model).toBe("deepseek-v4-pro");
    expect(snapshot.baseUrl).toBe("https://api.deepseek.com");
  });

  it("createProvider 对 openai-compatible provider 注入统一默认值", () => {
    const provider = createProvider({
      providerType: "kimi",
      apiKey: "sk-test",
    });

    expect(provider.model).toBe("kimi-k2.6");
  });
});
