# 分析_04_查询引擎与Prompt架构

> **轮次**：第 4 轮 — 查询引擎 + 上下文管理 + Prompt 分层架构
>
> **日期**：2026-04-11
>
> **阅读量**：~250 KB（QueryEngine.ts 46KB + query.ts 68KB + query/ 23KB + context.ts 6KB + context/ 106KB + openclaw context-engine/ 63KB）
>
> **产出价值**：查询路由算法、上下文窗口管理策略、Prompt 分层架构、上下文压缩/截断策略、流式输出机制、Token 预算管理

---

## 一、核心发现摘要

本轮深入分析了两个项目的查询引擎和上下文管理系统，发现了**两种截然不同的上下文管理哲学**：

| 维度 | claude-code-sourcemap | openclaw |
|------|----------------------|----------|
| **查询引擎** | `QueryEngine` + `query()` Agentic Loop（单体、内聚） | `pi-embedded-runner` + `ContextEngine` 接口（可插拔） |
| **上下文架构** | 固定分层（System → User → Inject） | 可插拔引擎（assemble/compact/ingest/rewrite） |
| **Prompt 组装** | 运行时拼接（memoize 缓存） | 引擎驱动（ContextEngine.assemble） |
| **压缩策略** | 三级递进（Microcompact → Autocompact → Reactive） | 多阶段摘要 + 两级修剪 + 安全超时 |
| **流式输出** | AsyncGenerator + yield* 嵌套组合 | 流式传输 + 增量事件推送 |
| **Token 预算** | BudgetTracker（90% 阈值 + 边际收益检测） | 上下文窗口守卫 + 自适应分块 |
| **错误恢复** | 7 种恢复路径（Prompt Too Long / max_output_tokens / 模型回退等） | 渐进降级（完整摘要 → 分离超大消息 → 失败兜底） |

---

## 二、claude-code-sourcemap 的查询引擎

### 2.1 整体架构：QueryEngine + query() 双层设计

```
┌─────────────────────────────────────────────────────────────────┐
│                    QueryEngine（会话级封装）                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  submitMessage(prompt) → AsyncGenerator<SDKMessage>     │  │
│  │                                                          │  │
│  │  职责：                                                   │  │
│  │  ├─ 依赖注入（QueryEngineConfig → 30+ 配置项）           │  │
│  │  ├─ 状态管理（mutableMessages / totalUsage / denials）    │  │
│  │  ├─ System Prompt 组装（分层拼接）                       │  │
│  │  ├─ 用户输入处理（processUserInput）                     │  │
│  │  ├─ 技能/插件加载                                        │  │
│  │  ├─ 本地命令快速路径                                      │  │
│  │  └─ 结果提取与成功/失败判定                              │  │
│  └──────────────────────────┬───────────────────────────────┘  │
│                             │                                   │
│                    ┌────────▼────────┐                          │
│                    │  query()       │                          │
│                    │  Agentic Loop  │                          │
│                    │  (核心循环)     │                          │
│                    └────────┬────────┘                          │
│                             │                                   │
│  ┌──────────────────────────▼───────────────────────────────┐  │
│  │  queryLoop() — while(true) 无限循环                       │  │
│  │  ├─ 1. 消息准备（压缩/修剪/折叠/预算）                   │  │
│  │  ├─ 2. 自动压缩检查                                      │  │
│  │  ├─ 3. 阻塞限制检查                                      │  │
│  │  ├─ 4. API 调用（流式 + 模型回退重试）                   │  │
│  │  ├─ 5. 中断检查                                          │  │
│  │  ├─ 6. 无工具路径（PTL/maxOT恢复/停止钩子/Token预算）    │  │
│  │  ├─ 7. 工具执行（流式/批量）                             │  │
│  │  └─ 8. 附件与状态更新 → continue                         │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 QueryEngine — 会话级查询引擎

#### 2.2.1 依赖注入结构

```
QueryEngineConfig（30+ 配置项）
├── 基础配置
│   ├── cwd: string                          // 工作目录
│   ├── tools: Tools                         // 工具集合
│   ├── commands: Command[]                  // 命令列表
│   ├── mcpClients: MCPServerConnection[]    // MCP 连接
│   └── agents: AgentDefinition[]            // Agent 定义
│
├── 权限与状态
│   ├── canUseTool: CanUseToolFn             // 权限判断
│   ├── getAppState / setAppState            // 状态访问
│   └── readFileCache: FileStateCache        // 文件缓存
│
├── 模型配置
│   ├── userSpecifiedModel?: string          // 用户指定模型
│   ├── fallbackModel?: string               // 回退模型
│   ├── thinkingConfig?: ThinkingConfig      // 思考配置
│   └── maxOutputTokensOverride?: number     // 输出上限
│
├── 预算与限制
│   ├── maxTurns?: number                    // 最大轮次
│   ├── maxBudgetUsd?: number                // USD 预算
│   └── taskBudget?: { total: number }       // Token 预算
│
├── Prompt 定制
│   ├── customSystemPrompt?: string          // 自定义系统提示
│   ├── appendSystemPrompt?: string          // 追加系统提示
│   └── jsonSchema?: Record<string, unknown> // 结构化输出
│
└── 控制流
    ├── abortController?: AbortController    // 中断控制
    ├── verbose?: boolean                    // 详细模式
    └── replayUserMessages?: boolean         // 消息回放
```

**关键设计洞察**：
- 所有外部依赖通过构造函数注入，引擎与 UI 完全解耦
- `wrappedCanUseTool` 代理模式：包装原始权限函数，在非 allow 行为时记录 `permissionDenials`（SDK 报告用）
- `mutableMessages` 是跨轮次持久化的可变消息数组，QueryEngine 拥有完整会话状态

#### 2.2.2 submitMessage() 六阶段流程

```
阶段一：初始化
  ├─ 状态重置（discoveredSkillNames 清空）
  ├─ 权限包装（wrappedCanUseTool）
  ├─ 模型解析（userSpecifiedModel → parseUserSpecifiedModel）
  ├─ 思考配置（默认 adaptive）
  ├─ System Prompt 组装（分层拼接，详见 2.4 节）
  └─ 结构化输出注册（jsonSchema + SyntheticOutputTool）

阶段二：用户输入处理
  ├─ 孤立权限处理（一次性）
  ├─ processUserInput() → messagesFromUserInput + shouldQuery
  ├─ 消息推入 mutableMessages
  ├─ 会话持久化（recordTranscript）
  └─ 权限上下文更新

阶段三：技能与插件加载
  ├─ getSlashCommandToolSkills()
  ├─ loadAllPluginsCacheOnly()（仅缓存，不阻塞网络）
  └─ buildSystemInitMessage()（工具/MCP/模型/权限/命令/Agent/技能/插件）

