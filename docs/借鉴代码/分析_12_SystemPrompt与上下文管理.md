# 分析_12_SystemPrompt与上下文管理

> **轮次**：第 12 轮 — SystemPrompt与上下文管理深度拆解
>
> **日期**：2026-04-20
>
> **阅读量**：~200 KB（bootstrap/state.ts、utils/api.ts、utils/toolSearch.ts、utils/systemPromptType.ts、utils/systemPrompt.ts、services/compact/、query/deps.ts、query.ts）
>
> **产出价值**：SystemPrompt注册表缓存机制完整拆解 + 工具懒加载与ToolSearch体系 + 五层上下文压缩管线 + 依赖注入模式分析 + Branded Type类型安全 + 对EvoAgent的5项参考价值

---

## 一、systemPromptSections 注册表机制

### 1.1 核心数据结构

claude-code在全局状态中维护了一个SystemPrompt段的缓存Map，用于在多次API调用之间复用已计算好的SystemPrompt片段：

```typescript
// bootstrap/state.ts — State类型定义
type State = {
  // ...
  systemPromptSectionCache: Map<string, string | null>
  // ...
}
```

对应的三个访问器函数提供了严格的读写控制：

```typescript
// 读取缓存
export function getSystemPromptSectionCache(): Map<string, string | null> {
  return STATE.systemPromptSectionCache
}

// 写入缓存条目（key=段名称, value=内容或null表示无效）
export function setSystemPromptSectionCacheEntry(
  name: string,
  value: string | null,
): void {
  STATE.systemPromptSectionCache.set(name, value)
}

// 清空全部缓存（会话切换/重置时调用）
export function clearSystemPromptSectionState(): void {
  STATE.systemPromptSectionCache.clear()
}
```

**关键洞察**：`Map<string, string | null>` 的value类型允许null，这是一个"负缓存"设计——null表示该段已计算但结果为空，避免重复计算必然为空的段。

### 1.2 静态/动态边界分割

SystemPrompt的构建过程中存在一个关键的分界常量 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`，它将SystemPrompt数组分为两个区域：

```
┌──────────────────────────────────────────────────────────────┐
│              SystemPrompt 数组结构                              │
│                                                              │
│  [0] Attribution Header        ─┐                            │
│  [1] System Prompt Prefix      ─┤  静态区 (Static)           │
│  [2] 核心指令 (角色/行为规范)    ─┤  cacheScope: 'global'     │
│  [3] 工具使用规则               ─┤  → Prompt Cache 命中      │
│  ──── SYSTEM_PROMPT_DYNAMIC_BOUNDARY ──── 分界线 ────        │
│  [4] 当前工作目录信息           ─┐                            │
│  [5] Git状态                   ─┤  动态区 (Dynamic)          │
│  [6] 用户上下文 (CLAUDE.md)    ─┤  cacheScope: null          │
│  [7] 日期/时间信息              ─┘  → 每次请求重新生成        │
└──────────────────────────────────────────────────────────────┘
```

### 1.3 三种缓存路径

`splitSysPromptPrefix()` 函数（位于 `utils/api.ts`）实现了三种不同的缓存策略路径：

```
┌──────────────────────────────────────────────────────────────────┐
│                    三种缓存路径决策                                 │
│                                                                  │
│  路径1: MCP工具存在 (skipGlobalCacheForSystemPrompt=true)         │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Attribution Header  → cacheScope: null                    │  │
│  │  SysPrompt Prefix    → cacheScope: 'org'                   │  │
│  │  其余内容合并        → cacheScope: 'org'                   │  │
│  │  说明: MCP工具会频繁变更，不使用global缓存                    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  路径2: 1P + 边界标记存在 (默认路径)                               │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Attribution Header  → cacheScope: null                    │  │
│  │  SysPrompt Prefix    → cacheScope: null                    │  │
│  │  边界前静态内容      → cacheScope: 'global'  ← 核心优化   │  │
│  │  边界后动态内容      → cacheScope: null                    │  │
│  │  说明: 静态部分享受最长TTL的Prompt Cache命中                 │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  路径3: 3P提供商 / 边界缺失                                       │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Attribution Header  → cacheScope: null                    │  │
│  │  SysPrompt Prefix    → cacheScope: 'org'                   │  │
│  │  其余内容合并        → cacheScope: 'org'                   │  │
│  │  说明: 第三方提供商不支持global scope，降级为org              │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**设计模式**：策略模式（Strategy Pattern）——根据运行时条件（是否1P、是否有MCP工具、是否有边界标记）选择不同的缓存分块策略。

