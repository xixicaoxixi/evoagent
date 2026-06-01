import { createEvoAgentContext } from "../integration/context";
import { createMemoryReadFileState } from "../tools/file/write";
import { createBuiltinTools } from "../tools/builtin";
import { fromUserConfig, registerProvider } from "../llm/provider";
import { OpenAIProvider } from "../llm/openai";
import { AnthropicProvider } from "../llm/anthropic";
import { OllamaProvider } from "../llm/ollama";
import { createLogger } from "../observability/logger";
import { getProviderDefaults, getProvidersByCompatibility, ProviderCompatibility, PROVIDER_METADATA } from "../types/provider-defaults";

export type ProviderConfigSourceKind = "default" | "env" | "env_auto_detected" | "persisted_config" | "runtime_override" | "route";

export interface ProviderConfigInput {
  readonly providerType: string;
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly source: ProviderConfigSourceKind;
  readonly sourceDetail?: string;
}

export interface ProviderConfigRecord {
  readonly providerType: string;
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly source: ProviderConfigSourceKind;
  readonly sourceDetail: string;
}

export interface ProviderConfigSnapshot {
  readonly configured: boolean;
  readonly provider?: string;
  readonly providerType?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly apiKeySet: boolean;
  readonly apiKeyPreview?: string;
  readonly source: {
    readonly effective: ProviderConfigSourceKind | "unconfigured";
    readonly autoDetected: boolean;
    readonly priority: readonly ProviderConfigSourceKind[];
    readonly provider: {
      readonly source: ProviderConfigSourceKind | "unconfigured";
      readonly detail: string;
      readonly value?: string;
    };
    readonly model: {
      readonly source: ProviderConfigSourceKind | "unconfigured";
      readonly detail: string;
      readonly value?: string;
    };
    readonly baseUrl: {
      readonly source: ProviderConfigSourceKind | "unconfigured";
      readonly detail: string;
      readonly value?: string;
    };
    readonly conflicts: readonly {
      readonly field: "provider" | "apiKey" | "model" | "baseUrl";
      readonly winner: ProviderConfigSourceKind;
      readonly loser: ProviderConfigSourceKind;
      readonly message: string;
    }[];
  };
  readonly sourceSnapshot: Readonly<Record<ProviderConfigSourceKind, boolean>>;
}

export interface ProviderConfigStoreStatus {
  readonly configured: boolean;
  readonly healthy: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly apiKeyPreview?: string;
  readonly source: {
    readonly effective: ProviderConfigSourceKind | "unconfigured";
    readonly provider: {
      readonly source: ProviderConfigSourceKind | "unconfigured";
      readonly detail: string;
      readonly value?: string;
    };
    readonly model: {
      readonly source: ProviderConfigSourceKind | "unconfigured";
      readonly detail: string;
      readonly value?: string;
    };
    readonly baseUrl: {
      readonly source: ProviderConfigSourceKind | "unconfigured";
      readonly detail: string;
      readonly value?: string;
    };
  };
}

export interface ProviderRuntimeBinding {
  readonly provider: ReturnType<typeof fromUserConfig>;
  readonly context: Awaited<ReturnType<typeof createEvoAgentContext>>;
  readonly engine: ReturnType<Awaited<ReturnType<typeof createEvoAgentContext>>["getEngine"]>;
}

export interface ProviderConfigStore {
  applyRecord(input: ProviderConfigInput): Promise<Awaited<ReturnType<typeof createEvoAgentContext>>>;
  applyAutoDetectedProvider(input: ProviderConfigInput): Promise<Awaited<ReturnType<typeof createEvoAgentContext>>>;
  setProvider(input: Omit<ProviderConfigInput, "source"> & { readonly source?: ProviderConfigSourceKind }): Promise<Awaited<ReturnType<typeof createEvoAgentContext>>>;
  clearSource(source: ProviderConfigSourceKind): void;
  getProviderType(): string | undefined;
  getApiKey(): string | undefined;
  getModel(): string | undefined;
  getBaseUrl(): string | undefined;
  getSource(): ProviderConfigSourceKind | undefined;
  getSourceDetail(): string | undefined;
  getContext(): Awaited<ReturnType<typeof createEvoAgentContext>> | undefined;
  getSnapshot(): ProviderConfigSnapshot;
  getStatus(): Promise<ProviderConfigStoreStatus>;
}

