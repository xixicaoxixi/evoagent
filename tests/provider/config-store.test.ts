import { describe, expect, it } from "vitest";
import { createProviderConfigStore } from "../../src/core/provider-config";

describe("Task 5 > Provider config store", () => {
  it("无配置时返回 unconfigured 快照", () => {
    const store = createProviderConfigStore();
    const snapshot = store.getSnapshot();

    expect(snapshot.configured).toBe(false);
    expect(snapshot.source.effective).toBe("unconfigured");
    expect(snapshot.source.provider.source).toBe("unconfigured");
    expect(snapshot.source.autoDetected).toBe(false);
    expect(snapshot.source.conflicts).toEqual([]);
  });

  it("自动检测配置可被快照解释", async () => {
    const store = createProviderConfigStore();
    await store.applyAutoDetectedProvider({
      providerType: "openai",
      apiKey: "sk-auto-12345678",
      model: "gpt-auto",
      baseUrl: "https://auto.example/v1",
      source: "env_auto_detected",
      sourceDetail: "Detected from OPENAI_API_KEY.",
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.configured).toBe(true);
    expect(snapshot.provider).toBe("openai");
    expect(snapshot.model).toBe("gpt-auto");
    expect(snapshot.baseUrl).toBe("https://auto.example/v1");
    expect(snapshot.apiKeySet).toBe(true);
    expect(snapshot.apiKeyPreview).toBe("sk-a****5678");
    expect(snapshot.source.effective).toBe("env_auto_detected");
    expect(snapshot.source.autoDetected).toBe(true);
    expect(snapshot.source.provider.detail).toContain("OPENAI_API_KEY");
  });

  it("持久化配置优先级高于自动检测并记录冲突", async () => {
    const store = createProviderConfigStore();
    await store.applyAutoDetectedProvider({
      providerType: "openai",
      apiKey: "sk-auto-12345678",
      model: "gpt-auto",
      baseUrl: "https://auto.example/v1",
      source: "env_auto_detected",
      sourceDetail: "Detected from OPENAI_API_KEY.",
    });
    await store.setProvider({
      providerType: "kimi",
      apiKey: "sk-persist-87654321",
      model: "kimi-k2.5",
      baseUrl: "https://persist.example/v1",
      source: "persisted_config",
      sourceDetail: "Configured via Web UI.",
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.provider).toBe("kimi");
    expect(snapshot.source.effective).toBe("persisted_config");
    expect(snapshot.source.autoDetected).toBe(false);
    expect(snapshot.source.conflicts.some((item) => item.field === "provider")).toBe(true);
    expect(snapshot.source.conflicts.some((item) => item.field === "baseUrl")).toBe(true);
  });

  it("运行时覆盖优先级最高", async () => {
    const store = createProviderConfigStore();
    await store.applyAutoDetectedProvider({
      providerType: "openai",
      apiKey: "sk-auto-12345678",
      model: "gpt-auto",
      baseUrl: "https://auto.example/v1",
      source: "env_auto_detected",
      sourceDetail: "Detected from OPENAI_API_KEY.",
    });
    await store.setProvider({
      providerType: "kimi",
      apiKey: "sk-persist-87654321",
      model: "kimi-k2.5",
      baseUrl: "https://persist.example/v1",
      source: "persisted_config",
      sourceDetail: "Configured via Web UI.",
    });
    await store.setProvider({
      providerType: "glm",
      apiKey: "sk-runtime-11223344",
      model: "glm-4.7",
      baseUrl: "https://runtime.example/v1",
      source: "runtime_override",
      sourceDetail: "Overridden by runtime caller.",
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.provider).toBe("glm");
    expect(snapshot.source.effective).toBe("runtime_override");
    expect(snapshot.source.priority).toEqual(["runtime_override", "persisted_config", "env_auto_detected"]);
    expect(snapshot.source.conflicts.some((item) => item.loser === "persisted_config")).toBe(true);
    expect(snapshot.source.conflicts.some((item) => item.loser === "env_auto_detected")).toBe(true);
  });
});
