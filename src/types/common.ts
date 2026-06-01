export type ProviderType =
  | "openai"
  | "deepseek"
  | "kimi"
  | "anthropic"
  | "ollama"
  | "glm"
  | "glm-coding"
  | "glm-anthropic"
  | "custom"
  | "mock";

export const ProviderType = {
  OPENAI: "openai",
  DEEPSEEK: "deepseek",
  KIMI: "kimi",
  ANTHROPIC: "anthropic",
  OLLAMA: "ollama",
  GLM: "glm",
  GLM_CODING: "glm-coding",
  GLM_ANTHROPIC: "glm-anthropic",
  CUSTOM: "custom",
  MOCK: "mock",
} as const satisfies Readonly<Record<string, ProviderType>>;

export type InvocationPriority = "interactive" | "background" | "batch";

export interface ModelCapabilities {
  readonly reasoning: boolean;
  readonly vision: boolean;
  readonly toolSearch: boolean;
  readonly compaction: boolean;
  readonly structuredOutputs: boolean;
  readonly streaming: boolean;
  readonly toolCalling: boolean;
}

export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_TIMEOUT_MS = 300000;

export const MODEL_PROVIDER_MAP: Readonly<Record<string, ProviderType>> = {
  "gpt-5.6": "openai",
  "gpt-5.4": "openai",
  "gpt-5.4-pro": "openai",
  "gpt-5.4-mini": "openai",
  "gpt-5.4-nano": "openai",
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "gpt-4-turbo": "openai",
  "gpt-4": "openai",
  "gpt-3.5-turbo": "openai",
  "qwen-plus": "openai",
  "qwen-turbo": "openai",
  "qwen-max": "openai",
  "claude-opus-4-6": "anthropic",
  "claude-sonnet-4-6": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "claude-mythos-preview": "anthropic",
  "claude-sonnet-4-20250514": "anthropic",
  "claude-3-5-sonnet-20241022": "anthropic",
  "claude-3-opus-20240229": "anthropic",
  "deepseek-chat": "deepseek",
  "deepseek-v4-pro": "deepseek",
  "deepseek-r1": "deepseek",
  "deepseek-v3.2": "deepseek",
  "deepseek-v3": "deepseek",
  "deepseek-reasoner": "deepseek",
  "kimi-k2.5": "kimi",
  "kimi-k2.6": "kimi",
  "moonshot-v1-8k": "kimi",
  "moonshot-v1-32k": "kimi",
  "moonshot-v1-128k": "kimi",
  "glm-5.1": "glm",
  "glm-4.7": "glm",
  "glm-4.6v": "glm",
  "glm-4-plus": "glm",
  "glm-4-long": "glm",
  "glm-4-flash": "glm",
  llama3: "ollama",
  mistral: "ollama",
  codellama: "ollama",
  phi3: "ollama",
};

export const CONTEXT_WINDOW_MAP: Readonly<Record<string, number>> = {
  "gpt-5.6": 128000,
  "gpt-5.4": 1_000_000,
  "gpt-5.4-pro": 1_000_000,
  "gpt-5.4-mini": 1_000_000,
  "gpt-5.4-nano": 1_000_000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 256000,
  "claude-sonnet-4-20250514": 200000,
  "claude-3-5-sonnet-20241022": 200000,
  "deepseek-chat": 128000,
  "deepseek-v4-pro": 128000,
  "deepseek-r1": 128000,
  "deepseek-v3.2": 128000,
  "deepseek-reasoner": 128000,
  "kimi-k2.5": 256000,
  "kimi-k2.6": 128000,
  "moonshot-v1-8k": 8000,
  "moonshot-v1-32k": 32000,
  "moonshot-v1-128k": 128000,
  "glm-5.1": 128000,
  "glm-4.7": 128000,
  "glm-4-long": 1_000_000,
  llama3: 8192,
  mistral: 32000,
  codellama: 16384,
  phi3: 4096,
};

export const MODEL_CAPABILITIES: Readonly<Record<string, ModelCapabilities>> = {
  "gpt-5.6": { reasoning: true, vision: true, toolSearch: true, compaction: true, structuredOutputs: true, streaming: true, toolCalling: true },
  "gpt-5.4": { reasoning: true, vision: true, toolSearch: true, compaction: true, structuredOutputs: true, streaming: true, toolCalling: true },
  "gpt-5.4-pro": { reasoning: true, vision: true, toolSearch: true, compaction: true, structuredOutputs: true, streaming: true, toolCalling: true },
  "gpt-5.4-mini": { reasoning: true, vision: true, toolSearch: true, compaction: true, structuredOutputs: true, streaming: true, toolCalling: true },
  "gpt-5.4-nano": { reasoning: true, vision: false, toolSearch: false, compaction: false, structuredOutputs: true, streaming: true, toolCalling: true },
  "gpt-4o": { reasoning: false, vision: true, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "gpt-4o-mini": { reasoning: false, vision: true, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "claude-opus-4-6": { reasoning: true, vision: true, toolSearch: true, compaction: true, structuredOutputs: true, streaming: true, toolCalling: true },
  "claude-sonnet-4-6": { reasoning: true, vision: true, toolSearch: true, compaction: true, structuredOutputs: true, streaming: true, toolCalling: true },
  "claude-haiku-4-5": { reasoning: false, vision: true, toolSearch: false, compaction: false, structuredOutputs: true, streaming: true, toolCalling: true },
  "claude-sonnet-4-20250514": { reasoning: true, vision: true, toolSearch: false, compaction: true, structuredOutputs: true, streaming: true, toolCalling: true },
  "claude-3-5-sonnet-20241022": { reasoning: true, vision: true, toolSearch: false, compaction: false, structuredOutputs: true, streaming: true, toolCalling: true },
  "deepseek-chat": { reasoning: false, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "deepseek-v4-pro": { reasoning: true, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "deepseek-r1": { reasoning: true, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "deepseek-v3.2": { reasoning: false, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "deepseek-reasoner": { reasoning: true, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "kimi-k2.5": { reasoning: true, vision: true, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "kimi-k2.6": { reasoning: true, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "moonshot-v1-8k": { reasoning: false, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "glm-5.1": { reasoning: true, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "glm-4.7": { reasoning: true, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "glm-4.6v": { reasoning: true, vision: true, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "glm-4-plus": { reasoning: true, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  "glm-4-long": { reasoning: true, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  llama3: { reasoning: false, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: false },
  mistral: { reasoning: false, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
  codellama: { reasoning: false, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: false },
  phi3: { reasoning: false, vision: false, toolSearch: false, compaction: false, structuredOutputs: false, streaming: true, toolCalling: true },
};

export const PROVIDER_BASE_URL_MAP: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com",
  kimi: "https://api.moonshot.cn/v1",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  ollama: "http://localhost:11434",
};

export function inferProviderType(model: string): ProviderType | undefined {
  return MODEL_PROVIDER_MAP[model.trim().toLowerCase()] ?? MODEL_PROVIDER_MAP[model.trim()] ?? undefined;
}

export function getContextWindow(model: string): number {
  return CONTEXT_WINDOW_MAP[model.trim()] ?? 128000;
}

export function getModelCapabilities(model: string): ModelCapabilities {
  return MODEL_CAPABILITIES[model.trim()] ?? {
    reasoning: false,
    vision: false,
    toolSearch: false,
    compaction: false,
    structuredOutputs: false,
    streaming: true,
    toolCalling: false,
  };
}

export function estimateTokens(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x7f) {
      count += 2;
    } else {
      count += 1;
    }
  }
  return Math.ceil(count / 4);
}