### 1.4 CacheScope 与 Prompt Cache 优化

`CacheScope` 类型定义了两个级别：

```typescript
export type CacheScope = 'global' | 'org'

export type SystemPromptBlock = {
  text: string
  cacheScope: CacheScope | null  // null = 不缓存
}
```

- **`'global'`**：跨所有用户共享的缓存，TTL最长（5分钟），适用于完全静态的内容如核心角色指令
- **`'org'`**：组织级别缓存，适用于半静态内容如团队配置
- **`null`**：不参与缓存，每次请求都重新发送，适用于动态内容如当前时间、工作目录状态

**关键洞察**：这种分块缓存策略直接利用了Anthropic API的Prompt Cache特性。SystemPrompt被拆分为多个block，每个block独立设置cache_control。静态block在首次请求后进入缓存，后续请求只需发送cache_control引用，大幅降低input token成本。根据源码中的注释，这一优化可节省约50-70K token的缓存开销。

### 1.5 SystemPrompt Branded Type

为了在类型层面确保SystemPrompt不会被误用，claude-code使用了Branded Type：

```typescript
// utils/systemPromptType.ts
export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}
```

这个类型定义有两个关键约束：
1. `readonly string[]` — 不可变的字符串数组
2. `& { readonly __brand: 'SystemPrompt' }` — 品牌标记，防止普通`string[]`被当作SystemPrompt使用

**设计模式**：Branded Type（品牌类型）——通过交叉类型添加编译时唯一标记，在不增加运行时开销的前提下实现类型安全。任何试图将`string[]`直接传给需要`SystemPrompt`的函数的代码都会产生类型错误，必须通过`asSystemPrompt()`进行显式转换。

---

## 二、shouldDefer 工具懒加载机制

### 2.1 核心概念

claude-code的工具系统支持"延迟加载"——某些工具在初始SystemPrompt中只暴露名称，不发送完整的JSON Schema。只有当模型实际需要使用该工具时，才通过ToolSearch机制按需加载完整定义。

```typescript
// Tool定义上的shouldDefer标记
type Tool = {
  name: string
  shouldDefer?: boolean     // true = 初始只发送名称
  alwaysLoad?: boolean      // true = 无论defer设置都始终包含
  isMcp?: boolean           // MCP工具默认走defer路径
  // ...
}
```

### 2.2 ToolSearchMode 三种模式

`ENABLE_TOOL_SEARCH` 环境变量控制工具搜索的运行模式：

```typescript
export type ToolSearchMode = 'tst' | 'tst-auto' | 'standard'
```

```
┌──────────────────────────────────────────────────────────────────┐
│                    ToolSearchMode 决策流程                         │
│                                                                  │
│  ENABLE_TOOL_SEARCH = ?                                          │
│       │                                                          │
│       ├── CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=true            │
│       │   └── return 'standard'  (强制禁用beta特性)               │
│       │                                                          │
│       ├── 'auto:0' ──→ return 'tst'     (始终启用)               │
│       ├── 'auto:100' ──→ return 'standard' (始终禁用)             │
│       ├── 'auto' / 'auto:1-99' ──→ return 'tst-auto'            │
│       ├── 'true' ──→ return 'tst'                                │
│       ├── 'false' ──→ return 'standard'                          │
│       └── (unset) ──→ return 'tst'  (默认: 始终defer)            │
│                                                                  │
│  tst:       Tool Search Tool 始终启用                             │
│  tst-auto:  仅当延迟工具超过上下文窗口N%时启用 (默认10%)           │
│  standard:  所有工具内联暴露，无延迟加载                            │
└──────────────────────────────────────────────────────────────────┘
```

