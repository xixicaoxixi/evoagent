export type ModuleRetentionDecision = "retain_for_tests" | "retain_as_extension" | "retain_in_mainline" | "consolidate_shared_bootstrap";

export interface ModuleRetentionEntry {
  readonly module: string;
  readonly decision: ModuleRetentionDecision;
  readonly rationale: string;
  readonly rollbackBoundary: string;
  readonly actions: readonly string[];
}

const MODULE_RETENTION_ENTRIES = [
  {
    module: "plugins",
    decision: "retain_for_tests",
    rationale: "插件/Hook/Skill 体系当前仍被多组专项测试覆盖，但主闭环未装配；直接删除会破坏测试接入路径，也会丢失后续扩展位。",
    rollbackBoundary: "保持现有导出面与测试文件不变，仅在台账与治理产物中标记为 test_only，不接入主链。",
    actions: [
      "保留 src/plugins 命名空间与现有测试入口",
      "不将 createPluginLoader/createHookEngine/createHookInstaller/createSkillScanner 强行接入主闭环",
      "后续仅在出现真实产品需求时再设计主链接入方案",
    ],
  },
  {
    module: "sandbox",
    decision: "retain_as_extension",
    rationale: "SubprocessSandbox 与相关安全校验实现具备扩展价值，但当前主链未实例化；贸然接入会扩大执行面与风险边界。",
    rollbackBoundary: "保留 src/sandbox 导出与实现，不改变当前工具执行路径。",
    actions: [
      "保留 sandbox 作为扩展点",
      "不修改当前 bash/file 工具执行链去依赖 sandbox",
      "通过治理产物明确其 extension_only 状态",
    ],
  },
  {
    module: "knowledge",
    decision: "retain_in_mainline",
    rationale: "知识模块已存在局部主链接入：HTTP 路由使用内存知识库，主对话链使用 memory-extractor；当前问题是实现分裂而非应被删除。",
    rollbackBoundary: "保留 memory-extractor 与 knowledge routes 的现有行为，仅收敛共享内存知识库工厂。",
    actions: [
      "保留 memory-extractor 的主链角色",
      "保留 knowledge routes 的 HTTP 能力",
      "收敛 createMemoryKnowledgeStore 为共享工厂，避免重复内存知识库实现继续分叉",
    ],
  },
  {
    module: "provider_bootstrap",
    decision: "consolidate_shared_bootstrap",
    rationale: "CLI、库入口与 MCP 入口重复执行 loadDotEnv + detectProviders + applyAutoDetectedProvider，属于主链重复装配逻辑，应收敛为共享 bootstrap。",
    rollbackBoundary: "仅提取共享启动函数，保持各入口原有 sourceDetail 与行为语义不变。",
    actions: [
      "新增共享 provider bootstrap 函数",
      "让 src/index.ts、src/cli.ts、src/mcp-entry.ts 复用同一自动检测装配逻辑",
      "通过测试锁定 sourceDetail 与无 provider 时的降级行为",
    ],
  },
] as const satisfies readonly ModuleRetentionEntry[];

export function getModuleRetentionEntries(): readonly ModuleRetentionEntry[] {
  return MODULE_RETENTION_ENTRIES;
}
