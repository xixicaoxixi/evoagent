# 代码片段参考文档 — Agent 运行时与编排补充

> 本文档是《Agent 核心循环与编排》的补充，收录了 openclaw 项目中 AgentHarness 运行时后端（类型系统、注册表、选择策略、会话串行化队列）以及 claude-code 项目中进度追踪相关的关键代码片段。
> 来源项目：openclaw（OpenClaw Agent Runtime）、claude-code（Anthropic Claude Code CLI）

---

## 使用指南

本文档按功能模块组织，涵盖以下核心领域：

1. **AgentHarness 类型系统** — 核心类型定义：支持检测、运行参数/结果、压缩参数/结果、重置参数、harness 接口
2. **AgentHarness 注册表** — 基于 globalThis Symbol 的全局单例注册表，提供注册、查询、列举、重置和销毁功能
3. **AgentHarness 选择策略** — 根据 provider/model 配置从注册表中按优先级选择最合适的 harness，支持自动选择、强制指定和 PI 回退
4. **SessionActorQueue 串行化队列** — 基于键的异步队列，确保同一会话操作按序执行，不同会话可并行
5. **ProgressTracker 进度追踪器** — Agent 任务进度追踪，跟踪工具使用次数、token 消耗和最近活动列表

**快速检索方式**：
- 通过总览表格按编号/名称定位片段
- 通过源文件路径在 IDE 中跳转到原始代码
- 按功能关键词（如 "AgentHarness"、"SessionActorQueue"、"ProgressTracker"）搜索

---

## 总览表格

| 编号 | 片段名称 | 来源项目 | 源文件路径 |
|------|----------|----------|------------|
| 1 | `AgentHarness` 接口定义 | openclaw | `src/agents/harness/types.ts` (L1-44) |
| 2 | `AgentHarness` 注册表 | openclaw | `src/agents/harness/registry.ts` (L1-100) |
| 3 | `selectAgentHarness()` — Harness 选择策略 | openclaw | `src/agents/harness/selection.ts` (L1-206) |
| 4 | `SessionActorQueue` 串行化队列 | openclaw | `src/acp/control-plane/session-actor-queue.ts` (L1-38) |
| 5 | `ProgressTracker` 进度追踪器 | claude-code | `src/tasks/LocalAgentTask/LocalAgentTask.tsx` (L23-115) |

**片段总数**: 5

---

# Agent 运行时与编排补充 — 关键代码片段提取

---

## 第八组：AgentHarness 运行时后端（openclaw）

---

### 1. `AgentHarness` 接口定义

**来源文件**: `/workspace/openclaw/src/agents/harness/types.ts`
**行号范围**: 第 1–44 行

**说明**: 定义 AgentHarness 的核心类型系统，包括支持检测上下文、运行参数/结果、压缩参数/结果、重置参数以及 harness 本身的接口。`AgentHarness` 接口是运行时后端的抽象层，通过 `supports()` 方法实现能力协商，`runAttempt()` 执行 Agent 运行尝试，`compact()` 可选地压缩会话，`reset()` 可选地重置会话状态，`dispose()` 可选地释放资源。

```typescript
import type { CompactEmbeddedPiSessionParams } from "../pi-embedded-runner/compact.types.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../pi-embedded-runner/run/types.js";
import type { EmbeddedAgentRuntime } from "../pi-embedded-runner/runtime.js";
import type { EmbeddedPiCompactResult } from "../pi-embedded-runner/types.js";

export type AgentHarnessSupportContext = {
  provider: string;
  modelId?: string;
  requestedRuntime: EmbeddedAgentRuntime;
};

export type AgentHarnessSupport =
  | { supported: true; priority?: number; reason?: string }
  | { supported: false; reason?: string };

export type AgentHarnessAttemptParams = EmbeddedRunAttemptParams;
export type AgentHarnessAttemptResult = EmbeddedRunAttemptResult;
export type AgentHarnessCompactParams = CompactEmbeddedPiSessionParams;
export type AgentHarnessCompactResult = EmbeddedPiCompactResult;
export type AgentHarnessResetParams = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  reason?: "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "unknown";
};

export type AgentHarness = {
  id: string;
  label: string;
  pluginId?: string;
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
  runAttempt(params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult>;
  compact?(params: AgentHarnessCompactParams): Promise<AgentHarnessCompactResult | undefined>;
  reset?(params: AgentHarnessResetParams): Promise<void> | void;
  dispose?(): Promise<void> | void;
};

export type RegisteredAgentHarness = {
  harness: AgentHarness;
  ownerPluginId?: string;
};
```

