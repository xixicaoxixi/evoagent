/**
 * Session A.1 测试 — 模型信息更新。
 *
 * 验证 MODEL_PROVIDER_MAP、CONTEXT_WINDOW_MAP、MODEL_CAPABILITIES
 * 以及相关查询函数的正确性。
 */

import { describe, expect, it } from "vitest";
import {
  MODEL_PROVIDER_MAP,
  CONTEXT_WINDOW_MAP,
  MODEL_CAPABILITIES,
  PROVIDER_BASE_URL_MAP,
  inferProviderType,
  getContextWindow,
  getModelCapabilities,
  ProviderType,
} from "../../src/types/common";

describe("MODEL_PROVIDER_MAP", () => {
  it("包含所有 GPT-5.4 系列模型", () => {
    expect(MODEL_PROVIDER_MAP["gpt-5.4"]).toBe("openai");
    expect(MODEL_PROVIDER_MAP["gpt-5.4-pro"]).toBe("openai");
    expect(MODEL_PROVIDER_MAP["gpt-5.4-mini"]).toBe("openai");
    expect(MODEL_PROVIDER_MAP["gpt-5.4-nano"]).toBe("openai");
  });

  it("保留旧版 OpenAI 模型兼容", () => {
    expect(MODEL_PROVIDER_MAP["gpt-4o"]).toBe("openai");
    expect(MODEL_PROVIDER_MAP["gpt-4o-mini"]).toBe("openai");
    expect(MODEL_PROVIDER_MAP["gpt-4-turbo"]).toBe("openai");
    expect(MODEL_PROVIDER_MAP["gpt-4"]).toBe("openai");
    expect(MODEL_PROVIDER_MAP["gpt-3.5-turbo"]).toBe("openai");
  });

  it("包含 DeepSeek V3.2", () => {
    expect(MODEL_PROVIDER_MAP["deepseek-v3.2"]).toBe("deepseek");
    expect(MODEL_PROVIDER_MAP["deepseek-chat"]).toBe("deepseek");
    expect(MODEL_PROVIDER_MAP["deepseek-reasoner"]).toBe("deepseek");
  });

  it("包含 Kimi K2.5", () => {
    expect(MODEL_PROVIDER_MAP["kimi-k2.5"]).toBe("kimi");
    expect(MODEL_PROVIDER_MAP["moonshot-v1-8k"]).toBe("kimi");
    expect(MODEL_PROVIDER_MAP["moonshot-v1-128k"]).toBe("kimi");
  });

  it("包含 GLM 4.7/5.1/4.6V", () => {
    expect(MODEL_PROVIDER_MAP["glm-4.7"]).toBe("glm");
    expect(MODEL_PROVIDER_MAP["glm-5.1"]).toBe("glm");
    expect(MODEL_PROVIDER_MAP["glm-4.6v"]).toBe("glm");
    expect(MODEL_PROVIDER_MAP["glm-4-plus"]).toBe("glm");
  });

  it("包含 Claude 4.6 系列", () => {
    expect(MODEL_PROVIDER_MAP["claude-opus-4-6"]).toBe("anthropic");
    expect(MODEL_PROVIDER_MAP["claude-sonnet-4-6"]).toBe("anthropic");
    expect(MODEL_PROVIDER_MAP["claude-haiku-4-5"]).toBe("anthropic");
    expect(MODEL_PROVIDER_MAP["claude-mythos-preview"]).toBe("anthropic");
  });

  it("保留旧版 Anthropic 模型兼容", () => {
    expect(MODEL_PROVIDER_MAP["claude-sonnet-4-20250514"]).toBe("anthropic");
    expect(MODEL_PROVIDER_MAP["claude-3-5-sonnet-20241022"]).toBe("anthropic");
    expect(MODEL_PROVIDER_MAP["claude-3-opus-20240229"]).toBe("anthropic");
  });

  it("Qwen 映射到 openai（兼容 API）", () => {
    expect(MODEL_PROVIDER_MAP["qwen-plus"]).toBe("openai");
    expect(MODEL_PROVIDER_MAP["qwen-turbo"]).toBe("openai");
    expect(MODEL_PROVIDER_MAP["qwen-max"]).toBe("openai");
  });

  it("Ollama 本地模型正确映射", () => {
    expect(MODEL_PROVIDER_MAP["llama3"]).toBe("ollama");
    expect(MODEL_PROVIDER_MAP["mistral"]).toBe("ollama");
  });
});