阶段四：本地命令快速路径
  └─ !shouldQuery → 遍历消息，产出本地结果，return

阶段五：Agentic Loop 执行
  └─ for await (const message of query(...))
      ├─ 消息分类处理（tombstone/assistant/progress/user/stream_event/attachment/system）
      ├─ 流式用量追踪（message_start/delta/stop）
      └─ 预算检查（USD / 结构化输出重试）

阶段六：结果产出
  ├─ 结果提取（最后一个 assistant/user 消息）
  ├─ 成功判定（isResultSuccessful）
  └─ 成功/失败路径分别产出
```

### 2.3 query() — Agentic Loop 核心循环

#### 2.3.1 State 数据结构

```typescript
type State = {
  messages: Message[]                              // 当前消息
  toolUseContext: ToolUseContext                   // 工具上下文
  autoCompactTracking: AutoCompactTrackingState    // 自动压缩跟踪
  maxOutputTokensRecoveryCount: number             // maxOT 恢复计数
  hasAttemptedReactiveCompact: boolean             // 已尝试响应式压缩
  maxOutputTokensOverride: number | undefined      // 输出 Token 覆盖
  pendingToolUseSummary: Promise<...> | undefined  // 待处理工具摘要
  stopHookActive: boolean | undefined              // 停止钩子激活
  turnCount: number                                // 当前轮次
  transition: Continue | undefined                 // 上一轮继续原因
}
```

**设计模式**：隐式状态机。`State` 对象在迭代间通过解构/重建传递，`transition` 字段记录上一轮的继续原因，实现无 goto 的结构化控制流。

#### 2.3.2 Continue/Terminal 类型体系

```typescript
type Terminal = {
  reason: 'completed' | 'aborted_streaming' | 'aborted_tools'
    | 'blocking_limit' | 'image_error' | 'model_error'
    | 'max_turns' | 'stop_hook_prevented' | 'hook_stopped'
    | 'prompt_too_long'
}

type Continue =
  | { reason: 'next_turn' }
  | { reason: 'collapse_drain_retry' }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'max_output_tokens_escalate' }
  | { reason: 'max_output_tokens_recovery'; attempt: number }
  | { reason: 'stop_hook_blocking' }
  | { reason: 'token_budget_continuation' }
```

**关键洞察**：`Continue` 有 7 种变体，每种对应不同的恢复策略。这种设计使得循环可以从任意恢复点重新进入，而非简单的"重试"。

#### 2.3.3 每轮迭代的 8 个步骤

**步骤 1：消息准备**

```
原始消息
  │
  ├─ getMessagesAfterCompactBoundary()  // 跳过压缩边界之前的消息
  │
  ├─ applyToolResultBudget()            // 工具结果大小限制
  │
  ├─ snipCompactIfNeeded()              // Snip 压缩（HISTORY_SNIP gate）
  │
  ├─ microcompactMessages()             // 微压缩（轻量级）
  │
  ├─ applyCollapsesIfNeeded()           // 上下文折叠（CONTEXT_COLLAPSE gate）
  │
  ├─ autoCompactIfNeeded()              // 自动压缩（重量级，LLM 驱动）
  │
  └─ prependUserContext()               // 注入用户上下文（CLAUDE.md + 日期）
```

**步骤 2：自动压缩**

- 成功时：记录分析事件、更新 taskBudgetRemaining、重置 tracking
- 失败时：传播 `consecutiveFailures` 给断路器（防止压缩螺旋）

**步骤 3：阻塞限制检查**

条件检查（全部满足才跳过）：
- 没有刚发生压缩
- 非 compact/session_memory 查询源
- 响应式/自动压缩未启用
- 上下文折叠未启用

**步骤 4：API 调用循环**

```
外层：while(attemptWithFallback)  ← 模型回退重试
  内层：for await (const message of callModel(...))  ← 流式接收
    ├─ 回退处理（FallbackTriggeredError → 切换模型）
    ├─ 工具输入回填（backfillObservableInput）
    ├─ 可恢复错误扣留（PTL / maxOT / Media Size）
    ├─ 助手消息收集（提取 toolUseBlocks）
    └─ 流式工具执行（StreamingToolExecutor 并行）
```

**步骤 5：中断检查**

- 消费 `getRemainingResults()`（生成合成 tool_result）
- 非流式时 `yieldMissingToolResultBlocks()` 补全
- yield 中断消息，返回 `aborted_streaming`

**步骤 6：无工具调用路径（7 种恢复策略）**

| 恢复策略 | 触发条件 | 恢复方式 |
|----------|----------|----------|
| 上下文折叠 drain | Prompt Too Long + 有暂存折叠 | `recoverFromOverflow()` |
| 响应式压缩 | Prompt Too Long + 无暂存折叠 | `tryReactiveCompact()` |
| maxOT 升级 | max_output_tokens + 首次触发 | 升级到 64k 重试 |
| maxOT 多轮恢复 | max_output_tokens + 非首次 | 注入恢复消息（最多 3 次） |
| API 错误跳过 | 最后消息是 API 错误 | 执行失败钩子，返回 |
| 停止钩子 | 正常完成 | `handleStopHooks()` |
| Token 预算 | 预算耗尽 | `checkTokenBudget()` |

**步骤 7：工具执行**

- 流式：`streamingToolExecutor.getRemainingResults()`
- 批量：`runTools(toolUseBlocks, ...)`
- 工具使用摘要异步生成（不阻塞下一轮）

**步骤 8：附件与状态更新**

- 队列命令快照
- 文件变更通知
- 内存预取消费
- 技能发现注入
- 工具刷新（MCP 可能新连接）
- 最大轮次检查
- 构建新 State → continue

### 2.4 System Prompt 分层架构

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: 核心系统提示                                            │
│   customSystemPrompt（用户自定义，优先）                         │
│   |                                                              │
│   defaultSystemPrompt（fetchSystemPromptParts() 获取）           │
│   ├─ 基础行为指令（角色定位、能力描述、约束条件）                │
│   └─ 工具使用指南（每个工具的 prompt() 方法输出）                │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: 记忆机制提示（条件性）                                  │
│   memoryMechanicsPrompt                                         │
│   └─ 仅当 customPrompt + CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 时  │
├─────────────────────────────────────────────────────────────────┤
│ Layer 3: 追加提示                                               │
│   appendSystemPrompt                                            │
│   └─ 用户通过 API/CLI 追加的额外指令                            │
├─────────────────────────────────────────────────────────────────┤
│ Layer 4: 系统上下文（运行时追加）                                │
│   systemContext（通过 appendSystemContext 追加到系统提示末尾）    │
│   ├─ gitStatus: git 状态快照（分支/状态/最近提交/用户名）       │
│   └─ cacheBreaker: 缓存破坏标记（BREAK_CACHE_COMMAND gate）     │
├─────────────────────────────────────────────────────────────────┤
│ Layer 5: 用户上下文（注入到消息中）                             │
│   userContext（通过 prependUserContext 注入到消息列表头部）      │
│   ├─ claudeMd: CLAUDE.md 文件内容                               │
│   └─ currentDate: "Today's date is YYYY-MM-DD."                 │
├─────────────────────────────────────────────────────────────────┤
│ Layer 6: 系统初始化消息（作为第一条 user 消息）                  │
│   buildSystemInitMessage()                                      │
│   ├─ 可用工具列表（名称 + 描述）                                │
│   ├─ MCP 服务器信息                                             │
│   ├─ 模型配置                                                   │
│   ├─ 权限模式                                                   │
│   ├─ 斜杠命令列表                                               │
│   ├─ Agent 定义                                                 │
│   ├─ 技能列表                                                   │
│   ├─ 插件信息                                                   │
│   └─ 快速模式状态                                               │
└─────────────────────────────────────────────────────────────────┘
```

