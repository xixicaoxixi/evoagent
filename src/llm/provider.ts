import type {
  LLMProvider,
  LLMMessageParam,
  LLMResponse,
  LLMStreamChunk,
  ProviderConfig,
} from "../interfaces/llm-provider";
import { inferProviderType, estimateTokens } from "../types/common";
import { DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS } from "../types/common";
import { getProviderDefaults, getProvidersByCompatibility, ProviderCompatibility } from "../types/provider-defaults";

type ProviderConstructor = (config: ProviderConfig) => LLMProvider;

const providerRegistry = new Map<string, ProviderConstructor>();

export function registerProvider(
  type: string,
  constructor: ProviderConstructor,
): void {
  providerRegistry.set(type, constructor);
}

export function createProvider(config: ProviderConfig = {}): LLMProvider {
  const providerType =
    config.providerType ?? inferProviderType(config.model ?? "") ?? "openai";

  let effectiveProviderType: string;
  const openaiCompatible = getProvidersByCompatibility(ProviderCompatibility.OPENAI);
  const anthropicCompatible = getProvidersByCompatibility(ProviderCompatibility.ANTHROPIC);
  if (openaiCompatible.includes(providerType)) {
    effectiveProviderType = "openai";
  } else if (anthropicCompatible.includes(providerType)) {
    effectiveProviderType = "anthropic";
  } else {
    effectiveProviderType = providerType;
  }

  const defaults = getProviderDefaults(providerType);
  const effectiveConfig: ProviderConfig = {
    ...config,
    ...(defaults.baseUrl && !config.baseUrl ? { baseUrl: defaults.baseUrl } : {}),
    ...(defaults.model && !config.model ? { model: defaults.model } : {}),
  };

  const constructor = providerRegistry.get(effectiveProviderType);
  if (!constructor) {
    throw new Error(`Unknown provider type: ${providerType}`);
  }

  const provider = constructor(effectiveConfig);
  return provider;
}

export function fromUserConfig(userConfig: {
  provider_type?: string;
  model?: string;
  api_key?: string;
  base_url?: string;
  temperature?: number;
  max_tokens?: number;
}): LLMProvider {
  return createProvider({
    ...(userConfig.provider_type !== undefined ? { providerType: userConfig.provider_type } : {}),
    ...(userConfig.model !== undefined ? { model: userConfig.model } : {}),
    ...(userConfig.api_key !== undefined ? { apiKey: userConfig.api_key } : {}),
    ...(userConfig.base_url !== undefined ? { baseUrl: userConfig.base_url } : {}),
    ...(userConfig.temperature !== undefined ? { temperature: userConfig.temperature } : {}),
    ...(userConfig.max_tokens !== undefined ? { maxTokens: userConfig.max_tokens } : {}),
  });
}

export { estimateTokens };

export { DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS };
