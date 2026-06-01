/**
 * LLM Adapter 测试 — 阶段 A.1。
 *
 * 验证 createLLMAdapter 正确将全局 LLMProvider 适配为各模块所需的简化接口。
 */

import { describe, it, expect } from "vitest";
import { createLLMAdapter } from "../../src/llm/adapter";
import { MockProvider } from "../../src/llm/mock";

describe("createLLMAdapter", () => {
  it("应正确创建适配器，包含 criticProvider 和 simpleProvider", () => {
    const provider = new MockProvider({ model: "test-model" });
    const adapter = createLLMAdapter(provider);

    expect(adapter.originalProvider).toBe(provider);
    expect(adapter.criticProvider.name).toBe("test-model");
    expect(adapter.simpleProvider).toBeDefined();
  });

  it("simpleProvider.invoke 应正确适配消息格式并返回 content", async () => {
    const provider = new MockProvider({
      responseFn: (messages) => `Response to: ${(messages[0]?.content as string) ?? ""}`,
    });
    const adapter = createLLMAdapter(provider);

    const result = await adapter.simpleProvider.invoke([
      { role: "user", content: "Hello" },
    ]);

    expect(result).toBe("Response to: Hello");
    expect(provider.callHistory.length).toBe(1);
  });

  it("simpleProvider.invoke 应正确传递多条消息", async () => {
    const provider = new MockProvider({
      responseFn: (messages) => `Received ${messages.length} messages`,
    });
    const adapter = createLLMAdapter(provider);

    const result = await adapter.simpleProvider.invoke([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ]);

    expect(result).toBe("Received 3 messages");
  });

  it("criticProvider.invoke 应与 simpleProvider 共享实现", async () => {
    const provider = new MockProvider({
      responseFn: () => "critic response",
    });
    const adapter = createLLMAdapter(provider);

    const criticResult = await adapter.criticProvider.invoke([
      { role: "user", content: "test" },
    ]);
    const simpleResult = await adapter.simpleProvider.invoke([
      { role: "user", content: "test" },
    ]);

    expect(criticResult).toBe("critic response");
    expect(simpleResult).toBe("critic response");
    expect(provider.callHistory.length).toBe(2);
  });

  it("criticProvider.name 应使用 provider.model", () => {
    const provider = new MockProvider({ model: "claude-3-opus" });
    const adapter = createLLMAdapter(provider);

    expect(adapter.criticProvider.name).toBe("claude-3-opus");
  });

  it("Provider 调用失败时 simpleProvider.invoke 应抛出错误", async () => {
    const provider = new MockProvider({ shouldFail: true });
    const adapter = createLLMAdapter(provider);

    await expect(
      adapter.simpleProvider.invoke([{ role: "user", content: "test" }]),
    ).rejects.toThrow("Mock provider configured to fail");
  });

  it("应保留原始 provider 引用", () => {
    const provider = new MockProvider();
    const adapter = createLLMAdapter(provider);

    expect(adapter.originalProvider).toBe(provider);
    expect(adapter.originalProvider.model).toBe(provider.model);
  });

  it("应正确处理空消息列表", async () => {
    const provider = new MockProvider({ defaultResponse: "empty" });
    const adapter = createLLMAdapter(provider);

    const result = await adapter.simpleProvider.invoke([]);
    expect(result).toBe("empty");
  });
});
