import { describe, expect, it } from "vitest";
import {
  classifyProviderError,
  createMessageSummary,
  createProviderErrorDiagnostic,
  createProviderSummary,
  extractStatusCode,
  isRetriableProviderError,
} from "../../src/observability/chat-diagnostics";

describe("chat diagnostics", () => {
  it("提取 provider 状态码并分类鉴权错误", () => {
    expect(extractStatusCode("OpenAI API error (401): invalid key")).toBe(401);
    expect(classifyProviderError({ message: "OpenAI API error (401): invalid key", statusCode: 401 })).toBe("auth");
    expect(isRetriableProviderError({ statusCode: 401, category: "auth" })).toBe(false);
  });

  it("识别可重试的限流错误", () => {
    const diagnostic = createProviderErrorDiagnostic({
      providerType: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      statusCode: 429,
      message: "OpenAI API error (429): rate limit",
    });
    expect(diagnostic.category).toBe("rate_limit");
    expect(diagnostic.retriable).toBe(true);
  });

  it("生成 provider 与 message 摘要", () => {
    expect(createProviderSummary({ providerType: "openai", model: "gpt-test" })).toEqual({
      providerType: "openai",
      model: "gpt-test",
    });
    expect(createMessageSummary("hello world")).toEqual({
      length: 11,
      preview: "hello world",
    });
  });
});