describe("CONTEXT_WINDOW_MAP", () => {
  it("GPT-5.4 系列为 1M 上下文", () => {
    expect(CONTEXT_WINDOW_MAP["gpt-5.4"]).toBe(1_000_000);
    expect(CONTEXT_WINDOW_MAP["gpt-5.4-pro"]).toBe(1_000_000);
    expect(CONTEXT_WINDOW_MAP["gpt-5.4-mini"]).toBe(1_000_000);
  });

  it("GPT-4o 系列为 128K 上下文", () => {
    expect(CONTEXT_WINDOW_MAP["gpt-4o"]).toBe(128_000);
    expect(CONTEXT_WINDOW_MAP["gpt-4o-mini"]).toBe(128_000);
  });

  it("Kimi K2.5 为 256K 上下文", () => {
    expect(CONTEXT_WINDOW_MAP["kimi-k2.5"]).toBe(256_000);
  });

  it("DeepSeek 系列为 128K 上下文", () => {
    expect(CONTEXT_WINDOW_MAP["deepseek-chat"]).toBe(128_000);
    expect(CONTEXT_WINDOW_MAP["deepseek-v3.2"]).toBe(128_000);
  });

  it("Claude 4.6 系列为 1M 上下文", () => {
    expect(CONTEXT_WINDOW_MAP["claude-opus-4-6"]).toBe(1_000_000);
    expect(CONTEXT_WINDOW_MAP["claude-sonnet-4-6"]).toBe(1_000_000);
  });

  it("Claude Haiku 4.5 为 256K 上下文", () => {
    expect(CONTEXT_WINDOW_MAP["claude-haiku-4-5"]).toBe(256_000);
  });

  it("GLM-4-long 为 1M 上下文", () => {
    expect(CONTEXT_WINDOW_MAP["glm-4-long"]).toBe(1_000_000);
  });

  it("Moonshot 按模型名区分上下文大小", () => {
    expect(CONTEXT_WINDOW_MAP["moonshot-v1-8k"]).toBe(8_000);
    expect(CONTEXT_WINDOW_MAP["moonshot-v1-32k"]).toBe(32_000);
    expect(CONTEXT_WINDOW_MAP["moonshot-v1-128k"]).toBe(128_000);
  });
});