### 2.3 auto模式的自适应阈值

`tst-auto` 模式实现了智能阈值判断——只有当延迟工具的token总量超过上下文窗口的一定比例时，才启用工具搜索：

```typescript
const DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE = 10  // 默认10%

function getAutoToolSearchTokenThreshold(model: string): number {
  const contextWindow = getContextWindowForModel(model, betas)
  const percentage = getAutoToolSearchPercentage() / 100
  return Math.floor(contextWindow * percentage)
}
```

判断流程优先使用精确的token计数API，失败时降级为字符数启发式估算（`CHARS_PER_TOKEN = 2.5`）：

```
┌──────────────────────────────────────────────────────────────┐
│              tst-auto 阈值判断流程                              │
│                                                              │
│  1. 尝试精确token计数 (countToolDefinitionTokens)             │
│     ├── 成功 → 与阈值比较 → 启用/禁用                        │
│     └── 失败 ↓                                               │
│  2. 降级为字符数估算 (calculateDeferredToolDescriptionChars)  │
│     └── chars > threshold * 2.5 → 启用/禁用                  │
│                                                              │
│  阈值 = contextWindow * percentage (默认10%)                  │
│  例: 200K窗口 → 阈值 = 20K tokens                            │
└──────────────────────────────────────────────────────────────┘
```

### 2.4 工具发现与加载流程

当ToolSearch启用时，延迟工具通过 `ToolSearchTool` 按需发现：

```
┌──────────────────────────────────────────────────────────────────┐
│                    工具懒加载完整流程                               │
│                                                                  │
│  [初始请求]                                                      │
│  SystemPrompt: "...可用工具: Bash, Read, Write, [deferred: A, B]" │
│  Tools数组: [Bash, Read, Write, ToolSearchTool]                  │
│  deferred工具: 发送 defer_loading: true 标记                     │
│                                                                  │
│  [模型推理]                                                      │
│  模型看到deferred工具名称列表，决定是否需要使用                     │
│  ├── 不需要 → 正常使用已加载的工具                                │
│  └── 需要工具A → 调用 ToolSearchTool(name="A")                   │
│                                                                  │
│  [ToolSearchTool 执行]                                            │
│  1. 在本地工具注册表中查找工具A的完整Schema                        │
│  2. 返回 tool_reference block: { type: 'tool_reference',         │
│                                  tool_name: 'A' }                │
│                                                                  │
│  [后续请求]                                                      │
│  API收到 tool_reference → 自动展开为完整工具定义                   │
│  模型现在可以使用工具A的完整Schema进行调用                          │
│                                                                  │
│  [跨轮次保持]                                                    │
│  extractDiscoveredToolNames() 扫描消息历史                        │
│  → 收集所有已发现的工具名 → 后续请求自动包含                       │
│  → compact时通过 preCompactDiscoveredTools 持久化                 │
└──────────────────────────────────────────────────────────────────┘
```

### 2.5 模型兼容性检查

并非所有模型都支持 `tool_reference` beta特性：

```typescript
export function modelSupportsToolReference(model: string): boolean {
  const unsupportedPatterns = getUnsupportedToolReferencePatterns()
  // 默认不支持列表: ['haiku']
  // 可通过GrowthBook动态更新
  for (const pattern of unsupportedPatterns) {
    if (normalizedModel.includes(pattern.toLowerCase())) {
      return false
    }
  }
  return true  // 新模型默认支持
}
```

