/**
 * 插件模块统一导出。
 */

// 事件系统
export {
  createEventEmitter,
  type EventEmitter,
  type EventHandler,
  type HandlerEntry,
  type BaseEvent,
  type ActionEvent,
  type EventEmitResult,
  type EventEmitError,
  type EventHandlerOptions,
} from "./event-emitter";

// 系统事件
export {
  createAgentEvent,
  createToolEvent,
  createEvolutionEvent,
  createPluginEvent,
  createSessionEvent,
  createConfigEvent,
  createHookEvent,
  type SystemEvent,
  type AgentEvent,
  type ToolEvent,
  type EvolutionEvent,
  type PluginEvent,
  type SessionEvent,
  type ConfigEvent,
  type HookEvent,
  type SystemEventType,
} from "./events";

// Plugin SDK
export {
  definePluginEntry,
  validatePluginContract,
  PluginContractSchema,
  type PluginDefinitionInput,
  type PluginHookInput,
  type PluginContract,
  type PluginValidationResult,
} from "./sdk";

// Plugin Registry
export {
  createPluginRegistryImpl,
  type PluginRegistration,
  type PluginState,
  type PluginRegistryConfig,
  type PluginRegistryExtended,
} from "./registry";

// Hook Registry
export {
  createHookRegistry,
  HOOK_SOURCE_POLICIES,
  type HookDefinition,
  type HookRegistry,
  type HookSource,
  type HookSourcePolicy,
} from "./hooks/registry";

// Hook Engine
export {
  createHookEngine,
  type HookEngine,
  type HookEngineConfig,
  type HookExecutionResult,
  type HookResultEntry,
} from "./hooks/engine";

// Skill Definition
export {
  parseFrontmatter,
  matchPathPattern,
  activateConditionalSkills,
  SkillFrontmatterSchema,
  type SkillDefinition,
  type SkillFrontmatter,
  type SkillSource,
  type SkillActivationResult,
  type SkillParseResult,
} from "./skills/definition";

// Skill Security
export {
  validateSkillFilePath,
  safeWriteFile,
  createNonceDir,
  cleanupDir,
  type SafeWriteResult,
} from "./skills/security";

// Plugin Loader (F.1)
export {
  createPluginLoader,
  type PluginSource,
  type PluginLifecycleState,
  type PluginManifest,
  type PluginLoadResult,
  type PluginLoaderConfig,
  type PluginLoader,
} from "./loader";

// Skill Scanner (F.1)
export {
  createSkillScanner,
  type ScannedSkill,
  type SkillScannerConfig,
  type SkillScanner,
} from "./skills/scanner";

// Hook Installer (F.2)
export {
  createHookInstaller,
  type InstallSource,
  type HookInstallResult,
  type HookInstallOptions,
  type HookInstaller,
} from "./hooks/installer";

// Stream Wrapper Chain (F.2)
export {
  composeStreamWrappers,
  createLoggingWrapper,
  createRetryWrapper,
  createMemoizeWrapper,
  createTimingWrapper,
  type StreamWrapper,
  type StreamWrapperConfig,
} from "./stream-wrapper";
