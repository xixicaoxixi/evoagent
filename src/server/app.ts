import { createServer, type EvoAgentServer } from "../server";
import { createProviderConfigStore } from "../core/provider-config";
import { bootstrapAutoDetectedProvider } from "../core/provider-bootstrap";
import { registerConfigRoutes } from "./routes/config";
import { registerChatRoutes } from "./routes/chat";
import { createMemoryTaskStore, registerTaskRoutes } from "./routes/tasks";
import { createKnowledgeRouteDeps, registerKnowledgeRoutes } from "./routes/knowledge";
import { registerEvolutionRoutes } from "./routes/evolution";
import { registerCommunicationRoutes } from "./routes/communication";
import { registerCommunityRoutes } from "./routes/community";
import { registerAnalyticsRoutes } from "./routes/analytics";
import { registerHealthRoutes } from "./routes/health";

export interface ServerAppOptions {
  readonly port: number;
  readonly hostname: string;
  readonly prefix: string;
  readonly providerType?: string;
}

export function createServerApp(options: ServerAppOptions): EvoAgentServer {
  const server = createServer({
    port: options.port,
    hostname: options.hostname,
    prefix: options.prefix,
  });
  const configStore = createProviderConfigStore();
  void bootstrapAutoDetectedProvider(configStore, {
    sourceDetail: "Auto-detected from environment variables during HTTP server startup.",
    ...(options.providerType !== undefined ? { providerType: options.providerType } : {}),
  });
  const getContext = () => configStore.getContext();

  const serverStartTime = Date.now();

  for (const route of registerHealthRoutes({ getContext, startTime: serverStartTime })) {
    server.registerRoute(route);
  }
  for (const route of registerConfigRoutes({ configStore })) {
    server.registerRoute(route);
  }
  for (const route of registerChatRoutes({
    getContext: () => getContext() ?? null,
    getEngine: () => {
      const context = getContext();
      return context ? context.getEngine() : null;
    },
    createEngine: async () => {
      throw new Error("Dynamic engine creation is not supported in the HTTP server route layer");
    },
  })) {
    server.registerRoute(route);
  }
  for (const route of registerTaskRoutes({ store: createMemoryTaskStore(), getContext })) {
    server.registerRoute(route);
  }
  for (const route of registerKnowledgeRoutes(createKnowledgeRouteDeps(getContext))) {
    server.registerRoute(route);
  }
  for (const route of registerEvolutionRoutes({ getContext })) {
    server.registerRoute(route);
  }
  for (const route of registerCommunicationRoutes({ getContext })) {
    server.registerRoute(route);
  }
  for (const route of registerCommunityRoutes({ getContext })) {
    server.registerRoute(route);
  }
  for (const route of registerAnalyticsRoutes({ getContext })) {
    server.registerRoute(route);
  }

  return server;
}