**关键设计洞察**：
- Layer 1-3 组成 `systemPrompt` 参数，传递给 API
- Layer 4 通过 `appendSystemContext()` 追加到系统提示末尾
- Layer 5 通过 `prependUserContext()` 注入到消息列表头部（作为 user role 消息）
- Layer 6 作为第一条 user 消息，包含完整的工具/能力清单
- 这种分层确保了：核心行为不可变（Layer 1）、用户可定制（Layer 2-3）、运行时动态（Layer 4-6）

### 2.5 上下文组装的缓存策略

```
getSystemContext()  ← lodash memoize（会话级缓存，无 TTL）
  └─ getGitStatus()  ← lodash memoize（会话级缓存）
       └─ Promise.all([getBranch, getDefaultBranch, git status, git log, git config])

getUserContext()  ← lodash memoize（会话级缓存）
  └─ getMemoryFiles() → filterInjectedMemoryFiles() → getClaudeMds()
  └─ setCachedClaudeMdContent()  ← 副作用缓存（给 yoloClassifier 使用）

缓存失效：
  setSystemPromptInjection()  ← 修改注入值时清除所有 memoize 缓存
```

**设计洞察**：
- 使用 `lodash-es/memoize` 实现会话级缓存（整个会话期间只计算一次）
- Git 状态通过 `Promise.all` 并行获取 5 个信息，减少 I/O 等待
- `git status` 输出限制 2000 字符（`MAX_STATUS_CHARS`），防止上下文膨胀
- CLAUDE.md 内容额外缓存给 `yoloClassifier`（避免循环依赖）

### 2.6 Token 预算管理

#### 2.6.1 BudgetTracker 数据结构

```typescript
type BudgetTracker = {
  continuationCount: number      // 继续次数
  lastDeltaTokens: number        // 上次检查的 Token 增量
  lastGlobalTurnTokens: number   // 上次检查的全局轮次 Token 数
  startedAt: number              // 开始时间戳
}
```

#### 2.6.2 checkTokenBudget() 算法

```
输入: tracker, agentId, budget, globalTurnTokens

1. 前置检查：
   ├─ 子代理 → stop（子代理不受 Token 预算限制）
   └─ budget <= 0 → stop

2. 计算指标：
   pct = round(turnTokens / budget * 100)
   deltaSinceLastCheck = globalTurnTokens - tracker.lastGlobalTurnTokens

3. 边际收益判断：
   isDiminishing = continuationCount >= 3
                   AND deltaSinceLastCheck < 500
                   AND tracker.lastDeltaTokens < 500

4. 决策：
   ├─ 非边际收益 AND pct < 90% → continue（注入 nudge 消息）
   ├─ 边际收益 OR pct >= 90% → stop（记录 completionEvent）
   └─ 其他 → stop（null event，非预算原因）
```

**关键设计**：
- **双重停止条件**：百分比阈值（90%）+ 边际收益检测（连续 3 次增量 < 500 tokens）
- **渐进式提示**：每次 continue 产出 `nudgeMessage`，告知当前进度百分比
- **子代理排除**：子代理不受 Token 预算限制（避免嵌套预算管理复杂度）

### 2.7 依赖注入与测试解耦

```typescript
type QueryDeps = {
  callModel: typeof queryModelWithStreaming    // 模型调用
  microcompact: typeof microcompactMessages    // 微压缩
  autocompact: typeof autoCompactIfNeeded      // 自动压缩
  uuid: () => string                           // UUID 生成
}
```

**设计洞察**：
- 使用 `typeof fn` 保持签名自动同步（重构时不会遗漏）
- `productionDeps()` 返回真实实现
- 测试时注入 fake 替代 `spyOn-per-module` 样板代码
- 范围 intentionally narrow（仅 4 个依赖），先证明模式再扩展

### 2.8 Feature Gate 机制

| Feature Gate | 影响范围 | 控制方式 |
|-------------|----------|---------|
| `COORDINATOR_MODE` | Coordinator 上下文注入 | 环境变量 + feature() |
| `HISTORY_SNIP` | Snip 压缩 | feature() |
| `REACTIVE_COMPACT` | 响应式压缩 | feature() |
| `CONTEXT_COLLAPSE` | 上下文折叠 | feature() |
| `CACHED_MICROCOMPACT` | 缓存微压缩 | feature() |
| `TOKEN_BUDGET` | Token 预算管理 | feature() |
| `EXTRACT_MEMORIES` | 记忆提取 | feature() |
| `TEMPLATES` | 模板任务分类 | feature() |
| `CHICAGO_MCP` | Computer Use MCP 清理 | feature() |
| `BG_SESSIONS` | 后台会话摘要 | feature() |
| `EXPERIMENTAL_SKILL_SEARCH` | 技能发现预取 | feature() |
| `BREAK_CACHE_COMMAND` | 缓存破坏标记 | feature() |

**设计洞察**：通过 `feature()` 函数实现编译时死代码消除（Dead Code Elimination），不同构建产物包含不同功能。`require()` 延迟加载确保未启用的功能代码不会被打包。

### 2.9 停止钩子系统

#### 2.9.1 handleStopHooks() 四阶段流程