---

### 2. `AgentHarness` 注册表

**来源文件**: `/workspace/openclaw/src/agents/harness/registry.ts`
**行号范围**: 第 1–100 行

**说明**: 基于 globalThis Symbol 的全局单例注册表，提供 AgentHarness 的注册、查询、列举、重置和销毁功能。使用 `Symbol.for()` 确保跨模块/跨 realm 的唯一标识。核心 API 包括：

- `registerAgentHarness()` — 注册新 harness，自动 trim id 并合并 pluginId
- `getAgentHarness()` / `getRegisteredAgentHarness()` — 按 id 查询
- `listAgentHarnessIds()` / `listRegisteredAgentHarnesses()` — 枚举所有已注册 harness
- `clearAgentHarnesses()` / `restoreRegisteredAgentHarnesses()` — 清空/恢复（用于测试或热重载）
- `resetRegisteredAgentHarnessSessions()` — 批量重置所有 harness 的会话（错误隔离：单个 harness 失败不影响其他）
- `disposeRegisteredAgentHarnesses()` — 批量销毁所有 harness（同样错误隔离）

```typescript
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AgentHarness, AgentHarnessResetParams, RegisteredAgentHarness } from "./types.js";

const AGENT_HARNESS_REGISTRY_STATE = Symbol.for("openclaw.agentHarnessRegistryState");
const log = createSubsystemLogger("agents/harness");

type AgentHarnessRegistryState = {
  harnesses: Map<string, RegisteredAgentHarness>;
};

function getAgentHarnessRegistryState(): AgentHarnessRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [AGENT_HARNESS_REGISTRY_STATE]?: AgentHarnessRegistryState;
  };
  globalState[AGENT_HARNESS_REGISTRY_STATE] ??= {
    harnesses: new Map<string, RegisteredAgentHarness>(),
  };
  return globalState[AGENT_HARNESS_REGISTRY_STATE];
}

export function registerAgentHarness(
  harness: AgentHarness,
  options?: { ownerPluginId?: string },
): void {
  const id = harness.id.trim();
  getAgentHarnessRegistryState().harnesses.set(id, {
    harness: {
      ...harness,
      id,
      pluginId: harness.pluginId ?? options?.ownerPluginId,
    },
    ownerPluginId: options?.ownerPluginId,
  });
}

export function getAgentHarness(id: string): AgentHarness | undefined {
  return getRegisteredAgentHarness(id)?.harness;
}

export function getRegisteredAgentHarness(id: string): RegisteredAgentHarness | undefined {
  return getAgentHarnessRegistryState().harnesses.get(id.trim());
}

export function listAgentHarnessIds(): string[] {
  return [...getAgentHarnessRegistryState().harnesses.keys()];
}

export function listRegisteredAgentHarnesses(): RegisteredAgentHarness[] {
  return Array.from(getAgentHarnessRegistryState().harnesses.values());
}

export function clearAgentHarnesses(): void {
  getAgentHarnessRegistryState().harnesses.clear();
}

export function restoreRegisteredAgentHarnesses(entries: RegisteredAgentHarness[]): void {
  const map = getAgentHarnessRegistryState().harnesses;
  map.clear();
  for (const entry of entries) {
    map.set(entry.harness.id, entry);
  }
}

export async function resetRegisteredAgentHarnessSessions(
  params: AgentHarnessResetParams,
): Promise<void> {
  await Promise.all(
    listRegisteredAgentHarnesses().map(async (entry) => {
      if (!entry.harness.reset) { return; }
      try {
        await entry.harness.reset(params);
      } catch (error) {
        log.warn(`${entry.harness.label} session reset hook failed`, {
          harnessId: entry.harness.id, error,
        });
      }
    }),
  );
}

export async function disposeRegisteredAgentHarnesses(): Promise<void> {
  await Promise.all(
    listRegisteredAgentHarnesses().map(async (entry) => {
      if (!entry.harness.dispose) { return; }
      try {
        await entry.harness.dispose();
      } catch (error) {
        log.warn(`${entry.harness.label} dispose hook failed`, {
          harnessId: entry.harness.id, error,
        });
      }
    }),
  );
}
```

---

### 3. `selectAgentHarness()` — Harness 选择策略

**来源文件**: `/workspace/openclaw/src/agents/harness/selection.ts`
**行号范围**: 第 1–206 行

**说明**: 根据 provider/model 配置从注册表中按优先级选择最合适的 AgentHarness，支持自动选择、强制指定和 PI 回退。文件包含以下核心函数：

