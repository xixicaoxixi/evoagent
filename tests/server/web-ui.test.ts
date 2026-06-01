import { describe, expect, test } from "vitest";
import { getWebUIHtml, renderProviderDefaults } from "../../src/server/web-ui";

describe("web-ui", () => {
  test("renderProviderDefaults 输出 model 与 baseUrl 真源快照", () => {
    const defaults = JSON.parse(renderProviderDefaults()) as Record<string, { model: string | null; baseUrl: string | null }>;

    expect(defaults.kimi).toEqual({
      model: "kimi-k2.6",
      baseUrl: "https://api.moonshot.cn/v1",
    });
    expect(defaults.deepseek).toEqual({
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com",
    });
    expect(defaults.custom).toEqual({
      model: null,
      baseUrl: null,
    });
  });

  test("getWebUIHtml 渲染最小可用控制台与配置路由交互入口", () => {
    const html = getWebUIHtml("/api/v1");

    expect(html).toContain("最小可用 Provider 控制台");
    expect(html).toContain("/config/status");
    expect(html).toContain("/config/provider");
    expect(html).toContain("/config/providers");
    expect(html).toContain('id="provider-form"');
    expect(html).toContain('id="provider-defaults-grid"');
    expect(html).toContain('id="fill-defaults-button"');
    expect(html).toContain('window.__EVOAGENT_PREFIX__ = "/api/v1"');
    expect(html).toContain('window.__EVOAGENT_PROVIDER_DEFAULTS__ =');
  });

  test("getWebUIHtml 对 prefix 做 HTML 转义，避免注入到静态标记", () => {
    const html = getWebUIHtml('/api/<script>alert("x")</script>');

    expect(html).toContain('/api/&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<div class="kv-value mono">/api/<script>alert("x")</script></div>');
  });
});