```
阶段一：后台任务（并行执行）
  ├─ 缓存安全参数保存
  ├─ 模板任务分类（TEMPLATES gate，60s 超时）
  ├─ 提示建议（executePromptSuggestion）
  ├─ 记忆提取（EXTRACT_MEMORIES gate）
  └─ Auto Dream（executeAutoDream）

阶段二：Chicago MCP 清理
  └─ cleanupComputerUseAfterTurn()（仅主线程）

阶段三：Stop 钩子执行
  ├─ executeStopHooks() — 执行用户定义的停止钩子
  ├─ 结果消费循环（progress/attachment/blockingError）
  └─ 摘要生成 + 错误通知

阶段四：Teammate 专用钩子
  ├─ TaskCompleted 钩子（遍历 in_progress 任务）
  └─ TeammateIdle 钩子
```

**关键设计**：
- 停止钩子在每次 Agentic Loop 结束时执行（无工具调用路径）
- 支持 `preventContinuation`（阻止继续）和 `blockingErrors`（注入错误后继续）
- 后台任务并行执行，不阻塞主流程
- 钩子执行异常不会阻止 Agent 继续运行（容错设计）

---

## 三、claude-code-sourcemap 的 React Context 系统

### 3.1 Context 使用模式分类

| 模式 | 文件 | 说明 |
|------|------|------|
| **直接值 Context** | QueuedMessageContext | Context 值为简单对象（isQueued/isFirst/paddingWidth） |
| **函数引用 Context** | fpsMetrics | Context 值为 getter 函数，避免高频更新重渲染 |
| **实例 Context** | mailbox, voice | Context 值为类实例（Mailbox, Store） |
| **尺寸注入 Context** | modalContext | Context 值为布局尺寸信息（rows/columns/scrollRef） |
| **Data/Setter 分离** | promptOverlayContext | 拆分为读/写两个 Context，避免写者重渲染 |
| **全局状态集成** | notifications, overlayContext | 直接操作 AppState（Zustand 风格） |
| **工厂+持久化** | stats | 工厂创建 + 进程退出时持久化 |

### 3.2 七种 Context 详解

#### 3.2.1 QueuedMessageContext — 消息队列

- **用途**：标记消息是否在队列中，控制内边距
- **Brief 模式适配**：`useBriefLayout` 为 true 时 padding 设为 0（避免双重缩进）

#### 3.2.2 fpsMetrics — FPS 指标

- **函数引用模式**：Context 存储 getter 函数而非数据值
- **避免重渲染风暴**：FPS 高频更新不会触发消费者重渲染

#### 3.2.3 mailbox — 邮箱系统

- **单例模式**：`useMemo(() => new Mailbox(), [])` 保证唯一实例
- **防御性编程**：不在 Provider 内时抛出明确错误

#### 3.2.4 modalContext — 模态框

- **智能回退**：`useModalOrTerminalSize()` 在模态框内用模态框尺寸，否则用终端尺寸
- **用途**：FullscreenLayout 渲染底部锚定面板时设置

#### 3.2.5 notifications — 通知系统

- **四级优先级**：immediate > high > medium > low
- **Fold/Reduce 模式**：同 key 通知可合并（类似 Redux reducer）
- **失效声明式**：通过 `invalidates` 数组声明依赖关系
- **immediate 特殊处理**：清除当前超时，立即显示

#### 3.2.6 overlayContext — 覆盖层追踪

- **RAII 模式**：mount 注册 + unmount 注销
- **Escape 键冲突解决**：覆盖层活跃时不取消正在进行的请求
- **模态/非模态区分**：`NON_MODAL_OVERLAYS` 白名单

#### 3.2.7 promptOverlayContext — 提示覆盖层

- **双通道架构**：DataContext（读）+ SetContext（写）分离
- **Portal 模式**：逃逸 Ink 的 `overflowY:hidden` 裁剪
- **自动清理**：unmount 时自动将值设为 null

#### 3.2.8 stats — 统计指标

- **四类指标原语**：Counter（计数器）、Gauge（仪表盘）、Timer/Histogram（直方图）、Set（集合）
- **水库采样**（Algorithm R）：固定 1024 大小的水库，均匀采样无限数据流
- **百分位数计算**：p50/p95/p99，线性插值
- **持久化**：进程退出时写入项目配置的 `lastSessionMetrics`

#### 3.2.9 voice — 语音状态

- **三态状态机**：idle → recording → processing → idle
- **三层访问 API**：
  - `useVoiceState(selector)` — 订阅状态切片（触发重渲染）
  - `useSetVoiceState()` — 设置状态（稳定引用，不触发重渲染）
  - `useGetVoiceState()` — 同步读取（不触发重渲染）

---

## 四、openclaw 的上下文引擎系统

### 4.1 整体架构：可插拔引擎架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    ContextEngine 接口                           │
│  (types.ts — 13 个方法)                                         │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────────┐  │
│  │ bootstrap│ maintain │ ingest   │ assemble │ compact      │  │
│  ├──────────┼──────────┼──────────┼──────────┼──────────────┤  │
│  │ingestBatch│afterTurn│prepare   │onSubagent│ dispose      │  │
│  │          │          │Subagent  │Ended     │              │  │
│  │          │          │Spawn     │          │              │  │
│  └──────────┴──────────┴──────────┴──────────┴──────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                    Registry（注册表）                            │
│  Symbol.for() 全局单例 + 工厂模式 + owner 隔离                   │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌──────────────────────────────────────┐ │
│  │ Legacy 引擎      │  │ 第三方引擎（插件注册）                │ │
│  │ (适配器模式)     │  │ (public-sdk owner)                   │ │
│  └────────┬────────┘  └──────────────┬───────────────────────┘ │
│           │                           │                         │
│  ┌────────▼───────────────────────────▼─────────────────────┐ │
│  │       delegate.ts（压缩委托桥接）                         │ │
│  │       + buildMemorySystemPromptAddition()                 │ │
│  └──────────────────────┬──────────────────────────────────┘ │
│                         │                                     │
│  ┌──────────────────────▼──────────────────────────────────┐ │
│  │  compact.ts（运行时压缩核心）                             │ │
│  │  ├─ 多阶段摘要（分块→部分摘要→合并）                     │ │
│  │  ├─ 自适应分块比例                                        │ │
│  │  ├─ 标识符保留策略                                        │ │
│  │  ├─ 历史修剪（迭代丢弃）                                 │ │
│  │  ├─ 工具结果截断（两级：单条+总量）                      │ │
│  │  ├─ 会话文件截断（原子写入）                              │ │
│  │  └─ 转录重写（Branch-and-Reappend）                      │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 ContextEngine 接口完整定义