- **`selectAgentHarness()`** (L45-106): 主选择函数。根据 `runtime` 策略分三条路径：(1) PI 强制路径直接返回内置 PI harness；(2) 强制指定路径在插件 harness 中查找匹配项，找不到时根据 `fallback` 策略决定是抛错还是回退到 PI；(3) 自动选择路径遍历所有插件 harness，调用 `supports()` 检查支持性，按 `priority` 降序排列后选择最优匹配。
- **`runAgentHarnessAttemptWithFallback()`** (L108-138): 运行 harness 尝试并在失败时回退到 PI 后端。
- **`maybeCompactAgentHarnessSession()`** (L140-153): 条件性地压缩 Agent 会话。
- **`resolveAgentHarnessPolicy()`** (L155-180): 从环境变量、Agent 配置和全局默认值解析运行时策略和兜底策略。

辅助函数包括 `compareHarnessSupport()`（按优先级排序）、`listPluginAgentHarnesses()`（提取插件 harness 列表）、`normalizeAgentHarnessFallback()`（规范化兜底值）和 `formatProviderModel()`（格式化 provider/model 字符串）。

```typescript
import type { OpenClawConfig } from "../../config/config.js";
import type { AgentEmbeddedHarnessConfig } from "../../config/types.agents-shared.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { listAgentEntries, resolveSessionAgentIds } from "../agent-scope.js";
import type { CompactEmbeddedPiSessionParams } from "../pi-embedded-runner/compact.types.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../pi-embedded-runner/run/types.js";
import {
  normalizeEmbeddedAgentRuntime,
  resolveEmbeddedAgentHarnessFallback,
  resolveEmbeddedAgentRuntime,
  type EmbeddedAgentHarnessFallback,
  type EmbeddedAgentRuntime,
} from "../pi-embedded-runner/runtime.js";
import type { EmbeddedPiCompactResult } from "../pi-embedded-runner/types.js";
import { createPiAgentHarness } from "./builtin-pi.js";
import { listRegisteredAgentHarnesses } from "./registry.js";
import type { AgentHarness, AgentHarnessSupport } from "./types.js";

const log = createSubsystemLogger("agents/harness");

type AgentHarnessPolicy = {
  runtime: EmbeddedAgentRuntime;
  fallback: EmbeddedAgentHarnessFallback;
};

function listPluginAgentHarnesses(): AgentHarness[] {
  return listRegisteredAgentHarnesses().map((entry) => entry.harness);
}

function compareHarnessSupport(
  left: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
  right: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
): number {
  const priorityDelta = (right.support.priority ?? 0) - (left.support.priority ?? 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return left.harness.id.localeCompare(right.harness.id);
}

export function selectAgentHarness(params: {
  provider: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): AgentHarness {
  const policy = resolveAgentHarnessPolicy(params);
  // PI is intentionally not part of the plugin candidate list. It is the legacy
  // fallback path, so `fallback: "none"` can prove that only plugin harnesses run.
  const pluginHarnesses = listPluginAgentHarnesses();
  const piHarness = createPiAgentHarness();
  const runtime = policy.runtime;
  if (runtime === "pi") {
    return piHarness;
  }
  if (runtime !== "auto") {
    const forced = pluginHarnesses.find((entry) => entry.id === runtime);
    if (forced) {
      return forced;
    }
    if (policy.fallback === "none") {
      throw new Error(
        `Requested agent harness "${runtime}" is not registered and PI fallback is disabled.`,
      );
    }
    log.warn("requested agent harness is not registered; falling back to embedded PI backend", {
      requestedRuntime: runtime,
    });
    return piHarness;
  }

  const supported = pluginHarnesses
    .map((harness) => ({
      harness,
      support: harness.supports({
        provider: params.provider,
        modelId: params.modelId,
        requestedRuntime: runtime,
      }),
    }))
    .filter(
      (
        entry,
      ): entry is {
        harness: AgentHarness;
        support: AgentHarnessSupport & { supported: true };
      } => entry.support.supported,
    )
    .toSorted(compareHarnessSupport);

  const selected = supported[0]?.harness;
  if (selected) {
    return selected;
  }
  if (policy.fallback === "none") {
    throw new Error(
      `No registered agent harness supports ${formatProviderModel(params)} and PI fallback is disabled.`,
    );
  }
  return piHarness;
}

export async function runAgentHarnessAttemptWithFallback(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const policy = resolveAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const harness = selectAgentHarness({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (harness.id === "pi") {
    return harness.runAttempt(params);
  }

  try {
    return await harness.runAttempt(params);
  } catch (error) {
    if (policy.runtime !== "auto" || policy.fallback === "none") {
      throw error;
    }
    log.warn(`${harness.label} failed; falling back to embedded PI backend`, { error });
    return createPiAgentHarness().runAttempt(params);
  }
}

export async function maybeCompactAgentHarnessSession(
  params: CompactEmbeddedPiSessionParams,
): Promise<EmbeddedPiCompactResult | undefined> {
  const harness = selectAgentHarness({
    provider: params.provider ?? "",
    modelId: params.model,
    config: params.config,
    sessionKey: params.sessionKey,
  });
  if (!harness.compact) {
    return undefined;
  }
  return harness.compact(params);
}

export function resolveAgentHarnessPolicy(params: {
  provider?: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
}): AgentHarnessPolicy {
  const env = params.env ?? process.env;
  // Harness policy can be session-scoped because users may switch between agents
  // with different strictness requirements inside the same gateway process.
  const agentPolicy = resolveAgentEmbeddedHarnessConfig(params.config, {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const defaultsPolicy = params.config?.agents?.defaults?.embeddedHarness;
  const runtime = env.OPENCLAW_AGENT_RUNTIME?.trim()
    ? resolveEmbeddedAgentRuntime(env)
    : normalizeEmbeddedAgentRuntime(agentPolicy?.runtime ?? defaultsPolicy?.runtime);
  return {
    runtime,
    fallback:
      resolveEmbeddedAgentHarnessFallback(env) ??
      normalizeAgentHarnessFallback(agentPolicy?.fallback ?? defaultsPolicy?.fallback),
  };
}

function resolveAgentEmbeddedHarnessConfig(
  config: OpenClawConfig | undefined,
  params: { agentId?: string; sessionKey?: string },
): AgentEmbeddedHarnessConfig | undefined {
  if (!config) {
    return undefined;
  }
  const { sessionAgentId } = resolveSessionAgentIds({
    config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  return listAgentEntries(config).find((entry) => normalizeAgentId(entry.id) === sessionAgentId)
    ?.embeddedHarness;
}

function normalizeAgentHarnessFallback(
  value: AgentEmbeddedHarnessConfig["fallback"] | undefined,
): EmbeddedAgentHarnessFallback {
  return value === "none" ? "none" : "pi";
}

function formatProviderModel(params: { provider: string; modelId?: string }): string {
  return params.modelId ? `${params.provider}/${params.modelId}` : params.provider;
}
```

