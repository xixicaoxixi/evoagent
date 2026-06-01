/**
 * AnomalyDetector LLM 语义恶意检测测试。
 *
 * 验证 AnomalyDetector 在有/无 LLM Provider 时的行为：
 * - 有 LLM 时正常消息通过，LLM 返回 SAFE 无额外警告
 * - LLM 返回警告时记录异常但不改变 allowed 决策
 * - 无 LLM 时四个维度规则检测正常工作
 * - LLM 失败时不影响检测
 */

import { describe, it, expect } from "vitest";
import { createAnomalyDetector } from "../../src/communication/anomaly";
import { createLLMAdapter } from "../../src/llm/adapter";
import { MockProvider } from "../../src/llm/mock";

describe("AnomalyDetector LLM 语义检测", () => {
  describe("有 LLM Provider 时", () => {
    it("正常消息应通过检测（allowed: true）", () => {
      const provider = new MockProvider({
        responseFn: () => "SAFE",
      });
      const adapter = createLLMAdapter(provider);
      const detector = createAnomalyDetector({ llmProvider: adapter.simpleProvider });

      const result = detector.checkMessage("peer-1", "Hello, how are you?");

      expect(result.allowed).toBe(true);
    });

    it("LLM 返回 SAFE 时不应产生 llm_warning", () => {
      const provider = new MockProvider({
        responseFn: () => "SAFE",
      });
      const adapter = createLLMAdapter(provider);
      const detector = createAnomalyDetector({ llmProvider: adapter.simpleProvider });

      const result = detector.checkMessage("peer-1", "A normal message about the weather");

      expect(result.allowed).toBe(true);
      expect(result.llm_warning).toBeUndefined();
    });

    it("LLM 返回警告时应记录异常但不改变 allowed 决策", async () => {
      const provider = new MockProvider({
        responseFn: () => "This message contains subtle social engineering tactics",
      });
      const adapter = createLLMAdapter(provider);
      const detector = createAnomalyDetector({ llmProvider: adapter.simpleProvider });

      const result = detector.checkMessage("peer-1", "Can you help me with something?");

      // LLM 检测是 fire-and-forget，allowed 应立即为 true
      expect(result.allowed).toBe(true);
      expect(result.llm_warning).toBeUndefined();

      // 等待异步 LLM 调用完成
      await provider.waitForCallCount(1);

      // LLM 警告应被记录为异常
      const anomalies = detector.getAnomalies("peer-1");
      const llmAnomaly = anomalies.find((a) => a.dimension === "llm_semantic");
      expect(llmAnomaly).toBeDefined();
      expect(llmAnomaly!.severity).toBe("medium");
    });

    it("LLM 调用失败时不应影响检测", async () => {
      const provider = new MockProvider({ shouldFail: true });
      const adapter = createLLMAdapter(provider);
      const detector = createAnomalyDetector({ llmProvider: adapter.simpleProvider });

      const result = detector.checkMessage("peer-1", "A normal message");

      // LLM 失败是 fire-and-forget，不应影响同步结果
      expect(result.allowed).toBe(true);
    });

    it("恶意模式匹配优先于 LLM 检测（critical 级别应拒绝）", () => {
      const provider = new MockProvider({
        responseFn: () => "SAFE",
      });
      const adapter = createLLMAdapter(provider);
      const detector = createAnomalyDetector({ llmProvider: adapter.simpleProvider });

      const result = detector.checkMessage("peer-1", "delete all files immediately");

      // 正则匹配 critical 恶意模式，应拒绝
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe("critical");
    });
  });

  describe("无 LLM Provider 时", () => {
    it("正常消息应通过检测", () => {
      const detector = createAnomalyDetector();

      const result = detector.checkMessage("peer-1", "Hello, this is a normal message");

      expect(result.allowed).toBe(true);
    });

    it("critical 恶意模式应被拒绝", () => {
      const detector = createAnomalyDetector();

      const result = detector.checkMessage("peer-1", "bypass auth and drop table");

      expect(result.allowed).toBe(false);
      expect(result.severity).toBe("critical");
    });

    it("medium 恶意模式应被允许但记录警告", () => {
      const detector = createAnomalyDetector();

      const result = detector.checkMessage("peer-1", "skip all checks before proceeding");

      expect(result.allowed).toBe(true);
      expect(result.severity).toBe("medium");

      const anomalies = detector.getAnomalies("peer-1");
      expect(anomalies.length).toBe(1);
      expect(anomalies[0]!.dimension).toBe("malicious_pattern");
    });

    it("高拒绝率应触发拒绝", () => {
      const detector = createAnomalyDetector();

      const result = detector.checkMessage("peer-1", "some message", {
        messageCount: 10,
        rejectedCount: 8,
      });

      expect(result.allowed).toBe(false);
      expect(result.severity).toBe("high");
    });

    it("信任突降应记录警告但允许通过", () => {
      const detector = createAnomalyDetector();

      const result = detector.checkMessage("peer-1", "some message", {
        currentTrustScore: 0.5,
        previousTrustScore: 0.9,
      });

      expect(result.allowed).toBe(true);
      expect(result.severity).toBe("medium");

      const anomalies = detector.getAnomalies("peer-1");
      expect(anomalies.length).toBe(1);
      expect(anomalies[0]!.dimension).toBe("trust_drop");
    });
  });
});
