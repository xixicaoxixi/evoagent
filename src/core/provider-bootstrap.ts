import { detectProviders, loadDotEnv } from "./provider-detect";
import type { ProviderConfigStore } from "./provider-config";
import type { EvoAgentContext } from "../integration/context";
import { PROVIDER_METADATA, getProviderDefaults } from "../types/provider-defaults";

export interface ProviderBootstrapOptions {
  readonly sourceDetail: string;
  readonly providerType?: string;
}

export async function bootstrapAutoDetectedProvider(
  configStore: ProviderConfigStore,
  options: ProviderBootstrapOptions,
): Promise<EvoAgentContext | undefined> {
  loadDotEnv();

  const explicitType = options.providerType ?? process.env.EVOAGENT_PROVIDER?.trim().toLowerCase();

  if (explicitType) {
    const metadata = PROVIDER_METADATA[explicitType];
    if (!metadata) {
      throw new Error(
        `Unknown provider type: "${explicitType}". Available: ${Object.keys(PROVIDER_METADATA).filter((k) => PROVIDER_METADATA[k]?.showInUI).join(", ")}`,
      );
    }

    const envKey = metadata.envKey;
    const envModel = metadata.envModel;
    if (!envKey || !envModel) {
      throw new Error(
        `Provider "${explicitType}" is not auto-detectable. Set ${explicitType.toUpperCase()}_API_KEY and ${explicitType.toUpperCase()}_MODEL environment variables.`,
      );
    }

    const apiKey = process.env[envKey];
    if (!apiKey) {
      throw new Error(
        `Provider "${explicitType}" selected but ${envKey} environment variable is not set.`,
      );
    }

    const defaults = getProviderDefaults(explicitType);
    const model = process.env[envModel]?.trim() || defaults.model || "";
    const baseUrl = defaults.baseUrl || "";

    if (!model) {
      throw new Error(
        `Provider "${explicitType}" selected but no model specified. Set ${envModel} environment variable.`,
      );
    }

    return configStore.applyAutoDetectedProvider({
      providerType: explicitType,
      apiKey,
      model,
      baseUrl,
      source: "env_auto_detected",
      sourceDetail: options.sourceDetail || `Explicitly selected provider ${explicitType} via --provider or EVOAGENT_PROVIDER.`,
    });
  }

  const detected = detectProviders();
  if (detected.length === 0) {
    return undefined;
  }

  const primary = detected[0]!;
  return configStore.applyAutoDetectedProvider({
    providerType: primary.type,
    apiKey: primary.key,
    model: primary.model,
    baseUrl: primary.baseUrl,
    source: "env_auto_detected",
    sourceDetail: options.sourceDetail || `Detected from ${primary.type.toUpperCase()}_API_KEY.`,
  });
}