**关键洞察**：采用"白名单排除"而非"白名单包含"——新模型默认支持tool_reference，只有明确列入不支持列表的模型才会被禁用。这确保了新模型发布时无需代码变更即可使用工具搜索功能。不支持列表通过GrowthBook远程配置，无需发版即可更新。

### 2.6 alwaysLoad 机制

`alwaysLoad?: boolean` 标记用于强制某些工具始终包含在初始SystemPrompt中，即使它们也设置了 `shouldDefer`：

```typescript
// 工具分类逻辑
const alwaysLoadedTools = builtInTools.filter(t => !isDeferredTool(t))
const deferredBuiltinTools = builtInTools.filter(t => isDeferredTool(t))
```

`isDeferredTool()` 的判断逻辑综合考虑了 `shouldDefer`、`alwaysLoad`、`isMcp` 以及当前ToolSearchMode。

**设计模式**：延迟加载（Lazy Loading）+ 注册表发现（Registry Discovery）——工具先注册名称，后按需加载完整定义，结合ToolSearchTool作为发现服务。

---

## 三、五层上下文压缩管线

### 3.1 管线全景

claude-code的上下文管理不是单一的压缩策略，而是五层递进的压缩管线，每一层有不同的成本/质量权衡：

```
┌──────────────────────────────────────────────────────────────────┐
│                    五层上下文压缩管线                               │
│                                                                  │
│  请求进入 query()                                                 │
│       │                                                          │
│       ▼                                                          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Layer 1: Tool Result Budget (工具结果预算)                 │  │
│  │  成本: O(n) 扫描    质量: 无损（仅截断）                    │  │
│  │  作用: 截断过大的单条工具结果，防止一条结果撑爆上下文         │  │
│  │  实现: applyToolResultBudget()                              │  │
│  └────────────────────────────────────────────────────────────┘  │
│       │                                                          │
│       ▼                                                          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Layer 2: Snip (历史裁剪)                                  │  │
│  │  成本: O(n) 扫描    质量: 有损（丢弃旧轮次）                │  │
│  │  作用: 移除较不重要的旧对话轮次，保护最近N轮                 │  │
│  │  实现: snipCompactIfNeeded() [feature('HISTORY_SNIP')]      │  │
│  │  注意: 保护含tool_reference的消息不被裁剪                    │  │
│  └────────────────────────────────────────────────────────────┘  │
│       │                                                          │
│       ▼                                                          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Layer 3: MicroCompact (微压缩)                            │  │
│  │  成本: 1次API调用     质量: 中等（轻量摘要）                │  │
│  │  作用: 对旧的工具结果进行轻量摘要，保留关键信息              │  │
│  │  实现: deps.microcompact() → microcompactMessages()         │  │
│  │  优化: Cached MicroCompact 复用已计算的编辑块                │  │
│  └────────────────────────────────────────────────────────────┘  │
│       │                                                          │
│       ▼                                                          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Layer 4: AutoCompact (自动压缩)                           │  │
│  │  成本: 1次API调用     质量: 较高（完整摘要）                │  │
│  │  作用: 当上下文超过阈值时，将旧对话总结为摘要               │  │
│  │  实现: deps.autocompact() → autoCompactIfNeeded()           │  │
│  │  阈值: effectiveContextWindow - 13K tokens                  │  │
│  │  熔断: 连续3次失败后停止重试                                │  │
│  └────────────────────────────────────────────────────────────┘  │
│       │                                                          │
│       ▼                                                          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Layer 5: ContextCollapse (上下文坍缩)                      │  │
│  │  成本: 多次API调用     质量: 最激进（分段压缩）              │  │
│  │  作用: 将旧上下文分段压缩为结构化记忆                        │  │
│  │  实现: contextCollapse [feature('CONTEXT_COLLAPSE')]        │  │
│  │  触发: 90%开始提交, 95%阻塞                                │  │
│  │  抑制: 启用时禁用Layer 4 (AutoCompact)                      │  │
│  └────────────────────────────────────────────────────────────┘  │
│       │                                                          │
│       ▼                                                          │
│  发送API请求                                                     │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 各层详解

#### Layer 1: Tool Result Budget

```typescript
// query.ts 中的执行顺序
messagesForQuery = applyToolResultBudget(
  messagesForQuery,
  toolUseContext.options.tools,
  // ...
)
```

这是最轻量的层，纯本地操作，无API调用。它遍历所有工具结果，对超过预算的单条结果进行截断。截断策略保留头部和尾部内容，中间用省略标记替代。

#### Layer 2: Snip

```typescript
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
  if (snipResult.boundaryMessage) {
    yield snipResult.boundaryMessage
  }
}
```

Snip在MicroCompact之前执行，移除较旧的对话轮次。关键设计点：
- `snipTokensFreed` 被传递给AutoCompact的阈值检查，确保Snip节省的空间被正确计算
- 含有 `tool_reference` 的消息被保护，不会被Snip移除（否则已发现的工具会丢失）
- Snip与MicroCompact不互斥——两者可能同时执行

#### Layer 3: MicroCompact

```typescript
const microcompactResult = await deps.microcompact(
  messagesForQuery,
  toolUseContext,
  querySource,
  // ...
)
```

MicroCompact对旧的工具结果进行轻量级摘要替换。它有一个高级优化——Cached MicroCompact：

```
┌──────────────────────────────────────────────────────────────┐
│              Cached MicroCompact 优化                          │
│                                                              │
│  问题: 每次API调用前都要重新计算MC，但大部分编辑块未变化        │
│                                                              │
│  解决方案:                                                    │
│  1. 维护 pinnedCacheEdits[] — 已发送到API的编辑块缓存         │
│  2. 新编辑通过 consumePendingCacheEdits() 获取                │
│  3. pinCacheEdits() 将新编辑固定到位置                        │
│  4. 后续请求复用 pinned edits → Prompt Cache 命中             │
│                                                              │
│  效果: 避免重复计算未变化的编辑块，保持缓存一致性              │
└──────────────────────────────────────────────────────────────┘
```

#### Layer 4: AutoCompact

```typescript
const compactionResult = await deps.autocompact(
  messagesForQuery,
  toolUseContext,
  cacheSafeParams,
  querySource,
  tracking,
  snipTokensFreed,
)
```

AutoCompact是最成熟的压缩层，有完整的生命周期管理：

```typescript
// 阈值计算
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
}

