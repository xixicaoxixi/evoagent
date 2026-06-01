export type ModuleLedgerStatus = "mainline_integrated" | "partially_integrated" | "test_only" | "extension_only" | "likely_isolated";

export interface ModuleLedgerEvidence {
  readonly entrypoints: readonly string[];
  readonly callers: readonly string[];
  readonly tests: readonly string[];
  readonly docs: readonly string[];
  readonly runtimeObservability: readonly string[];
}

export interface ModuleLedgerEntry {
  readonly module: string;
  readonly status: ModuleLedgerStatus;
  readonly summary: string;
  readonly evidence: ModuleLedgerEvidence;
}

export interface ModuleLedgerSnapshot {
  readonly generatedAt: string;
  readonly entries: readonly ModuleLedgerEntry[];
}

const MODULE_LEDGER_ENTRIES = [
  {
    module: "plugins",
    status: "test_only",
    summary: "插件/Hook/Skill 体系当前主要通过命名空间导出与专项测试验证，主闭环装配链未见 createPluginLoader、createHookEngine、createHookInstaller 或 createSkillScanner 的真实接入。",
    evidence: {
      entrypoints: [
        "src/plugins/index.ts",
        "src/plugins/loader.ts",
        "src/plugins/hooks/engine.ts",
        "src/plugins/hooks/installer.ts",
        "src/plugins/skills/scanner.ts",
      ],
      callers: [
        "未发现 src/index.ts、src/cli.ts、src/mcp-entry.ts、src/integration/context.ts、src/server.ts 对插件装配器的主链调用",
      ],
      tests: [
        "tests/plugins/namespace.test.ts",
        "tests/plugins/session6-2.test.ts",
        "tests/plugins/session6-3.test.ts",
        "tests/plugins/session6-integration.test.ts",
        "tests/fix/session-f-integration.test.ts",
      ],
      docs: [
        ".trae/specs/repair-mainline-closure/spec.md#Task-7",
      ],
      runtimeObservability: [
        "无独立 HTTP/MCP 状态端点暴露插件装配状态",
      ],
    },
  },
  {
    module: "knowledge",
    status: "partially_integrated",
    summary: "知识模块存在两条链路：HTTP 路由使用 createMemoryKnowledgeStore 的内存知识库；主对话链仅接入 memory-extractor 做记忆抽取，vector-store、dreaming、forgetting 等未进入主闭环。",
    evidence: {
      entrypoints: [
        "src/server/routes/knowledge.ts",
        "src/knowledge/memory-extractor.ts",
        "src/knowledge/vector-store.ts",
      ],
      callers: [
        "src/integration/context.ts -> createMemoryExtractor()",
        "src/server/routes/knowledge.ts -> registerKnowledgeRoutes()",
      ],
      tests: [
        "tests/server/routes.test.ts",
      ],
      docs: [
        ".trae/specs/repair-mainline-closure/spec.md#Task-7",
      ],
      runtimeObservability: [
        "HTTP /knowledge、/knowledge/search、/knowledge/memory 提供局部运行时观测",
      ],
    },
  },
  {
    module: "sandbox",
    status: "extension_only",
    summary: "沙箱模块提供 SubprocessSandbox 与 Docker 安全校验实现，但当前主链工具执行与上下文装配未实例化该后端，仅保留为扩展能力。",
    evidence: {
      entrypoints: [
        "src/sandbox/index.ts",
        "src/sandbox/subprocess.ts",
      ],
      callers: [
        "未发现主链对 SubprocessSandbox 的实例化调用",
      ],
      tests: [
        "未发现独立 sandbox 测试文件",
      ],
      docs: [
        ".trae/specs/repair-mainline-closure/spec.md#Task-7",
      ],
      runtimeObservability: [
        "无 HTTP/MCP/CLI 状态输出引用 sandbox 后端",
      ],
    },
  },
  {
    module: "communication",
    status: "mainline_integrated",
    summary: "通信层在 EvoAgentContext 中被真实装配，HTTP 路由与 MCP community_status 工具均直接读取 Gateway、Community、Marketplace、Analytics 等状态。",
    evidence: {
      entrypoints: [
        "src/communication/index.ts",
        "src/server/routes/communication.ts",
        "src/server/routes/community.ts",
        "src/server/routes/marketplace.ts",
      ],
      callers: [
        "src/integration/context.ts -> createGateway/createCommunity/createMarketplace/createAnalytics",
        "src/mcp-entry.ts -> registerCommunicationTools()",
        "src/server/routes/communication.ts -> ctx.getGateway()",
        "src/server/routes/community.ts -> ctx.getCommunity()",
        "src/server/routes/marketplace.ts -> ctx.getMarketplace()",
      ],
      tests: [
        "tests/server/routes.test.ts",
      ],
      docs: [
        "README.md",
        ".trae/specs/repair-mainline-closure/spec.md#Task-7",
      ],
      runtimeObservability: [
        "HTTP /net/*、/community/*、/market/*",
        "MCP community_status",
        "Provider status snapshot 中包含 community/analytics 侧数据",
      ],
    },
  },
  {
    module: "evolution",
    status: "mainline_integrated",
    summary: "进化引擎与规则存储在上下文初始化时装配，并在 chat/chatComplex 完成后回调；HTTP evolution 路由、MCP evolution_status 与 provider status 均可观测其状态。",
    evidence: {
      entrypoints: [
        "src/evolution/index.ts",
        "src/evolution/engine.ts",
        "src/evolution/rule-store.ts",
        "src/server/routes/evolution.ts",
      ],
      callers: [
        "src/integration/context.ts -> createEvolutionEngine/createJSONLRuleStore",
        "src/integration/context.ts -> evolutionEngine.onTaskCompleted()",
        "src/mcp-entry.ts -> registerEvolutionTools()",
        "src/core/provider-config.ts -> runtimeBinding.context.getEvolutionEngine()",
      ],
      tests: [
        "tests/server/routes.test.ts",
      ],
      docs: [
        "README.md",
        ".trae/specs/repair-mainline-closure/spec.md#Task-7",
      ],
      runtimeObservability: [
        "HTTP /evolution、/evolution/stats、/evolution/ema、/evolution/budget",
        "MCP evolution_status",
        "Provider status snapshot.evolution",
      ],
    },
  },
  {
    module: "observability",
    status: "mainline_integrated",
    summary: "日志、统计、成本、进度与 PII 净化在上下文、Query Loop、Provider 状态与 MCP/HTTP 观测接口中均有真实接入。",
    evidence: {
      entrypoints: [
        "src/observability/index.ts",
        "src/observability/logger.ts",
        "src/observability/cost-tracker.ts",
        "src/observability/progress.ts",
      ],
      callers: [
        "src/integration/context.ts -> createLogger/createStatsStore/createCostTracker/createProgressTracker",
        "src/core/query/loop.ts -> createPIISanitizer()",
        "src/mcp-entry.ts -> registerObservabilityTools()",
        "src/core/provider-config.ts -> runtimeBinding.context.getCostTracker()/getProgress()",
        "src/server/routes/analytics.ts",
      ],
      tests: [
        "tests/security/module-wiring.test.ts",
        "tests/server/routes.test.ts",
      ],
      docs: [
        "README.md",
        ".trae/specs/repair-mainline-closure/spec.md#Task-7",
      ],
      runtimeObservability: [
        "HTTP /analytics/*",
        "MCP observability_status",
        "Provider status snapshot.observability",
      ],
    },
  },
  {
    module: "mcp",
    status: "mainline_integrated",
    summary: "MCP 服务端、客户端、传输层与 SSE/stdio 入口已进入主闭环，createMCPEntry 负责真实启动、工具注册与协议端点暴露。",
    evidence: {
      entrypoints: [
        "src/mcp/index.ts",
        "src/mcp/server.ts",
        "src/mcp/client.ts",
        "src/mcp/transport.ts",
        "src/mcp-entry.ts",
      ],
      callers: [
        "src/cli.ts -> createMCPEntry()",
        "src/mcp-entry.ts -> createMCPServer()/registerBuiltinTools()/registerChatTools()",
      ],
      tests: [
        "tests/mcp-entry.test.ts",
        "tests/mcp/entry-contract.test.ts",
      ],
      docs: [
        "README.md",
        ".trae/specs/repair-mainline-closure/spec.md#Task-7",
      ],
      runtimeObservability: [
        "MCP /health、/sse、/message",
        "MCP tools/list 与 getState()",
      ],
    },
  },
  {
    module: "server",
    status: "mainline_integrated",
    summary: "HTTP Server、Web UI 与多组业务路由已由 CLI server 命令真实启动，构成主闭环对外 API 面。",
    evidence: {
      entrypoints: [
        "src/server.ts",
        "src/server/web-ui.ts",
        "src/server/routes/tasks.ts",
        "src/server/routes/knowledge.ts",
        "src/server/routes/evolution.ts",
        "src/server/routes/communication.ts",
        "src/server/routes/community.ts",
        "src/server/routes/marketplace.ts",
        "src/server/routes/analytics.ts",
        "src/server/routes/config.ts",
      ],
      callers: [
        "src/cli.ts -> createServer().start()",
        "src/server.ts -> getWebUIHtml()",
      ],
      tests: [
        "tests/server/routes.test.ts",
        "tests/cli.test.ts",
      ],
      docs: [
        "README.md",
        ".trae/specs/repair-mainline-closure/spec.md#Task-7",
      ],
      runtimeObservability: [
        "HTTP /api/v1/* 与根路径 Web UI",
      ],
    },
  },
] as const satisfies readonly ModuleLedgerEntry[];

export function getModuleLedgerEntries(): readonly ModuleLedgerEntry[] {
  return MODULE_LEDGER_ENTRIES;
}

export function getModuleLedgerSnapshot(now: Date = new Date()): ModuleLedgerSnapshot {
  return {
    generatedAt: now.toISOString(),
    entries: MODULE_LEDGER_ENTRIES,
  };
}
