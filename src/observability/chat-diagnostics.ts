import type { ProviderConfigSnapshot } from "../core/provider-config";

export interface ChatProviderSummary {
  readonly providerType: string;
  readonly model: string;
  readonly baseUrl?: string;
}

export interface ChatDiagnosticSummary {
  readonly requestId: string;
  readonly phase: "http_chat" | "http_chat_stream" | "http_chat_complex" | "context_chat" | "context_chat_complex";
  readonly provider: ChatProviderSummary;
  config?: {
    readonly configured: boolean;
    readonly source: ProviderConfigSnapshot["source"]["effective"];
    readonly autoDetected: boolean;
  };
  readonly message: {
    readonly length: number;
    readonly preview: string;
  };
  toolCalls?: number;
  stream?: {
    events: number;
    contentEvents: number;
    toolStartEvents: number;
    toolResultEvents: number;
    turnEndEvents: number;
  };
  terminal?: {
    readonly reason: string;
    readonly durationMs: number;
    readonly tokensUsed?: {
      readonly inputTokens: number;
      readonly outputTokens: number;
    };
  };
  error?: {
    readonly category: string;
    readonly message: string;
    readonly statusCode?: number;
    readonly retriable?: boolean;
  };
}

export interface ProviderErrorDiagnostic {
  readonly providerType: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly statusCode?: number;
  readonly category: "auth" | "rate_limit" | "server" | "network" | "client" | "unknown";
  readonly retriable: boolean;
  readonly message: string;
}

const MESSAGE_PREVIEW_LIMIT = 120;

export function createRequestId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

export function createMessageSummary(message: string): ChatDiagnosticSummary["message"] {
  return {
    length: message.length,
    preview: message.slice(0, MESSAGE_PREVIEW_LIMIT),
  };
}

export function createProviderSummary(input: {
  readonly providerType: string;
  readonly model: string;
  readonly baseUrl?: string;
}): ChatProviderSummary {
  return {
    providerType: input.providerType,
    model: input.model,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
  };
}

export function summarizeProviderSnapshot(snapshot: ProviderConfigSnapshot): ChatDiagnosticSummary["config"] {
  return {
    configured: snapshot.configured,
    source: snapshot.source.effective,
    autoDetected: snapshot.source.autoDetected,
  };
}

export function classifyProviderError(input: {
  readonly message: string;
  readonly statusCode?: number;
}): ProviderErrorDiagnostic["category"] {
  if (input.statusCode === 401 || input.statusCode === 403) {
    return "auth";
  }
  if (input.statusCode === 429) {
    return "rate_limit";
  }
  if (input.statusCode !== undefined && input.statusCode >= 500) {
    return "server";
  }

  const normalized = input.message.toLowerCase();
  if (normalized.includes("network") || normalized.includes("fetch") || normalized.includes("timeout")) {
    return "network";
  }
  if (input.statusCode !== undefined && input.statusCode >= 400) {
    return "client";
  }
  return "unknown";
}

export function isRetriableProviderError(input: {
  readonly statusCode?: number;
  readonly category: ProviderErrorDiagnostic["category"];
}): boolean {
  if (input.category === "rate_limit" || input.category === "server" || input.category === "network") {
    return true;
  }
  return false;
}

export function extractStatusCode(message: string): number | undefined {
  const match = /\((\d{3})\)/.exec(message);
  const digits = match?.[1];
  if (digits === undefined) {
    return undefined;
  }
  return Number.parseInt(digits, 10);
}

export function createProviderErrorDiagnostic(input: {
  readonly providerType: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly message: string;
  readonly statusCode?: number;
}): ProviderErrorDiagnostic {
  const category = classifyProviderError({
    message: input.message,
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
  });
  const retriable = isRetriableProviderError({
    category,
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
  });
  return {
    providerType: input.providerType,
    model: input.model,
    baseUrl: input.baseUrl,
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    category,
    retriable,
    message: input.message,
  };
}