// 熔断机制
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

AutoCompact执行流程：
1. **Session Memory优先** — 先尝试 `trySessionMemoryCompaction()`，通过结构化记忆替代摘要
2. **Forked Agent路径** — 使用 `runForkedAgent()` 复用主会话的Prompt Cache
3. **PTL重试** — compact请求自身可能prompt-too-long，通过 `truncateHeadForPTLRetry()` 截断最旧的轮次重试
4. **Post-compact恢复** — 重新注入文件状态、Plan文件、技能内容、延迟工具delta等

#### Layer 5: ContextCollapse

```typescript
if (feature('CONTEXT_COLLAPSE')) {
  const { isContextCollapseEnabled } =
    require('../services/contextCollapse/index.js')
  if (isContextCollapseEnabled()) {
    // 抑制AutoCompact，由Collapse接管
    return false  // shouldAutoCompact返回false
  }
}
```

ContextCollapse是最激进的压缩策略，启用时会完全接管上下文管理：
- 在90%上下文使用率时开始分段提交压缩
- 在95%时阻塞新请求直到压缩完成
- 抑制AutoCompact，避免两个系统竞争

### 3.3 层间协作关系

```
┌──────────────────────────────────────────────────────────────┐
│              层间协作与抑制关系                                 │
│                                                              │
│  Layer 1 (Budget) ──→ 总是执行                               │
│  Layer 2 (Snip)    ──→ 总是执行 (feature gate)               │
│  Layer 3 (MicroCompact) ──→ 总是执行                         │
│  Layer 4 (AutoCompact) ──→ 阈值触发，受Layer 5抑制           │
│  Layer 5 (Collapse) ──→ 启用时抑制Layer 4                    │
│                                                              │
│  执行顺序: 1 → 2 → 3 → 4(或5)                               │
│  每层独立决策，不依赖前层结果                                  │
│  但snipTokensFreed会影响Layer 4的阈值判断                     │
└──────────────────────────────────────────────────────────────┘
```