---

### 4. `SessionActorQueue` 串行化队列

**来源文件**: `/workspace/openclaw/src/acp/control-plane/session-actor-queue.ts`
**行号范围**: 第 1–38 行

**说明**: 基于键的异步队列（`KeyedAsyncQueue`），确保同一会话（`actorKey`）的操作按序执行，不同会话可并行。这是"串行化消竞态"架构模式的典型实现。核心方法 `run<T>(actorKey, op)` 将操作入队，通过 `onEnqueue`/`onSettle` 回调维护每个会话的待处理计数器，提供 `getTotalPendingCount()` 和 `getPendingCountForSession()` 用于监控队列深度。

```typescript
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";

export class SessionActorQueue {
  private readonly queue = new KeyedAsyncQueue();
  private readonly pendingBySession = new Map<string, number>();

  getTailMapForTesting(): Map<string, Promise<void>> {
    return this.queue.getTailMapForTesting();
  }

  getTotalPendingCount(): number {
    let total = 0;
    for (const count of this.pendingBySession.values()) {
      total += count;
    }
    return total;
  }

  getPendingCountForSession(actorKey: string): number {
    return this.pendingBySession.get(actorKey) ?? 0;
  }

  async run<T>(actorKey: string, op: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(actorKey, op, {
      onEnqueue: () => {
        this.pendingBySession.set(actorKey, (this.pendingBySession.get(actorKey) ?? 0) + 1);
      },
      onSettle: () => {
        const pending = (this.pendingBySession.get(actorKey) ?? 1) - 1;
        if (pending <= 0) {
          this.pendingBySession.delete(actorKey);
        } else {
          this.pendingBySession.set(actorKey, pending);
        }
      },
    });
  }
}
```

---

## 第九组：进度追踪（claude-code）

---

### 5. `ProgressTracker` 进度追踪器

**来源文件**: `/workspace/claude-code-sourcemap/restored-src/src/tasks/LocalAgentTask/LocalAgentTask.tsx`
**行号范围**: 第 23–115 行

**说明**: Agent 任务进度追踪器，跟踪工具使用次数、token 消耗和最近活动列表。关键设计决策：