```typescript
interface ContextEngine {
  readonly info: ContextEngineInfo;

  // 初始化（可选）
  bootstrap?(params): Promise<BootstrapResult>;

  // 维护（可选，bootstrap/成功轮次/压缩后）
  maintain?(params): Promise<ContextEngineMaintenanceResult>;

  // 摄入单条消息
  ingest(params): Promise<IngestResult>;

  // 批量摄入（可选）
  ingestBatch?(params): Promise<IngestBatchResult>;

  // 轮次后钩子（可选）
  afterTurn?(params): Promise<void>;

  // 核心：在 token 预算下组装模型上下文
  assemble(params): Promise<AssembleResult>;

  // 核心：压缩上下文
  compact(params): Promise<CompactResult>;

  // 子代理生命周期（可选）
  prepareSubagentSpawn?(params): Promise<SubagentSpawnPreparation | undefined>;
  onSubagentEnded?(params): Promise<void>;

  // 资源释放（可选）
  dispose?(): Promise<void>;
}
```

**关键设计洞察**：
- 13 个方法中仅 2 个是必需的（`ingest` + `assemble` + `compact`），其余均为可选
- `assemble` 返回 `AssembleResult`，包含 `messages`、`estimatedTokens`、`systemPromptAddition?`
- `compact` 返回 `CompactResult`，包含 `ok`、`compacted`、`reason?`、`result?`（含 before/after tokens）
- 引擎通过 `runtimeContext.rewriteTranscriptEntries` 注入安全转录重写能力（控制反转）

### 4.3 引擎注册表设计

#### 4.3.1 全局单例

```typescript
// 使用 Symbol.for() 实现跨 chunk 共享
type ContextEngineRegistryState = {
  engines: Map<string, { factory: ContextEngineFactory; owner: string }>;
};
```

#### 4.3.2 Owner 隔离机制

```
注册 API：
├─ registerContextEngineForOwner(id, factory, owner, opts?)
│   └─ 核心注册入口，支持 owner 隔离
├─ registerContextEngine(id, factory)
│   └─ 第三方 SDK 入口（owner = "public-sdk"）
├─ getContextEngineFactory(id)
│   └─ 获取已注册的工厂函数
└─ listContextEngineIds()
    └─ 列出所有已注册引擎 ID

安全规则：
├─ 默认 slot（contextEngine）只能由 "core" owner 注册
├─ 不同 owner 不能覆盖彼此的注册
├─ 同一 owner 可通过 allowSameOwnerRefresh: true 刷新
└─ public-sdk 路径无法伪造 owner 身份
```

#### 4.3.3 解析流程

```
1. 读取 config.plugins.slots.contextEngine（显式 slot 覆盖）
2. 回退到 defaultSlotIdForKey("contextEngine") → "legacy"
3. 在注册表中查找对应 factory
4. 调用 factory() 创建引擎实例
5. 用 wrapContextEngineWithSessionKeyCompat() 包装 → 返回
```

#### 4.3.4 Legacy SessionKey 兼容层

**设计模式**：自适应代理模式（Adaptive Proxy Pattern）

```typescript
const proxy = new Proxy(engine, {
  get(target, property) {
    if (isSessionKeyCompatMethodName(property)) {
      return (params) => invokeWithLegacyCompat(
        value.bind(target), params, allowedKeys,
        { onLegacyModeDetected: () => { isLegacy = true; } }
      );
    }
  }
});
```

- 首次调用时检测引擎是否接受 `sessionKey`/`prompt` 参数
- 如果引擎抛出验证错误，自动移除不支持的参数
- **记忆化**：一旦检测到引擎不接受某个 key，后续直接跳过
- 通过正则匹配多种验证错误格式（Zod/JSON Schema/自定义）

### 4.4 LegacyContextEngine — 适配器模式

```typescript
class LegacyContextEngine implements ContextEngine {
  async ingest() { return { ingested: false }; }       // 空操作
  async assemble(params) {                               // 透传
    return { messages: params.messages, estimatedTokens: 0 };
  }
  async compact(params) {                                // 委托
    return await delegateCompactionToRuntime(params);
  }
}
```

**设计洞察**：Legacy 引擎将已有压缩行为包装为 ContextEngine 接口，实现 100% 向后兼容。`assemble` 是透传（实际消息处理在 `attempt.ts` 的 `sanitize→validate→limit→repair` 管线中），`compact` 委托给运行时标准路径。

### 4.5 压缩系统详解

#### 4.5.1 核心常量

```typescript
const BASE_CHUNK_RATIO = 0.4;           // 基础分块比例
const MIN_CHUNK_RATIO = 0.15;           // 最小分块比例
const SAFETY_MARGIN = 1.2;              // 20% 安全余量
const SUMMARIZATION_OVERHEAD_TOKENS = 4096;  // 摘要开销预留
```

#### 4.5.2 消息分块算法

**splitMessagesByTokenShare(messages, parts=2)**

```
1. totalTokens = estimateMessagesTokens(messages)
2. targetTokens = totalTokens / parts
3. 遍历消息：
   a. 无待处理 tool_call 且当前块超 targetTokens → 切分
   b. 遇到 assistant tool_call → 标记 pendingToolCallIds
   c. 遇到 toolResult → 匹配并清除 pendingToolCallIds
   d. 所有 tool_call 完成且超限 → 在 pendingChunkStartIndex 处切分
```

**关键设计**：使用 `pendingChunkStartIndex` 确保切分点在 tool_use 消息之前，避免 tool_use 和 tool_result 被分到不同块。

**自适应分块比例**：

```typescript
function computeAdaptiveChunkRatio(messages, contextWindow): number {
  avgRatio = (avgTokens * SAFETY_MARGIN) / contextWindow;
  if (avgRatio > 0.1) {
    reduction = min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }
  return BASE_CHUNK_RATIO;
}
```

当平均消息大小超过上下文窗口 10% 时，动态缩小分块比例。

#### 4.5.3 多阶段摘要

```
summarizeInStages(messages, maxChunkTokens, summarizationModel)
  │
  ├─ 消息数 < minMessagesForSplit 或 token <= maxChunkTokens
  │   └─ 直接 summarizeWithFallback
  │
  └─ 多阶段路径：
      1. splitMessagesByTokenShare 分成 N 份
      2. 对每份独立 summarizeWithFallback → partialSummaries[]
      3. 将 partialSummaries 包装为 user 消息
      4. 使用 MERGE_SUMMARIES_INSTRUCTIONS 合并所有部分摘要
```

**summarizeWithFallback 渐进降级**：

```
1. 尝试完整摘要 summarizeChunks
2. 失败 → 分离超大消息，仅摘要小消息 + 附加超大消息注释
3. 再失败 → 返回 "Context contained N messages. Summary unavailable."
```

**摘要保留策略**（MERGE_SUMMARIES_INSTRUCTIONS）：
- 活跃任务及状态
- 批量操作进度
- 用户最后的请求
- 已做决策及理由
- TODO、开放问题、约束
- 承诺和后续事项

#### 4.5.4 标识符保留策略