const SOURCE_PRIORITY: Readonly<Record<ProviderConfigSourceKind, number>> = {
  default: 0,
  env: 1,
  env_auto_detected: 1,
  persisted_config: 2,
  route: 2,
  runtime_override: 3,
};

const SOURCE_PRIORITY_ORDER = ["runtime_override", "persisted_config", "route", "env_auto_detected", "env", "default"] as const satisfies readonly ProviderConfigSourceKind[];

const UNCONFIGURED_DETAIL = "No provider configuration has been applied.";

function registerProviderAliases(
  type: string,
  factory: (config: { model?: string; apiKey?: string; baseUrl?: string; temperature?: number; maxTokens?: number }) => ReturnType<typeof fromUserConfig>,
  aliases: readonly string[],
): void {
  registerProvider(type, factory);
  for (const alias of aliases) {
    registerProvider(alias, factory);
  }
}

function resolveModel(providerType: string, model: string | undefined): string | undefined {
  if (model && model.trim().length > 0) {
    return model.trim();
  }
  return getProviderDefaults(providerType).model;
}

function resolveBaseUrl(providerType: string, baseUrl: string | undefined): string | undefined {
  if (baseUrl && baseUrl.trim().length > 0) {
    return baseUrl.trim();
  }
  return getProviderDefaults(providerType).baseUrl;
}

function normalizeProviderType(providerType: string): string {
  return providerType.trim().toLowerCase();
}

function createAllowAllRules(): readonly { readonly pattern: string; readonly behavior: "allow" }[] {
  return [{ pattern: ".*", behavior: "allow" }];
}

function pickWinningRecord(records: readonly ProviderConfigRecord[]): ProviderConfigRecord | undefined {
  let winner: ProviderConfigRecord | undefined;
  for (const record of records) {
    if (!winner) {
      winner = record;
      continue;
    }
    if (SOURCE_PRIORITY[record.source] >= SOURCE_PRIORITY[winner.source]) {
      winner = record;
    }
  }
  return winner;
}

function buildUnconfiguredStatus(): ProviderConfigStoreStatus {
  return {
    configured: false,
    healthy: false,
    source: {
      effective: "unconfigured",
      provider: { source: "unconfigured", detail: UNCONFIGURED_DETAIL },
      model: { source: "unconfigured", detail: UNCONFIGURED_DETAIL },
      baseUrl: { source: "unconfigured", detail: UNCONFIGURED_DETAIL },
    },
  };
}

function previewApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return `${apiKey.slice(0, 2)}****${apiKey.slice(-2)}`;
  }
  return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
}

export interface ProviderConfigConflict {
  readonly loser: ProviderConfigSourceKind;
  readonly winner: ProviderConfigSourceKind;
  readonly field: "provider" | "apiKey" | "model" | "baseUrl";
  readonly message: string;
}

export function detectProviderConfigConflicts(records: readonly ProviderConfigRecord[]): readonly ProviderConfigConflict[] {
  const conflicts: ProviderConfigConflict[] = [];
  const winner = pickWinningRecord(records);
  if (!winner) {
    return conflicts;
  }

  for (const record of records) {
    if (record.source === winner.source) {
      continue;
    }

    if (record.providerType !== winner.providerType) {
      conflicts.push({
        loser: record.source,
        winner: winner.source,
        field: "provider",
        message: `Provider type from ${record.source} (${record.providerType}) is shadowed by ${winner.source} (${winner.providerType})`,
      });
    }
    if (record.apiKey !== winner.apiKey) {
      conflicts.push({
        loser: record.source,
        winner: winner.source,
        field: "apiKey",
        message: `API key from ${record.source} is shadowed by ${winner.source}`,
      });
    }
    if ((record.model ?? "") !== (winner.model ?? "")) {
      conflicts.push({
        loser: record.source,
        winner: winner.source,
        field: "model",
        message: `Model from ${record.source} (${record.model ?? "<none>"}) is shadowed by ${winner.source} (${winner.model ?? "<none>"})`,
      });
    }
    if ((record.baseUrl ?? "") !== (winner.baseUrl ?? "")) {
      conflicts.push({
        loser: record.source,
        winner: winner.source,
        field: "baseUrl",
        message: `Base URL from ${record.source} (${record.baseUrl ?? "<none>"}) is shadowed by ${winner.source} (${winner.baseUrl ?? "<none>"})`,
      });
    }
  }
  return conflicts;
}