**关键洞察**：五层管线遵循"先轻后重"原则——成本最低、质量最高的层先执行。Layer 1-3是"无损或微损"的本地操作，Layer 4-5需要API调用且有信息损失。这种渐进式设计确保了：简单场景用轻量方案解决，复杂场景才动用重量级压缩。

**设计模式**：责任链模式（Chain of Responsibility）+ 管线模式（Pipeline）——每一层独立决策是否需要执行压缩，层层递进，直到上下文在预算范围内。

---

## 四、依赖注入模式 (deps.callModel)

### 4.1 QueryDeps 接口定义

`query/deps.ts` 定义了一个精简的依赖注入接口：

```typescript
export type QueryDeps = {
  // -- model
  callModel: typeof queryModelWithStreaming

  // -- compaction
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded

  // -- platform
  uuid: () => string
}

export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
```

### 4.2 使用方式

在 `query.ts` 中，所有对外部服务的调用都通过 `deps` 对象进行：

```typescript
import { productionDeps, type QueryDeps } from './query/deps.js'

// 生产环境使用真实实现
const result = await deps.callModel({ ... })
const mcResult = await deps.microcompact(messages, ...)
const acResult = await deps.autocompact(messages, ...)
const id = deps.uuid()
```

### 4.3 设计动机

源码注释明确说明了设计意图：

```
┌──────────────────────────────────────────────────────────────┐
│              deps 注入的设计动机                                │
│                                                              │
│  问题:                                                       │
│  - callModel 在 6-8 个测试文件中被 spyOn                      │
│  - autocompact 同样在多个测试文件中被 mock                     │
│  - 每个测试文件都需要 import + spyOn 的样板代码               │
│                                                              │
│  解决方案:                                                    │
│  - 将4个最常用的外部依赖集中到 QueryDeps 接口                  │
│  - 测试时传入 mock 实现，无需 spyOn                            │
│  - typeof fn 保持签名自动同步                                  │
│                                                              │
│  范围控制:                                                    │
│  "Scope is intentionally narrow (4 deps) to prove the         │
│   pattern. Followup PRs can add runTools, handleStopHooks,   │
│   logEvent, queue ops, etc."                                 │
└──────────────────────────────────────────────────────────────┘
```

### 4.4 架构价值

```
┌──────────────────────────────────────────────────────────────────┐
│                    依赖注入的架构价值                               │
│                                                                  │
│  1. 多Provider可插拔                                              │
│     deps.callModel 可以指向不同的LLM后端                           │
│     → Anthropic / Vertex / Bedrock / Foundry / 自定义              │
│                                                                  │
│  2. 测试友好                                                      │
│     测试代码: deps = { callModel: mockFn, ... }                   │
│     无需模块级别的 spyOn，避免测试间干扰                            │
│                                                                  │
│  3. 运行时可切换                                                  │
│     可以在不重启的情况下切换Provider实现                             │
│     (当前代码中尚未完全利用，但架构已支持)                          │
│                                                                  │
│  4. 类型安全签名同步                                              │
│     使用 typeof fn 而非手动定义接口                                │
│     → 实现函数签名变更时，deps类型自动更新                         │
└──────────────────────────────────────────────────────────────────┘
```

**设计模式**：依赖注入（Dependency Injection）+ 工厂模式（Factory Pattern）——`productionDeps()` 是工厂函数，生产环境返回真实实现，测试环境可注入mock。使用 `typeof fn` 保持接口与实现的签名同步，消除了手动维护接口的成本。