```typescript
type CompactionSummarizationInstructions = {
  identifierPolicy?: "strict" | "off" | "custom";
  identifierInstructions?: string;
};
```

- `strict`（默认）：保留所有 UUID、hash、ID、token、API key、hostname、IP、port、URL、文件名
- `off`：不保留
- `custom`：自定义指令

#### 4.5.5 历史修剪

```
pruneHistoryForContextShare(messages, maxContextTokens, maxHistoryShare=0.5)
  │
  ├─ budgetTokens = maxContextTokens * maxHistoryShare
  │
  └─ while (estimateTokens(kept) > budget):
      ├─ splitMessagesByTokenShare(kept, parts) → [dropped, ...rest]
      ├─ repairToolUseResultPairing(rest) → 修复孤立的 tool_result
      └─ kept = repairedRest
```

**关键**：每次丢弃后调用 `repairToolUseResultPairing` 清理孤立的 tool_result，防止 API 报 "unexpected tool_use_id" 错误。

#### 4.5.6 工具结果截断

```
两级截断策略：

Level 1: 单条超限截断
  MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3  (单条最多占上下文 30%)
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS = 40,000
  MIN_KEEP_CHARS = 2,000
  ├─ 检测尾部是否包含重要内容（错误/异常/JSON/摘要）
  ├─ 重要 → 头部 70% + 尾部 30%，中间插入省略标记
  └─ 不重要 → 仅保留头部

Level 2: 总量超限截断
  ├─ 按时间倒序排列
  └─ 贪心分配减少预算
```

**智能尾部检测**：

```typescript
function hasImportantTail(text: string): boolean {
  const tail = text.slice(-2000).toLowerCase();
  return /\b(error|exception|failed|fatal|traceback|panic)\b/.test(tail)
      || /\}\s*$/.test(tail.trim())  // JSON 闭合
      || /\b(total|summary|result|complete|finished)\b/.test(tail);
}
```

#### 4.5.7 会话文件截断

**目的**：解决多次压缩后 JSONL 文件无限增长的问题。

**保留策略**：
1. Session header
2. 所有非消息状态（custom/model_change/compaction 等）
3. 兄弟分支的所有条目
4. 未摘要尾部（`firstKeptEntryId` 之后的所有条目）

**移除策略**：
1. 当前分支中 `firstKeptEntryId` 之前的 message 类型条目
2. 引用已移除消息 ID 的 label/branch_summary 条目
3. 心跳消息对

**重亲本（Re-parenting）**：被移除条目的子节点重新挂载到最近的未移除祖先下。

**原子写入**：temp + rename 模式确保文件写入安全。

#### 4.5.8 转录重写

**算法**：Branch-and-Reappend

```
1. 在第一个被重写消息的 parentId 处创建分支
2. 从该点开始重新追加所有后续条目
3. 被重写的消息使用新内容，其余原样追加
4. 维护 rewrittenEntryIds 映射（旧 ID → 新 ID）
5. compaction/branch_summary 的引用 ID 通过 remapEntryId 更新
```

### 4.6 运行时压缩流程

```
compactEmbeddedPiSessionDirect()
  │
  ├─ 1. 解析压缩目标模型（支持独立配置 compaction.model）
  ├─ 2. 模型解析与认证
  ├─ 3. 上下文窗口计算（应用全局上限）
  ├─ 4. 工具创建
  ├─ 5. 系统提示词构建
  ├─ 6. 会话加载与修复
  ├─ 7. 上下文引擎集成
  │   ├─ ensureContextEnginesInitialized()
  │   ├─ resolveContextEngine(config)
  │   ├─ 引擎 ownsCompaction → 引擎自行处理
  │   └─ 否则 → 运行时标准压缩路径
  ├─ 8. 压缩执行（compactWithSafetyTimeout，默认 15 分钟）
  └─ 9. 压缩后处理
      ├─ truncateSessionAfterCompaction（文件截断）
      ├─ runContextEngineMaintenance（引擎维护）
      └─ runPostCompactionSideEffects（transcript 更新 + memory sync）
```

### 4.7 上下文窗口管理

#### 4.7.1 多级回退查找链

```
resolveContextTokensForModel(provider, model, cfg)
  │
  ├─ 1. contextTokensOverride（显式覆盖）
  ├─ 2. config.agents.defaults.models["provider/model"].params.context1m → 1,048,576
  ├─ 3. config.models.providers[provider].models[].contextTokens
  ├─ 4. qualified cache key: "provider/model"
  ├─ 5. bare cache key: "model"
  └─ 6. fallbackContextTokens（默认 200,000）
```

#### 4.7.2 上下文窗口守卫

```typescript
const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

evaluateContextWindowGuard(tokens):
  ├─ tokens < 16K → shouldBlock: true
  ├─ tokens < 32K → shouldWarn: true
  └─ tokens >= 32K → 正常
```

### 4.8 快速模式

```
resolveFastModeState() — 四层优先级：
  1. session 级覆盖（最高优先级）
  2. Agent 默认值（fastModeDefault）
  3. 模型配置值（agents.defaults.models[...].params.fastMode）
  4. 默认值 false
```

返回 `FastModeState` 包含 `source` 字段，便于调试追踪。

---

## 五、双项目对比分析

### 5.1 查询引擎架构对比

| 维度 | claude-code-sourcemap | openclaw |
|------|----------------------|----------|
| **引擎设计** | `QueryEngine` 类（单体、有状态） | `pi-embedded-runner`（模块化、可组合） |
| **核心循环** | `query()` AsyncGenerator + while(true) | `attempt.ts` sanitize→validate→limit→repair 管线 |
| **状态管理** | `State` 对象 + 解构/重建 | SessionManager + JSONL 文件 |
| **依赖注入** | `QueryDeps`（4 个依赖） | `ContextEngineRuntimeContext`（IoC） |
| **模型回退** | `FallbackTriggeredError` → 切换 fallbackModel | `model-fallback.ts` 责任链（第 2 轮已分析） |
| **流式输出** | AsyncGenerator + yield* 嵌套 | 流式传输 + 增量事件推送 |
| **中断处理** | AbortController + 合成 tool_result | 双层取消（超时 + AbortSignal） |

### 5.2 上下文管理架构对比

