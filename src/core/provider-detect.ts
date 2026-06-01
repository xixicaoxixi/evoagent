import { getProviderDefaults, getDetectableProviders, PROVIDER_METADATA } from "../types/provider-defaults";

export interface DetectedProvider {
  readonly type: string;
  readonly key: string;
  readonly model: string;
  readonly baseUrl: string;
}

const DEFAULT_PRIORITY: ReadonlyArray<string> = getDetectableProviders().map((m) => m.type);

const PLACEHOLDER_PATTERNS: ReadonlyArray<RegExp> = [
  /^your[_-]/i,
  /_here$/i,
  /^(xxx+|placeholder|example|test|change\.me|insert)/i,
];

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pat) => pat.test(value));
}

function parsePriority(): ReadonlyArray<string> {
  const envPriority = process.env.PROVIDER_PRIORITY?.trim();
  if (!envPriority) return DEFAULT_PRIORITY;

  const parsed = envPriority
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (parsed.length === 0) return DEFAULT_PRIORITY;

  const detectableTypes = new Set(getDetectableProviders().map((m) => m.type));
  const filtered = parsed.filter((p) => detectableTypes.has(p));
  return filtered.length > 0 ? filtered : DEFAULT_PRIORITY;
}

export function loadDotEnv(): void {
  try {
    const cwd = process.cwd();
    const envPath = `${cwd}/.env`;
    const fs = require("fs") as typeof import("fs");
    if (!fs.existsSync(envPath)) return;

    const text = fs.readFileSync(envPath, "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    console.warn(`[DOTENV] Failed to load .env file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function detectProviders(): ReadonlyArray<DetectedProvider> {
  const priority = parsePriority();
  const detected: DetectedProvider[] = [];

  for (const type of priority) {
    const metadata = PROVIDER_METADATA[type];
    if (!metadata?.detectable || !metadata.envKey || !metadata.envModel) {
      continue;
    }

    const key = process.env[metadata.envKey];
    if (!key || isPlaceholder(key)) continue;

    const defaults = getProviderDefaults(type);
    const model = process.env[metadata.envModel]?.trim() || defaults.model || "";
    const baseUrl = defaults.baseUrl || "";

    if (!model) {
      continue;
    }

    detected.push({ type, key, model, baseUrl });
  }

  return detected;
}

export function detectPrimaryProvider(): DetectedProvider | null {
  const providers = detectProviders();
  return providers.length > 0 ? providers[0]! : null;
}