async function createRuntimeBinding(record: ProviderConfigRecord, onBinding: () => void): Promise<ProviderRuntimeBinding> {
  onBinding();

  const provider = fromUserConfig({
    provider_type: normalizeProviderType(record.providerType),
    api_key: record.apiKey,
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.baseUrl !== undefined ? { base_url: record.baseUrl } : {}),
  });

  const tools = createBuiltinTools({
    bashPermissionContext: {
      sandboxed: true,
      rules: createAllowAllRules(),
    },
    readFileState: createMemoryReadFileState(),
  });

  const context = await createEvoAgentContext({
    provider,
    tools,
    canUseTool: () => true,
    toolUseContext: {
      cwd: process.cwd(),
      getAppState: () => ({}),
    },
    baseSystemPrompt: "You are EvoAgent, a self-evolving AI agent system. You can use tools to help users. Respond helpfully and concisely in the same language the user uses.",
    logger: createLogger({
      source: "evoagent",
      handler: () => {},
    }),
  });

  return {
    provider,
    context,
    engine: context.getEngine(),
  };
}

function normalizeInput(input: ProviderConfigInput): ProviderConfigRecord {
  const model = resolveModel(input.providerType, input.model);
  const baseUrl = resolveBaseUrl(input.providerType, input.baseUrl);
  return {
    providerType: input.providerType,
    apiKey: input.apiKey,
    ...(model !== undefined ? { model } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    source: input.source,
    sourceDetail: input.sourceDetail ?? `Applied from ${input.source}.`,
  };
}

export function createProviderConfigStore(): ProviderConfigStore {
  const records = new Map<ProviderConfigSourceKind, ProviderConfigRecord>();
  let activeRecord: ProviderConfigRecord | undefined;
  let runtimeBinding: ProviderRuntimeBinding | undefined;
  let _providersRegistered = false;

  function registerDefaultProviders(): void {
    if (_providersRegistered) return;
    _providersRegistered = true;
    registerProviderAliases("openai", (config) => new OpenAIProvider(config), getProvidersByCompatibility(ProviderCompatibility.OPENAI).filter((t) => t !== "openai"));
    registerProviderAliases("anthropic", (config) => new AnthropicProvider(config), getProvidersByCompatibility(ProviderCompatibility.ANTHROPIC).filter((t) => t !== "anthropic"));
    registerProviderAliases("ollama", (config) => new OllamaProvider(config), getProvidersByCompatibility(ProviderCompatibility.OLLAMA).filter((t) => t !== "ollama"));
  }

  async function applyRecord(input: ProviderConfigInput): Promise<Awaited<ReturnType<typeof createEvoAgentContext>>> {
    const record = normalizeInput(input);
    records.set(record.source, record);
    activeRecord = pickWinningRecord([...records.values()]);
    if (!activeRecord) {
      throw new Error(`No provider configuration available after applying record (providerType="${record.providerType}", source="${record.source}")`);
    }
    runtimeBinding = await createRuntimeBinding(activeRecord, registerDefaultProviders);
    return runtimeBinding.context;
  }

  async function applyAutoDetectedProvider(input: ProviderConfigInput): Promise<Awaited<ReturnType<typeof createEvoAgentContext>>> {
    return applyRecord(input);
  }

  function getProviderType(): string | undefined {
    return activeRecord?.providerType;
  }

  function getApiKey(): string | undefined {
    return activeRecord?.apiKey;
  }

  function getModel(): string | undefined {
    return activeRecord?.model;
  }

  function getBaseUrl(): string | undefined {
    return activeRecord?.baseUrl;
  }

  function getSource(): ProviderConfigSourceKind | undefined {
    return activeRecord?.source;
  }

  function getSourceDetail(): string | undefined {
    return activeRecord?.sourceDetail;
  }

  function getContext(): Awaited<ReturnType<typeof createEvoAgentContext>> | undefined {
    return runtimeBinding?.context;
  }

  function clearSource(source: ProviderConfigSourceKind): void {
    records.delete(source);
    activeRecord = pickWinningRecord([...records.values()]);
    if (!activeRecord) {
      runtimeBinding = undefined;
    }
  }

  async function setProvider(
    input: Omit<ProviderConfigInput, "source"> & { readonly source?: ProviderConfigSourceKind },
  ): Promise<Awaited<ReturnType<typeof createEvoAgentContext>>> {
    return applyRecord({
      ...input,
      source: input.source ?? "persisted_config",
    });
  }

  function getSnapshot(): ProviderConfigSnapshot {
    const sourceSnapshot: Record<ProviderConfigSourceKind, boolean> = {
      default: records.has("default"),
      env: records.has("env"),
      env_auto_detected: records.has("env_auto_detected"),
      persisted_config: records.has("persisted_config"),
      runtime_override: records.has("runtime_override"),
      route: records.has("route"),
    };
    const conflicts = detectProviderConfigConflicts([...records.values()]);

    return {
      configured: activeRecord !== undefined,
      ...(activeRecord?.providerType !== undefined ? { provider: activeRecord.providerType, providerType: activeRecord.providerType } : {}),
      ...(activeRecord?.model !== undefined ? { model: activeRecord.model } : {}),
      ...(activeRecord?.baseUrl !== undefined ? { baseUrl: activeRecord.baseUrl } : {}),
      apiKeySet: activeRecord !== undefined,
      ...(activeRecord !== undefined ? { apiKeyPreview: previewApiKey(activeRecord.apiKey) } : {}),
      source: {
        effective: activeRecord?.source ?? "unconfigured",
        autoDetected: activeRecord?.source === "env_auto_detected",
        priority: SOURCE_PRIORITY_ORDER.filter((source) => sourceSnapshot[source]),
        provider: activeRecord
          ? { source: activeRecord.source, detail: activeRecord.sourceDetail, value: activeRecord.providerType }
          : { source: "unconfigured", detail: UNCONFIGURED_DETAIL },
        model: activeRecord
          ? { source: activeRecord.source, detail: activeRecord.sourceDetail, ...(activeRecord.model !== undefined ? { value: activeRecord.model } : {}) }
          : { source: "unconfigured", detail: UNCONFIGURED_DETAIL },
        baseUrl: activeRecord && activeRecord.baseUrl !== undefined
          ? { source: activeRecord.source, detail: activeRecord.sourceDetail, value: activeRecord.baseUrl }
          : { source: "unconfigured", detail: UNCONFIGURED_DETAIL },
        conflicts,
      },
      sourceSnapshot,
    };
  }

  async function getStatus(): Promise<ProviderConfigStoreStatus> {
    if (!activeRecord) {
      return buildUnconfiguredStatus();
    }

    const healthy = await runtimeBinding?.provider.healthCheck().catch(() => false) ?? false;
    return {
      configured: true,
      healthy,
      provider: activeRecord.providerType,
      ...(activeRecord.model !== undefined ? { model: activeRecord.model } : {}),
      apiKeyPreview: previewApiKey(activeRecord.apiKey),
      source: {
        effective: activeRecord.source,
        provider: {
          source: activeRecord.source,
          detail: activeRecord.sourceDetail,
          value: activeRecord.providerType,
        },
        model: {
          source: activeRecord.source,
          detail: activeRecord.sourceDetail,
          ...(activeRecord.model !== undefined ? { value: activeRecord.model } : {}),
        },
        baseUrl: {
          source: activeRecord.baseUrl !== undefined ? activeRecord.source : "unconfigured",
          detail: activeRecord.baseUrl !== undefined ? activeRecord.sourceDetail : UNCONFIGURED_DETAIL,
          ...(activeRecord.baseUrl !== undefined ? { value: activeRecord.baseUrl } : {}),
        },
      },
    };
  }

  return {
    applyRecord,
    applyAutoDetectedProvider,
    setProvider,
    clearSource,
    getProviderType,
    getApiKey,
    getModel,
    getBaseUrl,
    getSource,
    getSourceDetail,
    getContext,
    getSnapshot,
    getStatus,
  };
}
