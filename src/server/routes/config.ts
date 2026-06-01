import type { RouteEntry, HttpRequest } from "../../server";
import { jsonResponse, errorResponse } from "../../server";
import {
  createProviderConfigStore,
  type ProviderConfigInput,
  type ProviderConfigSnapshot,
  type ProviderConfigStore,
  type ProviderConfigStoreStatus,
} from "../../core/provider-config";
import { getUIProviders } from "../../types/provider-defaults";

interface SetProviderBody {
  provider_type?: string;
  api_key?: string;
  model?: string;
  base_url?: string;
}

interface ProviderSourceView {
  readonly effective: ProviderConfigStoreStatus["source"]["effective"];
  readonly provider: ProviderConfigStoreStatus["source"]["provider"];
  readonly model: ProviderConfigStoreStatus["source"]["model"];
  readonly baseUrl: ProviderConfigStoreStatus["source"]["baseUrl"];
}

function toProviderSourceView(status: ProviderConfigStoreStatus): ProviderSourceView {
  return {
    effective: status.source.effective,
    provider: status.source.provider,
    model: status.source.model,
    baseUrl: status.source.baseUrl,
  };
}

function createSupportedProvidersView(): readonly string[] {
  const store = createProviderConfigStore();
  const snapshot = store.getSnapshot();
  const providers = getUIProviders();
  if (snapshot.providerType && !providers.includes(snapshot.providerType)) {
    return [...providers, snapshot.providerType];
  }
  return providers;
}

export interface ConfigRouteDeps {
  configStore: ProviderConfigStore;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getConfiguredProviderType(status: ProviderConfigStoreStatus): string | null {
  return status.configured ? status.provider ?? null : null;
}

function getSourceDetail(status: ProviderConfigStoreStatus): string | null {
  return status.configured ? status.source.provider.detail : null;
}

function buildSetProviderInput(body: SetProviderBody): ProviderConfigInput {
  const input: ProviderConfigInput = {
    providerType: body.provider_type ?? "",
    apiKey: body.api_key ?? "ollama",
    source: "persisted_config",
    sourceDetail: body.provider_type === "ollama"
      ? "Configured via Web UI without API key."
      : "Configured via Web UI.",
  };
  if (body.model) {
    Object.assign(input, { model: body.model });
  }
  if (body.base_url) {
    Object.assign(input, { baseUrl: body.base_url });
  }
  return input;
}

export function registerConfigRoutes(deps: ConfigRouteDeps): RouteEntry[] {
  return [
    {
      method: "GET",
      pattern: "/config/providers",
      auth: true,
      handler: () => {
        return jsonResponse(createSupportedProvidersView());
      },
    },
    {
      method: "POST",
      pattern: "/config/provider",
      auth: true,
      handler: async (req: HttpRequest) => {
        const body = (req.body ?? {}) as SetProviderBody;

        if (!body.provider_type) {
          return errorResponse("Missing 'provider_type' field", 400);
        }
        if (!body.api_key && body.provider_type !== "ollama") {
          return errorResponse("Missing 'api_key' field", 400);
        }

        const store = deps.configStore;

        try {
          await store.setProvider(buildSetProviderInput(body));
          const status = await store.getStatus();
          return jsonResponse({
            ok: true,
            providerType: getConfiguredProviderType(status),
            model: status.model ?? null,
            source: status.source.effective,
            sourceDetail: getSourceDetail(status),
            sourceSnapshot: toProviderSourceView(status),
            healthy: status.healthy,
            message: "Provider configured",
          });
        } catch (error) {
          return errorResponse(`Failed to update provider: ${getErrorMessage(error)}`, 500);
        }
      },
    },
    {
      method: "GET",
      pattern: "/config/provider",
      auth: true,
      handler: async () => {
        const status = await deps.configStore.getStatus();
        if (!status.configured) {
          return jsonResponse({
            configured: false,
            sourceSnapshot: toProviderSourceView(status),
          });
        }

        return jsonResponse({
          configured: true,
          providerType: getConfiguredProviderType(status),
          model: status.model ?? null,
          source: status.source.effective,
          sourceDetail: getSourceDetail(status),
          sourceSnapshot: toProviderSourceView(status),
          apiKeyPreview: status.apiKeyPreview,
          healthy: status.healthy,
        });
      },
    },
    {
      method: "GET",
      pattern: "/config/status",
      auth: true,
      handler: async () => {
        try {
          const status = await deps.configStore.getStatus();
          return jsonResponse({
            configured: status.configured,
            healthy: status.healthy,
            provider: getConfiguredProviderType(status),
            source: status.configured ? status.source.effective : null,
            sourceDetail: getSourceDetail(status),
            sourceSnapshot: toProviderSourceView(status),
            model: status.configured ? status.model ?? null : null,
          });
        } catch (error) {
          return jsonResponse({
            configured: false,
            healthy: false,
            provider: null,
            source: null,
            sourceSnapshot: null,
            error: getErrorMessage(error),
          });
        }
      },
    },
  ];
}