| 维度 | claude-code-sourcemap | openclaw |
|------|----------------------|----------|
| **架构模式** | 固定实现（内置） | 可插拔引擎（ContextEngine 接口） |
| **注册机制** | 无 | Symbol.for() 全局注册表 + 工厂模式 + owner 隔离 |
| **Legacy 兼容** | N/A | 自适应代理模式（Proxy 自动检测参数支持） |
| **压缩触发** | 三级递进（Micro → Auto → Reactive） | 多种触发（auto/overflow/manual/timeout） |
| **压缩模型** | 使用同一模型 | 支持独立配置（`compaction.model`） |
| **摘要策略** | 单次摘要 | 多阶段（分块→部分摘要→合并）+ 渐进降级 |
| **Tool Result 处理** | maxResultSizeChars（每工具独立） | 两级截断（单条超限 + 总量超限）+ 智能尾部保留 |
| **Session 文件** | 持续增长 | 压缩后自动截断（truncateSessionAfterCompaction） |
| **转录维护** | 无 | 引擎可请求 branch-and-reappend 安全重写 |
| **子代理感知** | 无 | prepareSubagentSpawn / onSubagentEnded 生命周期钩子 |
| **Prompt Cache** | 基础支持 | 完整可观测性（retention/usage/observation/expiry） |

### 5.3 System Prompt 构建对比

| 维度 | claude-code-sourcemap | openclaw |
|------|----------------------|----------|
| **构建方式** | 运行时拼接（6 层） | 引擎驱动（assemble 返回 systemPromptAddition） |
| **缓存策略** | lodash memoize（会话级） | 引擎自行决定 |
| **工具描述** | 每工具 `prompt()` 方法 + `description()` 方法 | 工具列表通过 `buildSystemInitMessage` 组装 |
| **CLAUDE.md** | getUserContext() 加载 | 引擎 assemble 或系统提示词构建器 |
| **动态更新** | setSystemPromptInjection() 清除缓存 | 引擎 maintain() 周期性维护 |
| **记忆注入** | memdir 语义检索（Sonnet sideQuery） | memory-host-sdk 向量检索 + buildMemorySystemPromptAddition |

### 5.4 错误恢复策略对比

| 错误类型 | claude-code-sourcemap | openclaw |
|----------|----------------------|----------|
| **Prompt Too Long** | 上下文折叠 drain → 响应式压缩 → 表面错误 | 自适应分块 + 历史修剪 + 渐进降级 |
| **max_output_tokens** | 升级到 64k → 多轮恢复（最多 3 次） | 无显式处理 |
| **模型过载** | FallbackTriggeredError → 切换回退模型 | 模型故障转移链（第 2 轮已分析） |
| **压缩失败** | 断路器（consecutiveFailures） | 渐进降级（完整→分离→失败兜底） |
| **工具结果过大** | maxResultSizeChars → 持久化到磁盘 | 两级截断 + 会话内持久化截断 |
| **中断** | 合成 tool_result + yield 中断消息 | 双层取消（超时 + AbortSignal） |

### 5.5 Token 预算管理对比

| 维度 | claude-code-sourcemap | openclaw |
|------|----------------------|----------|
| **预算类型** | Token 数量 + USD 金额 | 上下文窗口比例 |
| **停止条件** | 90% 阈值 + 边际收益检测 | 上下文窗口守卫（16K 硬限制 / 32K 警告） |
| **边际收益** | 连续 3 次增量 < 500 tokens | 无 |
| **子代理** | 不受限制 | 不受限制 |
| **进度提示** | nudgeMessage（百分比进度） | 无 |

---

## 六、通用设计模式提炼

### 6.1 可直接复用的模式

#### 模式 1：AsyncGenerator Agentic Loop（claude-code）

```
适用场景：需要实现"模型推理 → 工具执行 → 结果反馈 → 继续推理"的迭代循环
实现方式：while(true) + AsyncGenerator + yield + State 对象
优势：线性表达复杂控制流，支持流式输出，状态在迭代间清晰传递
```

#### 模式 2：Continue/Terminal 类型体系（claude-code）

```
适用场景：循环需要多种退出条件和多种恢复策略
实现方式：Continue（7 种变体）+ Terminal（10 种原因）联合类型
优势：结构化控制流，避免 goto 和标志位，每种恢复策略有明确的类型签名
```

#### 模式 3：可插拔上下文引擎（openclaw）

```
适用场景：需要支持多种上下文管理策略并可运行时切换
实现方式：ContextEngine 接口 + 注册表 + 工厂模式 + owner 隔离
优势：插件化扩展，零配置可用（Legacy 兜底），第三方可通过 public-sdk 注册
```

#### 模式 4：自适应代理兼容层（openclaw）

```
适用场景：接口演进时需要同时支持新旧实现
实现方式：Proxy 包装 + 首次调用检测 + 记忆化
优势：无侵入兼容，旧实现无需修改，新实现自动启用完整功能
```

#### 模式 5：多阶段摘要 + 渐进降级（openclaw）

```
适用场景：需要对大量上下文进行高质量压缩
实现方式：分块→部分摘要→合并 + 完整→分离→失败兜底
优势：处理任意大小的上下文，保证至少返回有意义的摘要
```

#### 模式 6：两级工具结果截断（openclaw）

```
适用场景：需要控制工具结果对上下文的占用
实现方式：单条超限截断（30% 上下文）+ 总量超限截断 + 智能尾部保留
优势：既防止单条结果霸占上下文，又防止总体膨胀
```

#### 模式 7：System Prompt 分层架构（claude-code）

```
适用场景：需要将多个来源的提示词组合为最终系统提示
实现方式：6 层拼接（核心→记忆→追加→系统上下文→用户上下文→初始化消息）
优势：每层职责清晰，用户可定制层不影响核心行为，运行时层动态更新
```

#### 模式 8：Token 预算双重停止（claude-code）

```
适用场景：需要控制 Agent 的 Token 消耗
实现方式：90% 百分比阈值 + 连续 3 次边际收益 < 500 tokens
优势：既防止单次消耗过多，又防止无效的持续消耗
```

#### 模式 9：Data/Setter Context 分离（claude-code）

```
适用场景：React Context 中写入者不应因自己的写入而重渲染
实现方式：拆分为 DataContext（读）和 SetContext（写），setter 引用稳定
优势：避免写入-重渲染-写入的无限循环
```

#### 模式 10：水库采样统计（claude-code）

```
适用场景：需要对无限数据流计算近似分位数
实现方式：Vitter's Algorithm R，固定 1024 大小水库
优势：固定内存，均匀采样，支持 p50/p95/p99 百分位数计算
```

### 6.2 需要适配的设计

| 设计 | 来源 | 适配建议 |
|------|------|---------|
| lodash memoize 缓存 | claude-code | 会话级缓存适合 CLI 场景，长运行服务需要 TTL |
| React Context 状态共享 | claude-code | 与 React/Ink 耦合，非 React 场景需替代方案 |
| Symbol.for() 全局注册表 | openclaw | 适用于 Node.js 单进程，分布式需外部注册中心 |
| JSONL Session 文件 | openclaw | 适用于单机场景，分布式需替换为数据库 |
| Branch-and-Reappend | openclaw | 与 JSONL DAG 结构耦合 |

