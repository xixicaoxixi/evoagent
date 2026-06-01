import { createProviderConfigStore, type ProviderConfigSnapshot } from "./core/provider-config";
import { bootstrapAutoDetectedProvider } from "./core/provider-bootstrap";
export { getModuleLedgerEntries, getModuleLedgerSnapshot } from "./module-ledger";
export type { ModuleLedgerEntry, ModuleLedgerSnapshot, ModuleLedgerStatus } from "./module-ledger";
export { getModuleRetentionEntries } from "./module-retention";
export type { ModuleRetentionDecision, ModuleRetentionEntry } from "./module-retention";

export interface EvoAgent {
  chat(message: string): Promise<string>;
  chatComplex(message: string, subTasks?: string[]): Promise<string>;
  getProviderSnapshot(): ProviderConfigSnapshot;
}

export async function createEvoAgent(): Promise<EvoAgent> {
  const configStore = createProviderConfigStore();
  await bootstrapAutoDetectedProvider(configStore, {
    sourceDetail: "Auto-detected from environment variables during library initialization.",
  });

  const ctx = configStore.getContext();
  if (!ctx) {
    throw new Error("No provider detected. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, OLLAMA_BASE_URL, DEEPSEEK_API_KEY, KIMI_API_KEY, or GLM_API_KEY.");
  }

  return {
    async chat(message: string): Promise<string> {
      const result = await ctx.chat(message);
      return result.response;
    },
    async chatComplex(message: string, subTasks: string[] = []): Promise<string> {
      const result = await ctx.chatComplex(message, subTasks);
      return result.response;
    },
    getProviderSnapshot(): ProviderConfigSnapshot {
      return configStore.getSnapshot();
    },
  };
}