**关键洞察**：deps的设计遵循"最小证明"原则——先只抽4个最频繁mock的依赖，验证模式可行后再逐步扩展。这种渐进式重构降低了引入风险。

---

## 五、对EvoAgent的参考价值

### 5.1 SystemPrompt缓存分离 → 多Provider优化

claude-code的静态/动态边界分割和三级缓存路径为EvoAgent提供了直接的参考：

- **静态区global缓存**：EvoAgent的核心角色定义、进化规则等不变内容应标记为`cacheScope: 'global'`
- **动态区null缓存**：当前进化状态、环境信息等变化内容应放在边界之后
- **MCP感知降级**：当外部工具集频繁变化时，自动降级缓存策略

### 5.2 工具懒加载 → 降低初始上下文成本

EvoAgent的工具集（代码生成、测试执行、评估分析等）可能非常庞大。参考claude-code的shouldDefer机制：

- 将低频工具（如特定框架的部署工具）标记为deferred
- 通过ToolSearch按需发现，减少初始SystemPrompt的token消耗
- 使用`alwaysLoad`确保核心工具（如代码生成、测试）始终可用
- 采用"排除白名单"策略，新工具默认支持，无需维护包含列表

### 5.3 五层渐进压缩 → 上下文预算管理

EvoAgent的长对话场景（多轮进化迭代）需要类似的上下文管理策略：

- **Layer 1 (Budget)**：对单次评估结果设置token上限
- **Layer 2 (Snip)**：移除旧的评估轮次，保留最近N轮完整上下文
- **Layer 3 (MicroCompact)**：对旧代码diff进行轻量摘要
- **Layer 4 (AutoCompact)**：当上下文接近阈值时，将进化历史总结为结构化摘要
- **Layer 5 (Collapse)**：最激进的全量压缩，保留关键进化节点

### 5.4 依赖注入 → Provider无关架构

EvoAgent可能需要支持多种LLM后端（Claude、GPT、本地模型等）：

```typescript
// 参考claude-code的deps模式
type EvoAgentDeps = {
  callModel: typeof callLLM
  evaluate: typeof evaluateCode
  evolve: typeof evolvePrompt
  uuid: () => string
}
```

使用`typeof fn`保持签名同步，测试时注入mock，生产环境通过工厂函数创建真实实现。

### 5.5 Branded Type → 编译时类型安全

EvoAgent中存在多种需要类型区分的字符串类型（AgentId、SessionId、PromptId等）：

```typescript
// 参考claude-code的SystemPrompt品牌类型
type AgentId = string & { readonly __brand: 'AgentId' }
type EvolutionId = string & { readonly __brand: 'EvolutionId' }
type PromptVariant = string & { readonly __brand: 'PromptVariant' }
```

这种模式在不增加运行时开销的前提下，防止不同语义的ID被混用——将错误从运行时提前到编译时捕获。

---

## 附录：关键源码文件索引

| 文件路径 | 核心职责 |
|---------|---------|
| `bootstrap/state.ts` | 全局状态管理，systemPromptSectionCache存储 |
| `utils/api.ts` | splitSysPromptPrefix()，缓存分块策略 |
| `utils/systemPromptType.ts` | SystemPrompt Branded Type定义 |
| `utils/systemPrompt.ts` | buildEffectiveSystemPrompt()，优先级合成 |
| `utils/toolSearch.ts` | ToolSearchMode决策，工具发现与加载 |
| `query/deps.ts` | QueryDeps依赖注入接口 |
| `query.ts` | 五层压缩管线的编排入口 |
| `services/compact/autoCompact.ts` | AutoCompact阈值判断与执行 |
| `services/compact/compact.ts` | 完整压缩流程（含PTL重试、post-compact恢复） |
| `services/compact/microCompact.ts` | MicroCompact轻量摘要 + Cached MC优化 |