---

## 七、为后续轮次准备的关键发现

### 7.1 第 5 轮（进化/自优化）应关注的问题

1. **claude-code 的三级压缩（Micro → Auto → Reactive）与 openclaw 的多阶段摘要，哪种信息保留率更高？** 需要对比压缩前后的信息完整性
2. **openclaw 的标识符保留策略（strict/off/custom）是否可以应用于 claude-code 的压缩？** 防止压缩丢失关键 ID
3. **claude-code 的 stopHooks 后台任务（记忆提取、Auto Dream、模板分类）是否构成一种"进化"机制？** 每轮结束时的自动知识提取
4. **openclaw 的会话文件截断（truncateSessionAfterCompaction）是否解决了 claude-code 的"Session 文件持续增长"问题？**

### 7.2 第 6 轮（通信协议）应关注的问题

1. **claude-code 的 `systemPromptInjection` 缓存失效机制是否可以作为一种轻量级"配置热更新"？** 修改注入值立即清除所有缓存
2. **openclaw 的 `ContextEngineRuntimeContext.rewriteTranscriptEntries` 控制反转模式是否可以推广到其他需要跨模块协作的场景？**

### 7.3 第 7 轮（服务层与状态管理）应关注的问题

1. **claude-code 的 stats 水库采样（进程退出持久化）与 openclaw 的配置系统（实时持久化），哪种更适合 Agent 的运行指标收集？**
2. **openclaw 的上下文窗口守卫（16K 硬限制 / 32K 警告）是否可以作为通用的 Agent 安全机制？**

---

## 八、高价值代码片段索引

| 片段 | 文件 | 参考价值 | → 代码片段文档 |
|------|------|---------|---------------|
| QueryEngine 完整接口（30+ 配置项） | `QueryEngine.ts` `QueryEngineConfig` | 依赖注入设计范本 | → [代码片段_Agent核心循环与编排](代码片段_Agent核心循环与编排.md) #3 |
| submitMessage() 六阶段流程 | `QueryEngine.ts` `submitMessage()` | 会话级查询引擎实现 | → [代码片段_Agent核心循环与编排](代码片段_Agent核心循环与编排.md) #4 |
| Agentic Loop 完整循环（8 步） | `query.ts` `queryLoop()` | Agent 核心循环实现 | → [代码片段_Agent核心循环与编排](代码片段_Agent核心循环与编排.md) #1 |
| Continue/Terminal 类型体系 | `query.ts` `State` + `Continue` + `Terminal` | 结构化控制流设计 | → [代码片段_Agent核心循环与编排](代码片段_Agent核心循环与编排.md) #2 |
| 7 种错误恢复策略 | `query.ts` 步骤 6 | 错误恢复策略大全 | → [代码片段_Agent核心循环与编排](代码片段_Agent核心循环与编排.md) #1（合并） |
| System Prompt 6 层拼接 | `QueryEngine.ts` 阶段一 | Prompt 分层架构范本 | → [代码片段_Agent核心循环与编排](代码片段_Agent核心循环与编排.md) #4（合并） |
| 上下文组装管道（7 步） | `query.ts` 步骤 1 | 上下文窗口管理策略 | → [代码片段_Agent核心循环与编排](代码片段_Agent核心循环与编排.md) #1（合并） |
| Token 预算双重停止 | `tokenBudget.ts` `checkTokenBudget()` | Token 消耗控制 | → [代码片段_工具系统与安全](代码片段_工具系统与安全.md) #9 |
| Feature Gate 条件编译 | `query.ts` + `config.ts` | 编译时功能开关 | → [代码片段_状态管理与插件扩展](代码片段_状态管理与插件扩展.md) #49 |
| 停止钩子四阶段流程 | `stopHooks.ts` `handleStopHooks()` | Agent 生命周期钩子 | → [代码片段_工具系统与安全](代码片段_工具系统与安全.md) #10 |
| 上下文缓存策略 | `context.ts` `getSystemContext/getUserContext` | 会话级缓存设计 | → [代码片段_上下文记忆与通信协议](代码片段_上下文记忆与通信协议.md) #31 |
| ContextEngine 接口（13 方法） | `context-engine/types.ts` | 可插拔引擎接口范本 | → [代码片段_状态管理与插件扩展](代码片段_状态管理与插件扩展.md) #7 |
| 引擎注册表 + owner 隔离 | `context-engine/registry.ts` | 插件注册表设计 | → [代码片段_状态管理与插件扩展](代码片段_状态管理与插件扩展.md) #8 |
| 自适应代理兼容层 | `context-engine/registry.ts` `wrapContextEngineWithSessionKeyCompat()` | 接口演进兼容方案 | → [代码片段_状态管理与插件扩展](代码片段_状态管理与插件扩展.md) #8（合并） |
| 多阶段摘要算法 | `compaction.ts` `summarizeInStages()` | 大上下文压缩策略 | → [代码片段_状态管理与插件扩展](代码片段_状态管理与插件扩展.md) #9 |
| 自适应分块比例 | `compaction.ts` `computeAdaptiveChunkRatio()` | 动态分块算法 | → [代码片段_状态管理与插件扩展](代码片段_状态管理与插件扩展.md) #10 |
| 两级工具结果截断 | `tool-result-truncation.ts` | 上下文预算管理 | → [代码片段_状态管理与插件扩展](代码片段_状态管理与插件扩展.md) #14 |
| 会话文件截断 | `session-truncation.ts` | Session 文件生命周期管理 | → [代码片段_工具系统与安全](代码片段_工具系统与安全.md) #19 |
| 转录重写（Branch-and-Reappend） | `transcript-rewrite.ts` | 安全的 JSONL 修改 | → [代码片段_工具系统与安全](代码片段_工具系统与安全.md) #20 |
| 上下文窗口守卫 | `context-window-guard.ts` | 上下文安全检查 | → [代码片段_状态管理与插件扩展](代码片段_状态管理与插件扩展.md) #15 |
| Data/Setter Context 分离 | `promptOverlayContext.tsx` | React 性能优化模式 | → [代码片段_状态管理与插件扩展](代码片段_状态管理与插件扩展.md) #50 |
| 水库采样统计 | `stats.tsx` `observe()` | 流式数据近似统计 | → [代码片段_状态管理与插件扩展](代码片段_状态管理与插件扩展.md) #51 |
| 通知优先级队列 | `notifications.tsx` `getNext()` + `addNotification()` | 优先级队列 + Fold 合并 | → [代码片段_状态管理与插件扩展](代码片段_状态管理与插件扩展.md) #52 |