describe("MODEL_CAPABILITIES", () => {
  it("GPT-5.4 支持全部高级能力", () => {
    const caps = MODEL_CAPABILITIES["gpt-5.4"]!;
    expect(caps.reasoning).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.toolSearch).toBe(true);
    expect(caps.compaction).toBe(true);
    expect(caps.structuredOutputs).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.toolCalling).toBe(true);
  });

  it("GPT-5.4-nano 不支持 vision 和 toolSearch", () => {
    const caps = MODEL_CAPABILITIES["gpt-5.4-nano"]!;
    expect(caps.reasoning).toBe(true);
    expect(caps.vision).toBe(false);
    expect(caps.toolSearch).toBe(false);
    expect(caps.compaction).toBe(false);
  });

  it("GPT-4o 不支持 reasoning 和 toolSearch", () => {
    const caps = MODEL_CAPABILITIES["gpt-4o"]!;
    expect(caps.reasoning).toBe(false);
    expect(caps.toolSearch).toBe(false);
    expect(caps.vision).toBe(true);
    expect(caps.toolCalling).toBe(true);
  });

  it("deepseek-reasoner 支持 reasoning", () => {
    const caps = MODEL_CAPABILITIES["deepseek-reasoner"]!;
    expect(caps.reasoning).toBe(true);
  });

  it("deepseek-chat 不支持 reasoning", () => {
    const caps = MODEL_CAPABILITIES["deepseek-chat"]!;
    expect(caps.reasoning).toBe(false);
  });

  it("kimi-k2.5 支持 vision", () => {
    const caps = MODEL_CAPABILITIES["kimi-k2.5"]!;
    expect(caps.vision).toBe(true);
  });

  it("glm-4.6v 支持 vision", () => {
    const caps = MODEL_CAPABILITIES["glm-4.6v"]!;
    expect(caps.vision).toBe(true);
  });

  it("Claude 4.6 系列支持 reasoning 和 compaction", () => {
    const caps = MODEL_CAPABILITIES["claude-sonnet-4-6"]!;
    expect(caps.reasoning).toBe(true);
    expect(caps.compaction).toBe(true);
    expect(caps.structuredOutputs).toBe(true);
  });

  it("Claude Haiku 4.5 不支持 reasoning", () => {
    const caps = MODEL_CAPABILITIES["claude-haiku-4-5"]!;
    expect(caps.reasoning).toBe(false);
    expect(caps.vision).toBe(true);
  });

  it("所有模型都支持 streaming", () => {
    for (const [model, caps] of Object.entries(MODEL_CAPABILITIES)) {
      expect(caps.streaming, `${model} should support streaming`).toBe(true);
    }
  });
});

describe("inferProviderType", () => {
  it("正确推断新模型", () => {
    expect(inferProviderType("gpt-5.4")).toBe("openai");
    expect(inferProviderType("claude-sonnet-4-6")).toBe("anthropic");
    expect(inferProviderType("kimi-k2.5")).toBe("kimi");
    expect(inferProviderType("glm-4.7")).toBe("glm");
    expect(inferProviderType("deepseek-v3.2")).toBe("deepseek");
  });

  it("未知模型返回 undefined", () => {
    expect(inferProviderType("unknown-model-xyz")).toBeUndefined();
  });
});

describe("getContextWindow", () => {
  it("返回已知模型的上下文窗口", () => {
    expect(getContextWindow("gpt-5.4")).toBe(1_000_000);
    expect(getContextWindow("claude-sonnet-4-6")).toBe(1_000_000);
    expect(getContextWindow("kimi-k2.5")).toBe(256_000);
  });

  it("未知模型返回默认 128K", () => {
    expect(getContextWindow("unknown-model")).toBe(128_000);
  });
});

describe("getModelCapabilities", () => {
  it("返回已知模型的能力", () => {
    const caps = getModelCapabilities("gpt-5.4");
    expect(caps.reasoning).toBe(true);
    expect(caps.toolSearch).toBe(true);
  });

  it("未知模型返回安全的默认能力", () => {
    const caps = getModelCapabilities("unknown-model");
    expect(caps.reasoning).toBe(false);
    expect(caps.vision).toBe(false);
    expect(caps.toolSearch).toBe(false);
    expect(caps.compaction).toBe(false);
    expect(caps.structuredOutputs).toBe(false);
    expect(caps.streaming).toBe(true);
    expect(caps.toolCalling).toBe(false);
  });
});

describe("PROVIDER_BASE_URL_MAP", () => {
  it("包含所有 Provider 的 base URL", () => {
    expect(PROVIDER_BASE_URL_MAP["openai"]).toContain("openai.com");
    expect(PROVIDER_BASE_URL_MAP["anthropic"]).toContain("anthropic.com");
    expect(PROVIDER_BASE_URL_MAP["deepseek"]).toContain("deepseek.com");
    expect(PROVIDER_BASE_URL_MAP["kimi"]).toContain("moonshot.cn");
    expect(PROVIDER_BASE_URL_MAP["glm"]).toContain("bigmodel.cn");
    expect(PROVIDER_BASE_URL_MAP["ollama"]).toContain("localhost");
  });
});
