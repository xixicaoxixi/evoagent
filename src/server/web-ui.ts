import { getProviderDefaults, getUIProviders } from "../types/provider-defaults";

interface WebUIProviderDefaultView {
  readonly model: string | null;
  readonly baseUrl: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderProviderDefaults(): string {
  const uiProviders = getUIProviders();
  return JSON.stringify(
    Object.fromEntries(
      uiProviders.map((providerType) => {
        const defaults = getProviderDefaults(providerType);
        const view: WebUIProviderDefaultView = {
          model: defaults.model ?? null,
          baseUrl: defaults.baseUrl ?? null,
        };
        return [providerType, view];
      }),
    ),
  );
}

export function getWebUIHtml(prefix: string): string {
  const safePrefix = escapeHtml(prefix);
  const providerDefaults = renderProviderDefaults();
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>EvoAgent</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --bg: #0b1020;
        --panel: rgba(15, 23, 42, 0.94);
        --panel-border: rgba(148, 163, 184, 0.2);
        --text: #e5e7eb;
        --muted: #94a3b8;
        --accent: #60a5fa;
        --accent-strong: #2563eb;
        --success: #22c55e;
        --danger: #f87171;
        --input: rgba(15, 23, 42, 0.72);
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        padding: 24px;
        background:
          radial-gradient(circle at top, rgba(37, 99, 235, 0.18), transparent 32%),
          linear-gradient(180deg, #0b1020 0%, #111827 100%);
        color: var(--text);
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        display: grid;
        gap: 16px;
      }
      .hero,
      .panel {
        border: 1px solid var(--panel-border);
        border-radius: 16px;
        padding: 20px;
        background: var(--panel);
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.32);
      }
      .hero {
        display: grid;
        gap: 12px;
      }
      .hero-header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
      }
      .hero-title {
        display: grid;
        gap: 8px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        width: fit-content;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(96, 165, 250, 0.12);
        color: #bfdbfe;
        font-size: 12px;
      }
      h1, h2, h3, p {
        margin: 0;
      }
      h1 {
        font-size: 30px;
      }
      h2 {
        font-size: 18px;
        margin-bottom: 12px;
      }
      h3 {
        font-size: 15px;
        margin-bottom: 10px;
      }
      .muted {
        color: var(--muted);
      }
      .grid {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      }
      .stack {
        display: grid;
        gap: 12px;
      }
      .kv-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      }
      .kv {
        border: 1px solid rgba(148, 163, 184, 0.14);
        border-radius: 12px;
        padding: 12px;
        background: rgba(15, 23, 42, 0.55);
      }
      .kv-label {
        font-size: 12px;
        color: var(--muted);
        margin-bottom: 6px;
      }
      .kv-value {
        font-size: 14px;
        word-break: break-word;
      }
      form {
        display: grid;
        gap: 12px;
      }
      label {
        display: grid;
        gap: 6px;
        font-size: 14px;
      }
      input,
      select,
      button,
      textarea {
        font: inherit;
      }
      input,
      select,
      textarea {
        width: 100%;
        border-radius: 12px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        background: var(--input);
        color: var(--text);
        padding: 10px 12px;
      }
      textarea {
        min-height: 140px;
        resize: vertical;
      }
      button {
        border: none;
        border-radius: 12px;
        padding: 11px 14px;
        cursor: pointer;
        transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
      }
      button:hover {
        transform: translateY(-1px);
      }
      button:disabled {
        opacity: 0.65;
        cursor: wait;
        transform: none;
      }
      .button-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .primary {
        background: linear-gradient(135deg, var(--accent), var(--accent-strong));
        color: white;
      }
      .secondary {
        background: rgba(148, 163, 184, 0.18);
        color: var(--text);
      }
      .status-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        width: fit-content;
      }
      .status-ok {
        background: rgba(34, 197, 94, 0.14);
        color: #bbf7d0;
      }
      .status-bad {
        background: rgba(248, 113, 113, 0.14);
        color: #fecaca;
      }
      .callout {
        border-radius: 12px;
        padding: 12px;
        border: 1px solid rgba(148, 163, 184, 0.16);
        background: rgba(15, 23, 42, 0.52);
      }
      .notice {
        min-height: 20px;
        font-size: 13px;
      }
      .notice[data-tone="success"] {
        color: #bbf7d0;
      }
      .notice[data-tone="error"] {
        color: #fecaca;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 12px;
        line-height: 1.5;
      }
      .provider-defaults-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .provider-card {
        border-radius: 14px;
        border: 1px solid rgba(148, 163, 184, 0.16);
        background: rgba(15, 23, 42, 0.52);
        padding: 14px;
        display: grid;
        gap: 10px;
      }
      .provider-name {
        font-weight: 700;
      }
      .mono {
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      }
      @media (max-width: 720px) {
        body {
          padding: 16px;
        }
        .hero,
        .panel {
          padding: 16px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="hero-header">
          <div class="hero-title">
            <span class="badge">EvoAgent Web UI</span>
            <h1>最小可用 Provider 控制台</h1>
            <p class="muted">直接联通配置路由，查看默认值、生效状态，并从页面提交 provider 配置。</p>
          </div>
          <div class="callout">
            <div class="kv-label">Prefix</div>
            <div class="kv-value mono">${safePrefix}</div>
          </div>
        </div>
      </section>

      <section class="grid">
        <section class="panel stack" aria-labelledby="current-status-title">
          <div>
            <h2 id="current-status-title">当前状态</h2>
            <p class="muted">读取 <span class="mono">/config/status</span> 与 <span class="mono">/config/provider</span>，显示当前 provider、生效模型、来源快照。</p>
          </div>
          <div id="status-chip" class="status-chip status-bad">尚未加载</div>
          <div class="kv-grid">
            <div class="kv">
              <div class="kv-label">Provider</div>
              <div id="current-provider" class="kv-value mono">-</div>
            </div>
            <div class="kv">
              <div class="kv-label">Model</div>
              <div id="current-model" class="kv-value mono">-</div>
            </div>
            <div class="kv">
              <div class="kv-label">Base URL</div>
              <div id="current-base-url" class="kv-value mono">-</div>
            </div>
            <div class="kv">
              <div class="kv-label">Source</div>
              <div id="current-source" class="kv-value mono">-</div>
            </div>
          </div>
          <div class="callout stack">
            <h3>Source detail</h3>
            <div id="source-detail" class="muted">-</div>
          </div>
          <div class="callout stack">
            <h3>Source snapshot</h3>
            <pre id="source-snapshot">{}</pre>
          </div>
        </section>

        <section class="panel stack" aria-labelledby="config-form-title">
          <div>
            <h2 id="config-form-title">配置 Provider</h2>
            <p class="muted">提交到 <span class="mono">/config/provider</span>。若选择 Ollama，可不填 API Key。</p>
          </div>
          <form id="provider-form">
            <label>
              Provider
              <select id="provider-type" name="provider_type"></select>
            </label>
            <label>
              API Key
              <input id="api-key" name="api_key" type="password" autocomplete="off" placeholder="sk-... / ollama 可留空" />
            </label>
            <label>
              Model
              <input id="model" name="model" type="text" autocomplete="off" placeholder="留空则使用统一默认值" />
            </label>
            <label>
              Base URL
              <input id="base-url" name="base_url" type="url" autocomplete="off" placeholder="留空则使用统一默认值" />
            </label>
            <div class="button-row">
              <button id="submit-button" class="primary" type="submit">保存配置</button>
              <button id="fill-defaults-button" class="secondary" type="button">填入默认值</button>
              <button id="refresh-button" class="secondary" type="button">刷新状态</button>
            </div>
            <div id="form-notice" class="notice" aria-live="polite"></div>
          </form>
        </section>
      </section>

      <section class="panel stack" aria-labelledby="defaults-title">
        <div>
          <h2 id="defaults-title">Provider 默认值真源</h2>
          <p class="muted">当前页面直接展示统一默认值中的 <span class="mono">model</span> 与 <span class="mono">baseUrl</span>，便于核对 .env / 自动检测 / 运行时配置覆盖关系。</p>
        </div>
        <div id="provider-defaults-grid" class="provider-defaults-grid"></div>
      </section>
    </main>
    <script>
      window.__EVOAGENT_PREFIX__ = ${JSON.stringify(prefix)};
      window.__EVOAGENT_PROVIDER_DEFAULTS__ = ${providerDefaults};

      const prefix = window.__EVOAGENT_PREFIX__;
      const providerDefaults = window.__EVOAGENT_PROVIDER_DEFAULTS__;
      const providerTypeSelect = document.getElementById("provider-type");
      const apiKeyInput = document.getElementById("api-key");
      const modelInput = document.getElementById("model");
      const baseUrlInput = document.getElementById("base-url");
      const sourceSnapshot = document.getElementById("source-snapshot");
      const sourceDetail = document.getElementById("source-detail");
      const currentProvider = document.getElementById("current-provider");
      const currentModel = document.getElementById("current-model");
      const currentBaseUrl = document.getElementById("current-base-url");
      const currentSource = document.getElementById("current-source");
      const statusChip = document.getElementById("status-chip");
      const defaultsGrid = document.getElementById("provider-defaults-grid");
      const form = document.getElementById("provider-form");
      const formNotice = document.getElementById("form-notice");
      const submitButton = document.getElementById("submit-button");
      const refreshButton = document.getElementById("refresh-button");
      const fillDefaultsButton = document.getElementById("fill-defaults-button");

      function setNotice(message, tone) {
        formNotice.textContent = message;
        if (tone) {
          formNotice.dataset.tone = tone;
          return;
        }
        delete formNotice.dataset.tone;
      }

      function getApiBase() {
        return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
      }

      function toDisplayValue(value) {
        if (value === undefined || value === null || value === "") {
          return "-";
        }
        return String(value);
      }

      function updateStatusChip(status) {
        if (status.configured && status.healthy) {
          statusChip.textContent = "已配置且健康";
          statusChip.className = "status-chip status-ok";
          return;
        }
        if (status.configured) {
          statusChip.textContent = "已配置，健康检查未通过";
          statusChip.className = "status-chip status-bad";
          return;
        }
        statusChip.textContent = "未配置";
        statusChip.className = "status-chip status-bad";
      }

      function renderDefaults() {
        const cards = Object.entries(providerDefaults).map(([providerType, defaults]) => {
          const model = defaults && typeof defaults === "object" ? defaults.model ?? null : null;
          const baseUrl = defaults && typeof defaults === "object" ? defaults.baseUrl ?? null : null;
          return '<article class="provider-card">'
            + '<div class="provider-name mono">' + providerType + '</div>'
            + '<div><div class="kv-label">Default model</div><div class="kv-value mono">' + toDisplayValue(model) + '</div></div>'
            + '<div><div class="kv-label">Default baseUrl</div><div class="kv-value mono">' + toDisplayValue(baseUrl) + '</div></div>'
            + '</article>';
        }).join("");
        defaultsGrid.innerHTML = cards;
      }

      function fillDefaultsForSelectedProvider() {
        const providerType = providerTypeSelect.value;
        const defaults = providerDefaults[providerType] ?? {};
        modelInput.value = defaults.model ?? "";
        baseUrlInput.value = defaults.baseUrl ?? "";
        if (providerType === "ollama") {
          apiKeyInput.placeholder = "Ollama 可留空";
        } else {
          apiKeyInput.placeholder = "sk-...";
        }
      }

      async function fetchJson(path, init) {
        const response = await fetch(getApiBase() + path, {
          ...init,
          headers: {
            "Content-Type": "application/json",
            ...(init && init.headers ? init.headers : {}),
          },
        });
        const payload = await response.json();
        if (!response.ok) {
          const message = payload && typeof payload === "object" && "error" in payload ? payload.error : response.statusText;
          throw new Error(String(message));
        }
        return payload;
      }

      async function loadProviders() {
        const providers = await fetchJson("/config/providers");
        providerTypeSelect.innerHTML = "";
        for (const providerType of providers) {
          const option = document.createElement("option");
          option.value = providerType;
          option.textContent = providerType;
          providerTypeSelect.append(option);
        }
        if (!providerTypeSelect.value && providers.length > 0) {
          providerTypeSelect.value = providers[0];
        }
        fillDefaultsForSelectedProvider();
      }

      function resolveBaseUrlFromSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== "object") {
          return null;
        }
        if (snapshot.baseUrl && typeof snapshot.baseUrl === "object" && "value" in snapshot.baseUrl && snapshot.baseUrl.value) {
          return snapshot.baseUrl.value;
        }
        return null;
      }

      async function refreshStatus() {
        const status = await fetchJson("/config/status");
        let providerConfig = { configured: false, sourceSnapshot: null };
        try {
          providerConfig = await fetchJson("/config/provider");
        } catch (error) {
        }

        updateStatusChip(status);
        currentProvider.textContent = toDisplayValue(status.provider);
        currentModel.textContent = toDisplayValue(status.model);
        currentSource.textContent = toDisplayValue(status.source);
        currentBaseUrl.textContent = toDisplayValue(resolveBaseUrlFromSnapshot(status.sourceSnapshot));
        sourceDetail.textContent = toDisplayValue(status.sourceDetail);
        sourceSnapshot.textContent = JSON.stringify(providerConfig.sourceSnapshot ?? status.sourceSnapshot ?? {}, null, 2);

        if (providerConfig.configured && providerConfig.providerType) {
          providerTypeSelect.value = providerConfig.providerType;
          modelInput.value = providerConfig.model ?? "";
        }
      }

      async function initialize() {
        renderDefaults();
        await loadProviders();
        await refreshStatus();
      }

      providerTypeSelect.addEventListener("change", () => {
        fillDefaultsForSelectedProvider();
        setNotice("", undefined);
      });

      fillDefaultsButton.addEventListener("click", () => {
        fillDefaultsForSelectedProvider();
        setNotice("已填入统一默认值。", "success");
      });

      refreshButton.addEventListener("click", async () => {
        refreshButton.disabled = true;
        setNotice("正在刷新状态...", undefined);
        try {
          await refreshStatus();
          setNotice("状态已刷新。", "success");
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error), "error");
        } finally {
          refreshButton.disabled = false;
        }
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        submitButton.disabled = true;
        setNotice("正在保存配置...", undefined);
        const providerType = providerTypeSelect.value;
        const payload = {
          provider_type: providerType,
          ...(apiKeyInput.value ? { api_key: apiKeyInput.value } : {}),
          ...(modelInput.value ? { model: modelInput.value } : {}),
          ...(baseUrlInput.value ? { base_url: baseUrlInput.value } : {}),
        };

        try {
          await fetchJson("/config/provider", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          await refreshStatus();
          setNotice("Provider 配置已保存。", "success");
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error), "error");
        } finally {
          submitButton.disabled = false;
        }
      });

      initialize().catch((error) => {
        updateStatusChip({ configured: false, healthy: false });
        setNotice(error instanceof Error ? error.message : String(error), "error");
      });
    </script>
  </body>
</html>`;
}
