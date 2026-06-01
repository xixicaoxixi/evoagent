export interface ProviderDefaults {
  readonly model?: string;
  readonly baseUrl?: string;
  readonly temperature?: number;
}

export const ProviderCompatibility = {
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  OLLAMA: "ollama",
  CUSTOM: "custom",
} as const;

export type ProviderCompatibility = (typeof ProviderCompatibility)[keyof typeof ProviderCompatibility];

export interface ProviderMetadata {
  readonly type: string;
  readonly compatibility: ProviderCompatibility;
  readonly displayName: string;
  readonly detectable: boolean;
  readonly envKey?: string;
  readonly envModel?: string;
  readonly showInUI: boolean;
}

export const PROVIDER_METADATA: Readonly<Record<string, ProviderMetadata>> = {
  openai: {
    type: "openai",
    compatibility: ProviderCompatibility.OPENAI,
    displayName: "OpenAI",
    detectable: true,
    envKey: "OPENAI_API_KEY",
    envModel: "OPENAI_MODEL",
    showInUI: true,
  },
  deepseek: {
    type: "deepseek",
    compatibility: ProviderCompatibility.OPENAI,
    displayName: "DeepSeek",
    detectable: true,
    envKey: "DEEPSEEK_API_KEY",
    envModel: "DEEPSEEK_MODEL",
    showInUI: true,
  },
  kimi: {
    type: "kimi",
    compatibility: ProviderCompatibility.OPENAI,
    displayName: "Kimi",
    detectable: true,
    envKey: "KIMI_API_KEY",
    envModel: "KIMI_MODEL",
    showInUI: true,
  },
  glm: {
    type: "glm",
    compatibility: ProviderCompatibility.OPENAI,
    displayName: "GLM",
    detectable: true,
    envKey: "GLM_API_KEY",
    envModel: "GLM_MODEL",
    showInUI: true,
  },
  "glm-coding": {
    type: "glm-coding",
    compatibility: ProviderCompatibility.OPENAI,
    displayName: "GLM Coding",
    detectable: false,
    showInUI: false,
  },
  "glm-anthropic": {
    type: "glm-anthropic",
    compatibility: ProviderCompatibility.ANTHROPIC,
    displayName: "GLM Anthropic",
    detectable: false,
    showInUI: false,
  },
  anthropic: {
    type: "anthropic",
    compatibility: ProviderCompatibility.ANTHROPIC,
    displayName: "Anthropic",
    detectable: true,
    envKey: "ANTHROPIC_API_KEY",
    envModel: "ANTHROPIC_MODEL",
    showInUI: true,
  },
  ollama: {
    type: "ollama",
    compatibility: ProviderCompatibility.OLLAMA,
    displayName: "Ollama",
    detectable: false,
    showInUI: true,
  },
  custom: {
    type: "custom",
    compatibility: ProviderCompatibility.CUSTOM,
    displayName: "Custom",
    detectable: false,
    showInUI: true,
  },
  mock: {
    type: "mock",
    compatibility: ProviderCompatibility.CUSTOM,
    displayName: "Mock",
    detectable: false,
    showInUI: false,
  },
};

export function getProvidersByCompatibility(compatibility: ProviderCompatibility): readonly string[] {
  return Object.values(PROVIDER_METADATA)
    .filter((meta) => meta.compatibility === compatibility)
    .map((meta) => meta.type);
}

export function getUIProviders(): readonly string[] {
  return Object.values(PROVIDER_METADATA)
    .filter((meta) => meta.showInUI)
    .map((meta) => meta.type);
}

export function getDetectableProviders(): readonly ProviderMetadata[] {
  return Object.values(PROVIDER_METADATA)
    .filter((meta) => meta.detectable && !!meta.envKey && !!meta.envModel);
}

export function getProviderDisplayName(providerType: string): string {
  return PROVIDER_METADATA[providerType]?.displayName ?? providerType;
}

export const PROVIDER_DEFAULTS: Readonly<Record<string, ProviderDefaults>> = {
  openai: {
    model: "gpt-5.4",
    baseUrl: "https://api.openai.com/v1",
    temperature: 0.1,
  },
  anthropic: {
    model: "claude-sonnet-4-6",
    baseUrl: "https://api.anthropic.com",
    temperature: 0.1,
  },
  ollama: {
    model: "llama3",
    baseUrl: "http://localhost:11434",
  },
  deepseek: {
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com",
  },
  kimi: {
    model: "kimi-k2.6",
    baseUrl: "https://api.moonshot.cn/v1",
  },
  glm: {
    model: "glm-5.1",
  },
  "glm-coding": {
    model: "glm-5.1",
  },
  "glm-anthropic": {
    model: "glm-5.1",
  },
  custom: {},
  mock: {},
};

export function getProviderDefaults(providerType: string): ProviderDefaults {
  return PROVIDER_DEFAULTS[providerType.trim().toLowerCase()] ?? {};
}