- **Token 双轨统计**: `latestInputTokens` 保留最新值（因为 Claude API 的 `input_tokens` 是累计值，包含所有历史上下文），`cumulativeOutputTokens` 累加每轮的 `output_tokens`，避免双重计算。
- **活动列表**: 维护最多 5 条最近工具活动（`MAX_RECENT_ACTIVITIES = 5`），每条记录工具名、输入、活动描述和搜索/读操作分类。排除内部工具 `StructuredOutput`。
- **活动描述解析器**: `createActivityDescriptionResolver()` 从工具列表创建闭包，调用 `Tool.getActivityDescription()` 预计算人类可读的活动描述。

包含类型定义（`ToolActivity`、`AgentProgress`、`ProgressTracker`、`ActivityDescriptionResolver`）和四个核心函数：`createProgressTracker()`、`updateProgressFromMessage()`、`getProgressUpdate()`、`createActivityDescriptionResolver()`。

```typescript
export type ToolActivity = {
  toolName: string;
  input: Record<string, unknown>;
  /** Pre-computed activity description from the tool, e.g. "Reading src/foo.ts" */
  activityDescription?: string;
  /** Pre-computed: true if this is a search operation (Grep, Glob, etc.) */
  isSearch?: boolean;
  /** Pre-computed: true if this is a read operation (Read, cat, etc.) */
  isRead?: boolean;
};
export type AgentProgress = {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: ToolActivity;
  recentActivities?: ToolActivity[];
  summary?: string;
};
const MAX_RECENT_ACTIVITIES = 5;
export type ProgressTracker = {
  toolUseCount: number;
  // Track input and output separately to avoid double-counting.
  // input_tokens in Claude API is cumulative per turn (includes all previous context),
  // so we keep the latest value. output_tokens is per-turn, so we sum those.
  latestInputTokens: number;
  cumulativeOutputTokens: number;
  recentActivities: ToolActivity[];
};
export function createProgressTracker(): ProgressTracker {
  return {
    toolUseCount: 0,
    latestInputTokens: 0,
    cumulativeOutputTokens: 0,
    recentActivities: []
  };
}
export function getTokenCountFromTracker(tracker: ProgressTracker): number {
  return tracker.latestInputTokens + tracker.cumulativeOutputTokens;
}

/**
 * Resolver function that returns a human-readable activity description
 * for a given tool name and input. Used to pre-compute descriptions
 * from Tool.getActivityDescription() at recording time.
 */
export type ActivityDescriptionResolver = (toolName: string, input: Record<string, unknown>) => string | undefined;
export function updateProgressFromMessage(tracker: ProgressTracker, message: Message, resolveActivityDescription?: ActivityDescriptionResolver, tools?: Tools): void {
  if (message.type !== 'assistant') {
    return;
  }
  const usage = message.message.usage;
  // Keep latest input (it's cumulative in the API), sum outputs
  tracker.latestInputTokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  tracker.cumulativeOutputTokens += usage.output_tokens;
  for (const content of message.message.content) {
    if (content.type === 'tool_use') {
      tracker.toolUseCount++;
      // Omit StructuredOutput from preview - it's an internal tool
      if (content.name !== SYNTHETIC_OUTPUT_TOOL_NAME) {
        const input = content.input as Record<string, unknown>;
        const classification = tools ? getToolSearchOrReadInfo(content.name, input, tools) : undefined;
        tracker.recentActivities.push({
          toolName: content.name,
          input,
          activityDescription: resolveActivityDescription?.(content.name, input),
          isSearch: classification?.isSearch,
          isRead: classification?.isRead
        });
      }
    }
  }
  while (tracker.recentActivities.length > MAX_RECENT_ACTIVITIES) {
    tracker.recentActivities.shift();
  }
}
export function getProgressUpdate(tracker: ProgressTracker): AgentProgress {
  return {
    toolUseCount: tracker.toolUseCount,
    tokenCount: getTokenCountFromTracker(tracker),
    lastActivity: tracker.recentActivities.length > 0 ? tracker.recentActivities[tracker.recentActivities.length - 1] : undefined,
    recentActivities: [...tracker.recentActivities]
  };
}

/**
 * Creates an ActivityDescriptionResolver from a tools list.
 * Looks up the tool by name and calls getActivityDescription if available.
 */
export function createActivityDescriptionResolver(tools: Tools): ActivityDescriptionResolver {
  return (toolName, input) => {
    const tool = findToolByName(tools, toolName);
    return tool?.getActivityDescription?.(input) ?? undefined;
  };
}
```
