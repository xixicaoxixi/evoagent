# 代码片段参考文档 — Agent 核心循环与编排

> 本文档整合了 claude-code 项目中 Agentic Loop 和 Agent 编排相关的所有关键代码片段。
> 来源项目：claude-code（Anthropic Claude Code CLI）

---

## 使用指南

本文档按功能模块组织，涵盖以下核心领域：

1. **Agentic Loop 核心** — 查询循环主引擎、终止/继续类型、引擎配置
2. **消息提交** — 用户消息入口、系统提示词构建、预算检查
3. **工具接口** — Tool 泛型接口、工厂函数、默认值策略
4. **Agent 编排** — Coordinator 系统提示词、策略路由、Fork 消息构建
5. **工具过滤** — 子 Agent 工具过滤管道、异步生命周期管理

**快速检索方式**：
- 通过总览表格按编号/名称定位片段
- 通过源文件路径在 IDE 中跳转到原始代码
- 按功能关键词（如 "queryLoop"、"Fork"、"filterTools"）搜索

---

## 总览表格

| 编号 | 片段名称 | 来源项目 | 源文件路径 |
|------|----------|----------|------------|
| 1 | `queryLoop` 函数 — Agentic Loop 主循环 | claude-code | `src/query.ts` (L241-1728) |
| 2 | `Continue` 和 `Terminal` 类型定义 | claude-code | `src/query/transitions.ts` (推断) |
| 3 | `QueryEngineConfig` 接口定义 | claude-code | `src/QueryEngine.ts` (L130-173) |
| 4 | `submitMessage` 方法 | claude-code | `src/QueryEngine.ts` (L209-1156) |
| 5 | `Tool<I,O,P>` 接口定义 | claude-code | `src/Tool.ts` (L362-695) |
| 6 | `buildTool()` 函数 | claude-code | `src/Tool.ts` (L757-792) |
| 7 | `getCoordinatorSystemPrompt()` 函数 | claude-code | `src/coordinator/coordinatorMode.ts` (L111-369) |
| 8 | `call()` 方法中的策略路由分支 | claude-code | `src/tools/AgentTool/AgentTool.tsx` (L239-437) |
| 9 | `buildForkedMessages()` 函数 | claude-code | `src/tools/AgentTool/forkSubagent.ts` (L107-169) |
| 10 | `filterToolsForAgent()` 函数 | claude-code | `src/tools/AgentTool/agentToolUtils.ts` (L70-116) |
| 11 | `runAsyncAgentLifecycle()` 函数 | claude-code | `src/tools/AgentTool/agentToolUtils.ts` (L508-686) |
| 12 | `selectAgentHarness()` — Harness 选择策略 + 兜底 | openclaw | `agents/harness/selection.ts` (L45-106) |
| 13 | `runWithModelFallback()` — 模型故障转移链 | openclaw | `agents/model-fallback.ts` (L626-902) |

**片段总数**: 13

---

# Claude-Code 关键代码片段提取

---

## 第一组：Agentic Loop 核心

---

### 1. `queryLoop` 函数 — Agentic Loop 主循环

**来源文件**: `/workspace/claude-code-sourcemap/restored-src/src/query.ts`
**行号范围**: 第 241–1728 行

**说明**: 这是 Claude Code 的核心 Agentic Loop。它是一个 `async function*` 异步生成器，通过 `while(true)` 无限循环驱动"模型推理 -> 工具调用 -> 结果回传 -> 再次推理"的循环。每次迭代执行以下步骤：

1. **上下文准备**: snip 压缩、microcompact、context collapse、autocompact
2. **模型调用**: 通过 `deps.callModel()` 流式调用 Claude API，收集 `tool_use` 块
3. **工具执行**: 通过 `runTools()` 或 `StreamingToolExecutor` 并行执行工具
4. **结果聚合**: 收集工具结果、附件消息、内存预取、技能发现
5. **循环控制**: 检查 maxTurns、token budget、abort 信号等退出条件

关键状态通过 `State` 类型在迭代间传递，`continue` 语句配合 `state = { ... }` 实现迭代间状态更新。

```typescript
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  // Immutable params — never reassigned during the query loop.
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
    skipCacheWrite,
  } = params
  const deps = params.deps ?? productionDeps()

  // Mutable cross-iteration state. The loop body destructures this at the top
  // of each iteration so reads stay bare-name (`messages`, `toolUseContext`).
  // Continue sites write `state = { ... }` instead of 9 separate assignments.
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }
  const budgetTracker = feature('TOKEN_BUDGET') ? createBudgetTracker() : null

  let taskBudgetRemaining: number | undefined = undefined
  const config = buildQueryConfig()

  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
    } = state

    const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
      null,
      messages,
      toolUseContext,
    )

    yield { type: 'stream_request_start' }

    // ... [上下文准备阶段: snip, microcompact, context collapse, autocompact] ...

    const assistantMessages: AssistantMessage[] = []
    const toolResults: (UserMessage | AttachmentMessage)[] = []
    const toolUseBlocks: ToolUseBlock[] = []
    let needsFollowUp = false

    // ... [模型流式调用: deps.callModel()] ...

    // while(attemptWithFallback) 循环处理模型回退
    try {
      while (attemptWithFallback) {
        attemptWithFallback = false
        try {
          for await (const message of deps.callModel({ ... })) {
            // 处理流式消息: backfill、withhold、yield
            if (message.type === 'assistant') {
              assistantMessages.push(message)
              // 收集 tool_use 块
              const msgToolUseBlocks = message.message.content.filter(
                content => content.type === 'tool_use',
              ) as ToolUseBlock[]
              if (msgToolUseBlocks.length > 0) {
                toolUseBlocks.push(...msgToolUseBlocks)
                needsFollowUp = true
              }
            }
          }
        } catch (innerError) {
          if (innerError instanceof FallbackTriggeredError && fallbackModel) {
            currentModel = fallbackModel
            attemptWithFallback = true
            // 清理并重试
            continue
          }
          throw innerError
        }
      }
    } catch (error) {
      // 错误处理: yield 缺失的 tool_result、API 错误消息
      return { reason: 'model_error', error }
    }

    // 中止检查
    if (toolUseContext.abortController.signal.aborted) {
      return { reason: 'aborted_streaming' }
    }

    // 无需 follow-up 时: 检查 stop hooks、token budget、返回 completed
    if (!needsFollowUp) {
      // ... [stop hooks, token budget 检查] ...
      return { reason: 'completed' }
    }

    // 工具执行阶段
    const toolUpdates = streamingToolExecutor
      ? streamingToolExecutor.getRemainingResults()
      : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message
        toolResults.push(...)
      }
      if (update.newContext) {
        updatedToolUseContext = { ...update.newContext, queryTracking }
      }
    }

    // 附件消息、内存预取、技能发现注入
    // ...

    // maxTurns 检查
    if (maxTurns && nextTurnCount > maxTurns) {
      yield createAttachmentMessage({ type: 'max_turns_reached', maxTurns, turnCount: nextTurnCount })
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    // 更新状态，进入下一轮循环
    const next: State = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
    }
    state = next
  } // while (true)
}
```

---

### 2. `Continue` 和 `Terminal` 类型定义

**来源文件**: `/workspace/claude-code-sourcemap/restored-src/src/query/transitions.ts` **(文件不存在于 sourcemap 中)**

**说明**: 这两个类型从 `./query/transitions.js` 导入（第 104 行），但该文件在 sourcemap 恢复的源码中缺失。根据 `query.ts` 中的用法可以推断：

- **`Terminal`**: 是 `queryLoop` 生成器的 `return` 类型，表示循环终止原因。从代码中可见的返回值包括: `{ reason: 'completed' }`, `{ reason: 'aborted_streaming' }`, `{ reason: 'aborted_tools' }`, `{ reason: 'max_turns', turnCount }`, `{ reason: 'model_error', error }`, `{ reason: 'blocking_limit' }`, `{ reason: 'prompt_too_long' }`, `{ reason: 'image_error' }`, `{ reason: 'stop_hook_prevented' }`, `{ reason: 'hook_stopped' }` 等。

- **`Continue`**: 是 `State.transition` 字段的类型，记录上一轮循环为何继续。从代码中可见的值包括: `{ reason: 'next_turn' }`, `{ reason: 'reactive_compact_retry' }`, `{ reason: 'collapse_drain_retry', committed }`, `{ reason: 'max_output_tokens_recovery', attempt }`, `{ reason: 'max_output_tokens_escalate' }`, `{ reason: 'stop_hook_blocking' }`, `{ reason: 'token_budget_continuation' }` 等。

**推断的类型形状**:
```typescript
type Terminal =
  | { reason: 'completed' }
  | { reason: 'aborted_streaming' }
  | { reason: 'aborted_tools' }
  | { reason: 'max_turns'; turnCount: number }
  | { reason: 'model_error'; error: unknown }
  | { reason: 'blocking_limit' }
  | { reason: 'prompt_too_long' }
  | { reason: 'image_error' }
  | { reason: 'stop_hook_prevented' }
  | { reason: 'hook_stopped' }

type Continue =
  | { reason: 'next_turn' }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'collapse_drain_retry'; committed: number }
  | { reason: 'max_output_tokens_recovery'; attempt: number }
  | { reason: 'max_output_tokens_escalate' }
  | { reason: 'stop_hook_blocking' }
  | { reason: 'token_budget_continuation' }
```

---

### 3. `QueryEngineConfig` 接口定义

**来源文件**: `/workspace/claude-code-sourcemap/restored-src/src/QueryEngine.ts`
**行号范围**: 第 130–173 行

**说明**: QueryEngine 的配置接口，定义了单次对话会话所需的全部依赖。包括工作目录、工具集、MCP 客户端、Agent 定义、权限回调、系统提示词、模型配置、预算限制等。`snipReplay` 是一个可选的 snip 边界处理回调，用于在长会话中裁剪历史消息以控制内存。

```typescript
export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  replayUserMessages?: boolean
  /** Handler for URL elicitations triggered by MCP tool -32042 errors. */
  handleElicitation?: ToolUseContext['handleElicitation']
  includePartialMessages?: boolean
  setSDKStatus?: (status: SDKStatus) => void
  abortController?: AbortController
  orphanedPermission?: OrphanedPermission
  /**
   * Snip-boundary handler: receives each yielded system message plus the
   * current mutableMessages store. Returns undefined if the message is not a
   * snip boundary; otherwise returns the replayed snip result.
   */
  snipReplay?: (
    yieldedSystemMsg: Message,
    store: Message[],
  ) => { messages: Message[]; executed: boolean } | undefined
}
```

---

### 4. `submitMessage` 方法

**来源文件**: `/workspace/claude-code-sourcemap/restored-src/src/QueryEngine.ts`
**行号范围**: 第 209–1156 行

**说明**: QueryEngine 类的核心方法，是一个 `async *` 异步生成器。每次调用代表用户提交一条消息，启动一个新的 turn。它负责：

1. **初始化**: 包装 `canUseTool` 以追踪权限拒绝、获取系统提示词、构建 `ProcessUserInputContext`
2. **用户输入处理**: 通过 `processUserInput()` 处理斜杠命令、附件等
3. **会话持久化**: 在进入查询循环前写入 transcript
4. **查询循环**: 调用 `query()` 驱动 Agentic Loop，通过 `for await` 消费生成器输出
5. **消息分发**: 根据 `message.type`（assistant/user/progress/attachment/stream_event/system）分别处理，yield SDK 消息
6. **预算检查**: 每轮检查 USD 预算和结构化输出重试限制
7. **结果返回**: 循环结束后 yield 最终 `result` 消息（success/error）

```typescript
async *submitMessage(
  prompt: string | ContentBlockParam[],
  options?: { uuid?: string; isMeta?: boolean },
): AsyncGenerator<SDKMessage, void, unknown> {
  const {
    cwd, commands, tools, mcpClients, verbose = false,
    thinkingConfig, maxTurns, maxBudgetUsd, taskBudget,
    canUseTool, customSystemPrompt, appendSystemPrompt,
    userSpecifiedModel, fallbackModel, jsonSchema,
    getAppState, setAppState, replayUserMessages = false,
    includePartialMessages = false, agents = [],
    setSDKStatus, orphanedPermission,
  } = this.config

  this.discoveredSkillNames.clear()
  setCwd(cwd)
  const persistSession = !isSessionPersistenceDisabled()
  const startTime = Date.now()

  // 包装 canUseTool 以追踪权限拒绝
  const wrappedCanUseTool: CanUseToolFn = async (...) => {
    const result = await canUseTool(...)
    if (result.behavior !== 'allow') {
      this.permissionDenials.push({ ... })
    }
    return result
  }

  // 获取系统提示词
  const { defaultSystemPrompt, userContext: baseUserContext, systemContext } =
    await fetchSystemPromptParts({ tools, mainLoopModel, ... })
  const systemPrompt = asSystemPrompt([...])

  // 处理用户输入（斜杠命令等）
  const { messages: messagesFromUserInput, shouldQuery, ... } =
    await processUserInput({ input: prompt, ... })

  this.mutableMessages.push(...messagesFromUserInput)

  // 如果不需要查询（本地命令），直接返回结果
  if (!shouldQuery) {
    yield { type: 'result', subtype: 'success', ... }
    return
  }

  // 进入 Agentic Loop
  for await (const message of query({
    messages, systemPrompt, userContext, systemContext,
    canUseTool: wrappedCanUseTool, toolUseContext: processUserInputContext,
    fallbackModel, querySource: 'sdk', maxTurns, taskBudget,
  })) {
    // 根据 message.type 分发处理
    switch (message.type) {
      case 'assistant':
        this.mutableMessages.push(message)
        yield* normalizeMessage(message)
        break
      case 'progress':
      case 'user':
        this.mutableMessages.push(message)
        yield* normalizeMessage(message)
        break
      case 'stream_event':
        // 累计 usage，可选 yield 流事件
        break
      case 'attachment':
        // 处理 max_turns_reached、structured_output 等
        break
      case 'system':
        // 处理 compact_boundary、snip replay
        break
    }

    // USD 预算检查
    if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
      yield { type: 'result', subtype: 'error_max_budget_usd', ... }
      return
    }
  }

  // 循环结束，返回最终结果
  yield {
    type: 'result', subtype: 'success',
    result: textResult, stop_reason: lastStopReason,
    usage: this.totalUsage, ...
  }
}
```

---

### 5. `Tool<I,O,P>` 接口定义

**来源文件**: `/workspace/claude-code-sourcemap/restored-src/src/Tool.ts`
**行号范围**: 第 362–695 行

**说明**: Claude Code 中所有工具的核心接口定义。这是一个泛型接口，三个类型参数分别代表输入 schema (`Input`)、输出类型 (`Output`) 和进度数据类型 (`P`)。接口包含以下关键成员：

- **`call()`**: 工具执行入口，接收输入、上下文、权限回调，返回 `ToolResult<Output>`
- **`description()`**: 生成工具描述文本（给模型看）
- **`inputSchema` / `inputJSONSchema`**: Zod 或 JSON Schema 格式的输入定义
- **`checkPermissions()`**: 工具级权限检查
- **`validateInput()`**: 输入验证
- **`isConcurrencySafe()` / `isReadOnly()` / `isDestructive()`**: 安全分类
- **`prompt()`**: 生成工具的 XML 提示词片段
- **`renderToolUseMessage()` / `renderToolResultMessage()` 等**: UI 渲染方法
- **`mapToolResultToToolResultBlockParam()`**: 将输出转为 API 格式
- **`shouldDefer` / `alwaysLoad`**: 工具延迟加载控制

```typescript
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  aliases?: string[]
  searchHint?: string
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>
  description(
    input: z.infer<Input>,
    options: {
      isNonInteractiveSession: boolean
      toolPermissionContext: ToolPermissionContext
      tools: Tools
    },
  ): Promise<string>
  readonly inputSchema: Input
  readonly inputJSONSchema?: ToolInputJSONSchema
  outputSchema?: z.ZodType<unknown>
  inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean
  isConcurrencySafe(input: z.infer<Input>): boolean
  isEnabled(): boolean
  isReadOnly(input: z.infer<Input>): boolean
  isDestructive?(input: z.infer<Input>): boolean
  interruptBehavior?(): 'cancel' | 'block'
  isSearchOrReadCommand?(input: z.infer<Input>): {
    isSearch: boolean; isRead: boolean; isList?: boolean
  }
  isOpenWorld?(input: z.infer<Input>): boolean
  requiresUserInteraction?(): boolean
  isMcp?: boolean
  isLsp?: boolean
  readonly shouldDefer?: boolean
  readonly alwaysLoad?: boolean
  mcpInfo?: { serverName: string; toolName: string }
  readonly name: string
  maxResultSizeChars: number
  readonly strict?: boolean
  backfillObservableInput?(input: Record<string, unknown>): void
  validateInput?(input: z.infer<Input>, context: ToolUseContext): Promise<ValidationResult>
  checkPermissions(input: z.infer<Input>, context: ToolUseContext): Promise<PermissionResult>
  getPath?(input: z.infer<Input>): string
  preparePermissionMatcher?(input: z.infer<Input>): Promise<(pattern: string) => boolean>
  prompt(options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
  }): Promise<string>
  userFacingName(input: Partial<z.infer<Input>> | undefined): string
  userFacingNameBackgroundColor?(input: Partial<z.infer<Input>> | undefined): keyof Theme | undefined
  isTransparentWrapper?(): boolean
  getToolUseSummary?(input: Partial<z.infer<Input>> | undefined): string | null
  getActivityDescription?(input: Partial<z.infer<Input>> | undefined): string | null
  toAutoClassifierInput(input: z.infer<Input>): unknown
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string): ToolResultBlockParam
  renderToolResultMessage?(...): React.ReactNode
  extractSearchText?(out: Output): string
  renderToolUseMessage(input: Partial<z.infer<Input>>, options: { theme: ThemeName; verbose: boolean; commands?: Command[] }): React.ReactNode
  isResultTruncated?(output: Output): boolean
  renderToolUseTag?(input: Partial<z.infer<Input>>): React.ReactNode
  renderToolUseProgressMessage?(...): React.ReactNode
  renderToolUseQueuedMessage?(): React.ReactNode
  renderToolUseRejectedMessage?(...): React.ReactNode
  renderToolUseErrorMessage?(...): React.ReactNode
  renderGroupedToolUse?(...): React.ReactNode | null
}
```

---

### 6. `buildTool()` 函数

**来源文件**: `/workspace/claude-code-sourcemap/restored-src/src/Tool.ts`
**行号范围**: 第 757–792 行

**说明**: 工厂函数，从部分工具定义构建完整的 `Tool` 对象。它使用 `TOOL_DEFAULTS` 对象为 7 个常用方法提供安全默认值（fail-closed 策略）：

- `isEnabled` -> `true`（默认启用）
- `isConcurrencySafe` -> `false`（默认不安全）
- `isReadOnly` -> `false`（默认可写）
- `isDestructive` -> `false`（默认非破坏性）
- `checkPermissions` -> 放行（委托给通用权限系统）
- `toAutoClassifierInput` -> `''`（跳过分类器）
- `userFacingName` -> 使用 `name`

类型系统通过 `BuiltTool<D>` 和 `ToolDef<D>` 确保调用方只需提供必要的方法，其余自动填充。

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (
    input: { [key: string]: unknown },
    _ctx?: ToolUseContext,
  ): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

type ToolDefaults = typeof TOOL_DEFAULTS

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
```

---

## 第二组：Agent 编排

---

### 7. `getCoordinatorSystemPrompt()` 函数

**来源文件**: `/workspace/claude-code-sourcemap/restored-src/src/coordinator/coordinatorMode.ts`
**行号范围**: 第 111–369 行

**说明**: 生成 Coordinator 模式下主 Agent 的系统提示词。这是一个大型模板字符串函数，定义了协调者的角色、工具使用方法、Worker 管理策略和任务工作流。核心内容包括：

- **角色定义**: 协调者负责分解任务、派发 Worker、综合结果
- **工具**: AgentTool（派发）、SendMessage（继续）、TaskStop（停止）
- **Worker 结果格式**: `<task-notification>` XML 格式
- **任务阶段**: Research -> Synthesis -> Implementation -> Verification
- **并发策略**: 只读任务并行、写入任务串行、验证可并行
- **Prompt 编写指南**: 必须自包含、先综合再派发、附目的声明

```typescript
export function getCoordinatorSystemPrompt(): string {
  const workerCapabilities = isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
    ? 'Workers have access to Bash, Read, and Edit tools, plus MCP tools from configured MCP servers.'
    : 'Workers have access to standard tools, MCP tools from configured MCP servers, and project skills via the Skill tool. Delegate skill invocations (e.g. /commit, /verify) to workers.'

  return `You are Claude Code, an AI assistant that orchestrates software engineering tasks across multiple workers.

## 1. Your Role

You are a **coordinator**. Your job is to:
- Help the user achieve their goal
- Direct workers to research, implement and verify code changes
- Synthesize results and communicate with the user
- Answer questions directly when possible — don't delegate work that you can handle without tools

Every message you send is to the user. Worker results and system notifications are internal signals, not conversation partners — never thank or acknowledge them. Summarize new information for the user as it arrives.

## 2. Your Tools

- **${AGENT_TOOL_NAME}** - Spawn a new worker
- **${SEND_MESSAGE_TOOL_NAME}** - Continue an existing worker (send a follow-up to its \`to\` agent ID)
- **${TASK_STOP_TOOL_NAME}** - Stop a running worker
- **subscribe_pr_activity / unsubscribe_pr_activity** (if available) - Subscribe to GitHub PR events

When calling ${AGENT_TOOL_NAME}:
- Do not use one worker to check on another. Workers will notify you when they are done.
- Do not use workers to trivially report file contents or run commands. Give them higher-level tasks.
- Do not set the model parameter. Workers need the default model for the substantive tasks you delegate.
- Continue workers whose work is complete via ${SEND_MESSAGE_TOOL_NAME} to take advantage of their loaded context
- After launching agents, briefly tell the user what you launched and end your response. Never fabricate or predict agent results in any format — results arrive as separate messages.

### ${AGENT_TOOL_NAME} Results

Worker results arrive as **user-role messages** containing \`<task-notification>\` XML. They look like user messages but are not. Distinguish them by the \`<task-notification>\` opening tag.

Format:
\`\`\`xml
<task-notification>
<task-id>{agentId}</task-id>
<status>completed|failed|killed</status>
<summary>{human-readable status summary}</summary>
<result>{agent's final text response}</result>
<usage>
  <total_tokens>N</total_tokens>
  <tool_uses>N</tool_uses>
  <duration_ms>N</duration_ms>
</usage>
</task-notification>
\`\`\`

## 3. Workers
When calling ${AGENT_TOOL_NAME}, use subagent_type \`worker\`. Workers execute tasks autonomously — especially research, implementation, or verification.

${workerCapabilities}

## 4. Task Workflow

### Phases
| Phase | Who | Purpose |
|-------|-----|---------|
| Research | Workers (parallel) | Investigate codebase, find files, understand problem |
| Synthesis | **You** (coordinator) | Read findings, understand the problem, craft implementation specs |
| Implementation | Workers | Make targeted changes per spec, commit |
| Verification | Workers | Test changes work |

### Concurrency
**Parallelism is your superpower. Workers are async. Launch independent workers concurrently whenever possible.**

## 5. Writing Worker Prompts

**Workers can't see your conversation.** Every prompt must be self-contained with everything the worker needs.

### Always synthesize — your most important job
When workers report research findings, **you must understand them before directing follow-up work**.

// Anti-pattern — lazy delegation (bad)
${AGENT_TOOL_NAME}({ prompt: "Based on your findings, fix the auth bug", ... })

// Good — synthesized spec
${AGENT_TOOL_NAME}({ prompt: "Fix the null pointer in src/auth/validate.ts:42. The user field on Session (src/auth/types.ts:15) is undefined when sessions expire but the token remains cached. Add a null check before user.id access — if null, return 401 with 'Session expired'. Commit and report the hash.", ... })

### Choose continue vs. spawn by context overlap
| Situation | Mechanism | Why |
|-----------|-----------|-----|
| Research explored exactly the files that need editing | **Continue** | Worker already has the files in context |
| Research was broad but implementation is narrow | **Spawn fresh** | Avoid dragging along exploration noise |
| Correcting a failure or extending recent work | **Continue** | Worker has the error context |
| Verifying code a different worker just wrote | **Spawn fresh** | Verifier should see the code with fresh eyes |
...
`
}
```

---

### 8. `call()` 方法中的策略路由分支

**来源文件**: `/workspace/claude-code-sourcemap/restored-src/src/tools/AgentTool/AgentTool.tsx`
**行号范围**: 第 239–437 行（核心路由在第 282–356 行）

**说明**: AgentTool 的 `call()` 方法是 Agent 编排的核心入口。它实现了三种策略路由：

1. **Teammate 路径**（第 284–316 行）: 当 `team_name` 和 `name` 同时提供时，通过 `spawnTeammate()` 创建进程内/tmux teammate
2. **Fork 路径**（第 318–335 行）: 当 `subagent_type` 省略且 fork 实验开启时，走隐式 fork 路径——子 Agent 继承父 Agent 的完整对话上下文和系统提示词
3. **标准 Agent 路径**（第 336–356 行）: 根据 `subagent_type` 查找对应的 AgentDefinition，支持权限过滤

```typescript
async call({
  prompt, subagent_type, description, model: modelParam,
  run_in_background, name, team_name, mode: spawnMode, isolation, cwd
}: AgentToolInput, toolUseContext, canUseTool, assistantMessage, onProgress?) {
  const startTime = Date.now();
  const model = isCoordinatorMode() ? undefined : modelParam;
  const appState = toolUseContext.getAppState();
  const permissionMode = appState.toolPermissionContext.mode;
  const rootSetAppState = toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState;

  // === 策略路由分支 1: Teammate 路径 ===
  if (teamName && name) {
    const agentDef = subagent_type
      ? toolUseContext.options.agentDefinitions.activeAgents.find(a => a.agentType === subagent_type)
      : undefined;
    if (agentDef?.color) {
      setAgentColor(subagent_type!, agentDef.color);
    }
    const result = await spawnTeammate({
      name, prompt, description, team_name: teamName,
      use_splitpane: true, plan_mode_required: spawnMode === 'plan',
      model: model ?? agentDef?.model,
      agent_type: subagent_type,
      invokingRequestId: assistantMessage?.requestId
    }, toolUseContext);
    const spawnResult: TeammateSpawnedOutput = {
      status: 'teammate_spawned' as const, prompt, ...result.data
    };
    return { data: spawnResult } as unknown as { data: Output };
  }

  // === 策略路由分支 2: Fork 路径 vs 标准 Agent 路径 ===
  const effectiveType = subagent_type
    ?? (isForkSubagentEnabled() ? undefined : GENERAL_PURPOSE_AGENT.agentType);
  const isForkPath = effectiveType === undefined;

  let selectedAgent: AgentDefinition;
  if (isForkPath) {
    // Fork 路径: 递归 fork 防护
    if (toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}`
        || isInForkChild(toolUseContext.messages)) {
      throw new Error('Fork is not available inside a forked worker. Complete your task directly using your tools.');
    }
    selectedAgent = FORK_AGENT;
  } else {
    // 标准 Agent 路径: 查找 AgentDefinition
    const allAgents = toolUseContext.options.agentDefinitions.activeAgents;
    const { allowedAgentTypes } = toolUseContext.options.agentDefinitions;
    const agents = filterDeniedAgents(
      allowedAgentTypes
        ? allAgents.filter(a => allowedAgentTypes.includes(a.agentType))
        : allAgents,
      appState.toolPermissionContext, AGENT_TOOL_NAME
    );
    const found = agents.find(agent => agent.agentType === effectiveType);
    if (!found) {
      const agentExistsButDenied = allAgents.find(agent => agent.agentType === effectiveType);
      if (agentExistsButDenied) {
        const denyRule = getDenyRuleForAgent(appState.toolPermissionContext, AGENT_TOOL_NAME, effectiveType);
        throw new Error(`Agent type '${effectiveType}' has been denied by permission rule '${AGENT_TOOL_NAME}(${effectiveType})' from ${denyRule?.source ?? 'settings'}.`);
      }
      throw new Error(`Agent type '${effectiveType}' not found. Available agents: ${agents.map(a => a.agentType).join(', ')}`);
    }
    selectedAgent = found;
  }

  // ... 后续: MCP 服务器检查、模型解析、Agent 执行 ...
}
```

---

### 9. `buildForkedMessages()` 函数

**来源文件**: `/workspace/claude-code-sourcemap/restored-src/src/tools/AgentTool/forkSubagent.ts`
**行号范围**: 第 107–169 行

**说明**: 构建 fork 子 Agent 的对话消息。核心目标是**最大化 prompt cache 命中率**——所有 fork 子 Agent 必须产生字节完全相同的 API 请求前缀。实现方式：

1. 克隆父 Agent 的完整 assistant 消息（包含所有 tool_use 块、thinking、text）
2. 为每个 tool_use 块生成**相同的占位符** tool_result（`FORK_PLACEHOLDER_RESULT`）
3. 在最后附加**每个子 Agent 独有的 directive 文本块**

结果格式: `[...history, assistant(all_tool_uses), user(placeholder_results..., directive)]`
只有最后一个 text block 因子 Agent 而异，最大化 cache hits。

```typescript
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'

export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): MessageType[] {
  // 克隆 assistant 消息，保留所有内容块
  const fullAssistantMessage: AssistantMessage = {
    ...assistantMessage,
    uuid: randomUUID(),
    message: {
      ...assistantMessage.message,
      content: [...assistantMessage.message.content],
    },
  }

  // 收集所有 tool_use 块
  const toolUseBlocks = assistantMessage.message.content.filter(
    (block): block is BetaToolUseBlock => block.type === 'tool_use',
  )

  if (toolUseBlocks.length === 0) {
    // 无 tool_use 块时直接返回 directive 消息
    return [createUserMessage({
      content: [{ type: 'text' as const, text: buildChildMessage(directive) }],
    })]
  }

  // 为每个 tool_use 构建相同的占位符 tool_result
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: [{ type: 'text' as const, text: FORK_PLACEHOLDER_RESULT }],
  }))

  // 单条 user 消息: 所有占位符 tool_results + 子 Agent 独有的 directive
  const toolResultMessage = createUserMessage({
    content: [
      ...toolResultBlocks,
      { type: 'text' as const, text: buildChildMessage(directive) },
    ],
  })

  return [fullAssistantMessage, toolResultMessage]
}
```

---

### 10. `filterToolsForAgent()` 函数

**来源文件**: `/workspace/claude-code-sourcemap/restored-src/src/tools/AgentTool/agentToolUtils.ts`
**行号范围**: 第 70–116 行

**说明**: 为子 Agent 过滤可用工具集。过滤逻辑分层：

1. **MCP 工具**: 始终允许（`mcp__` 前缀）
2. **ExitPlanMode**: 在 plan 模式下允许
3. **全局禁止列表**: `ALL_AGENT_DISALLOWED_TOOLS`（如 AgentTool 自身）
4. **自定义 Agent 禁止列表**: `CUSTOM_AGENT_DISALLOWED_TOOLS`（非内置 Agent 额外限制）
5. **异步 Agent 白名单**: `ASYNC_AGENT_ALLOWED_TOOLS`（后台 Agent 只能用安全工具）
6. **In-process Teammate 例外**: Agent Swarms 启用时，允许 teammate 使用 AgentTool 和任务协调工具

```typescript
export function filterToolsForAgent({
  tools,
  isBuiltIn,
  isAsync = false,
  permissionMode,
}: {
  tools: Tools
  isBuiltIn: boolean
  isAsync?: boolean
  permissionMode?: PermissionMode
}): Tools {
  return tools.filter(tool => {
    // 允许所有 MCP 工具
    if (tool.name.startsWith('mcp__')) {
      return true
    }
    // plan 模式下允许 ExitPlanMode
    if (
      toolMatchesName(tool, EXIT_PLAN_MODE_V2_TOOL_NAME) &&
      permissionMode === 'plan'
    ) {
      return true
    }
    // 全局禁止列表
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    // 自定义 Agent 禁止列表
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    // 异步 Agent 白名单
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
      if (isAgentSwarmsEnabled() && isInProcessTeammate()) {
        // In-process teammate 例外: 允许 AgentTool 和任务工具
        if (toolMatchesName(tool, AGENT_TOOL_NAME)) {
          return true
        }
        if (IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(tool.name)) {
          return true
        }
      }
      return false
    }
    return true
  })
}
```

---

### 11. `runAsyncAgentLifecycle()` 函数

**来源文件**: `/workspace/claude-code-sourcemap/restored-src/src/tools/AgentTool/agentToolUtils.ts`
**行号范围**: 第 508–686 行

**说明**: 驱动后台 Agent 从生成到终止通知的完整生命周期。这是 AgentTool 异步路径（`run_in_background=true`）和 `resumeAgentBackground` 共用的核心函数。执行流程：

1. **初始化**: 创建进度追踪器、内存预取回调
2. **流式消费**: 通过 `makeStream()` 迭代消费 Agent 的消息流，实时更新进度到 AppState
3. **完成处理**: 调用 `finalizeAgentTool()` 收集结果，先标记任务完成（解除 TaskOutput 阻塞），再执行 handoff 分类器检查
4. **通知排队**: 通过 `enqueueAgentNotification()` 将完成/失败/终止通知加入队列
5. **错误处理**: 区分 AbortError（用户终止）、其他错误（失败），分别处理

关键设计: `completeAsyncAgent()` 在分类器检查和 worktree 清理**之前**调用，确保 TaskOutput 不会被 API 调用/git 操作阻塞。

```typescript
export async function runAsyncAgentLifecycle({
  taskId, abortController, makeStream, metadata, description,
  toolUseContext, rootSetAppState, agentIdForCleanup, enableSummarization,
  getWorktreeResult,
}: {
  taskId: string
  abortController: AbortController
  makeStream: (
    onCacheSafeParams: ((p: CacheSafeParams) => void) | undefined,
  ) => AsyncGenerator<MessageType, void>
  metadata: Parameters<typeof finalizeAgentTool>[2]
  description: string
  toolUseContext: ToolUseContext
  rootSetAppState: SetAppState
  agentIdForCleanup: string
  enableSummarization: boolean
  getWorktreeResult: () => Promise<{ worktreePath?: string; worktreeBranch?: string }>
}): Promise<void> {
  let stopSummarization: (() => void) | undefined
  const agentMessages: MessageType[] = []
  try {
    const tracker = createProgressTracker()
    const resolveActivity = createActivityDescriptionResolver(toolUseContext.options.tools)
    const onCacheSafeParams = enableSummarization
      ? (params: CacheSafeParams) => {
          const { stop } = startAgentSummarization(taskId, asAgentId(taskId), params, rootSetAppState)
          stopSummarization = stop
        }
      : undefined

    // 消费 Agent 消息流
    for await (const message of makeStream(onCacheSafeParams)) {
      agentMessages.push(message)
      // 实时更新到 AppState（UI 展示用）
      rootSetAppState(prev => {
        const t = prev.tasks[taskId]
        if (!isLocalAgentTask(t) || !t.retain) return prev
        return { ...prev, tasks: { ...prev.tasks, [taskId]: { ...t, messages: [...(t.messages ?? []), message] } } }
      })
      // 更新进度
      updateProgressFromMessage(tracker, message, resolveActivity, toolUseContext.options.tools)
      updateAsyncAgentProgress(taskId, getProgressUpdate(tracker), rootSetAppState)
      const lastToolName = getLastToolUseName(message)
      if (lastToolName) {
        emitTaskProgress(tracker, taskId, toolUseContext.toolUseId, description, metadata.startTime, lastToolName)
      }
    }

    stopSummarization?.()

    // 收集结果并标记完成（先于分类器检查，避免阻塞 TaskOutput）
    const agentResult = finalizeAgentTool(agentMessages, taskId, metadata)
    completeAsyncAgent(agentResult, rootSetAppState)

    let finalMessage = extractTextContent(agentResult.content, '\n')

    // Handoff 安全分类器检查
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const handoffWarning = await classifyHandoffIfNeeded({ ... })
      if (handoffWarning) {
        finalMessage = `${handoffWarning}\n\n${finalMessage}`
      }
    }

    const worktreeResult = await getWorktreeResult()

    // 排队完成通知
    enqueueAgentNotification({
      taskId, description, status: 'completed',
      setAppState: rootSetAppState, finalMessage,
      usage: { totalTokens: getTokenCountFromTracker(tracker), toolUses: agentResult.totalToolUseCount, durationMs: agentResult.totalDurationMs },
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
  } catch (error) {
    stopSummarization?.()
    if (error instanceof AbortError) {
      // 用户终止: 先标记 killed，再清理
      killAsyncAgent(taskId, rootSetAppState)
      const worktreeResult = await getWorktreeResult()
      const partialResult = extractPartialResult(agentMessages)
      enqueueAgentNotification({ taskId, description, status: 'killed', ... })
      return
    }
    // 其他错误: 标记 failed
    const msg = errorMessage(error)
    failAsyncAgent(taskId, msg, rootSetAppState)
    const worktreeResult = await getWorktreeResult()
    enqueueAgentNotification({ taskId, description, status: 'failed', error: msg, ... })
  } finally {
    clearInvokedSkillsForAgent(agentIdForCleanup)
    clearDumpState(agentIdForCleanup)
  }
}
```

---

## 文件存在性说明

| 序号 | 文件 | 状态 |
|------|------|------|
| 1 | `query.ts` | 存在 |
| 2 | `query/transitions.ts` (Continue/Terminal 类型) | **不存在于 sourcemap 中**，已从用法推断 |
| 3 | `QueryEngine.ts` | 存在 |
| 4 | `QueryEngine.ts` (submitMessage) | 存在 |
| 5 | `Tool.ts` | 存在 |
| 6 | `Tool.ts` (buildTool) | 存在 |
| 7 | `coordinator/coordinatorMode.ts` | 存在 |
| 8 | `AgentTool/AgentTool.tsx` | 存在 |
| 9 | `AgentTool/forkSubagent.ts` | 存在 |
| 10 | `AgentTool/agentToolUtils.ts` | 存在 |
| 11 | `AgentTool/agentToolUtils.ts` | 存在 |

---

## 第五组：Agent 编排扩展（openclaw）

---

### 12. `selectAgentHarness()` — Harness 选择策略 + 兜底

**来源文件**: `/workspace/openclaw/src/agents/harness/selection.ts`
**行号范围**: 第 45-106 行

**说明**: Agent Harness 选择策略函数，根据运行时策略（`runtime`）和兜底策略（`fallback`）决定使用哪个 Agent Harness。核心逻辑：

1. **PI 强制路径**: 当 `runtime === "pi"` 时直接返回内置 PI harness（遗留回退路径）。
2. **强制指定路径**: 当 `runtime` 不是 `"auto"` 时，在已注册的插件 harness 中查找匹配项；找不到时根据 `fallback` 策略决定是抛错还是回退到 PI。
3. **自动选择路径**（`runtime === "auto"`）: 遍历所有插件 harness，调用 `supports()` 检查是否支持当前 provider/model，按 `priority` 降序排列后选择最优匹配；无匹配时同样根据 `fallback` 策略决定兜底行为。
4. **兜底控制**: `fallback: "none"` 严格模式会直接抛错，防止静默降级。

```typescript
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
```

---

### 13. `runWithModelFallback()` — 模型故障转移链

**来源文件**: `/workspace/openclaw/src/agents/model-fallback.ts`
**行号范围**: 第 626-902 行

**说明**: 模型故障转移核心函数，实现完整的 fallback 链执行逻辑。当主模型失败时，自动尝试配置的备用模型列表。关键机制：

1. **候选解析** (`resolveFallbackCandidates`): 从配置中构建候选模型列表（主模型 + fallbacks），支持模型别名解析和 allowlist 过滤。
2. **冷却决策** (`resolveCooldownDecision`): 检查 auth profile 是否在冷却期，区分持久性错误（auth/billing）和瞬态错误，决定是否跳过或探测。
3. **探测节流** (`shouldProbePrimaryDuringCooldown`): 主模型在冷却期时，按 30 秒间隔节流探测，在冷却到期前 2 分钟开始探测以快速恢复。
4. **错误分类**: 区分 context overflow（直接抛出，不 fallback）、AbortError（用户取消，不 fallback）、FailoverError（已知可恢复错误，继续 fallback）、LiveSessionModelSwitchError（会话模型冲突，继续 fallback）。
5. **失败汇总** (`FallbackSummaryError`): 所有候选耗尽时，抛出包含每次尝试详情的结构化错误。

```typescript
export async function runWithModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  runId?: string;
  agentDir?: string;
  fallbacksOverride?: string[];
  run: ModelFallbackRunFn<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveFallbackCandidates({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
  });
  const authStore = params.cfg
    ? ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false })
    : null;
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;
  const cooldownProbeUsedProviders = new Set<string>();

  const hasFallbackCandidates = candidates.length > 1;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const isPrimary = i === 0;
    const requestedModel =
      params.provider === candidate.provider && params.model === candidate.model;
    let runOptions: ModelFallbackRunOptions | undefined;
    let attemptedDuringCooldown = false;
    let transientProbeProviderForAttempt: string | null = null;
    if (authStore) {
      const profileIds = resolveAuthProfileOrder({
        cfg: params.cfg,
        store: authStore,
        provider: candidate.provider,
      });
      const isAnyProfileAvailable = profileIds.some(
        (id) => !isProfileInCooldown(authStore, id, undefined, candidate.model),
      );

      if (profileIds.length > 0 && !isAnyProfileAvailable) {
        const now = Date.now();
        const probeThrottleKey = resolveProbeThrottleKey(candidate.provider, params.agentDir);
        const decision = resolveCooldownDecision({
          candidate,
          isPrimary,
          requestedModel,
          hasFallbackCandidates,
          now,
          probeThrottleKey,
          authStore,
          profileIds,
        });

        if (decision.type === "skip") {
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            error: decision.error,
            reason: decision.reason,
          });
          logModelFallbackDecision({
            decision: "skip_candidate",
            runId: params.runId,
            requestedProvider: params.provider,
            requestedModel: params.model,
            candidate,
            attempt: i + 1,
            total: candidates.length,
            reason: decision.reason,
            error: decision.error,
            nextCandidate: candidates[i + 1],
            isPrimary,
            requestedModelMatched: requestedModel,
            fallbackConfigured: hasFallbackCandidates,
            profileCount: profileIds.length,
          });
          continue;
        }

        if (decision.markProbe) {
          markProbeAttempt(now, probeThrottleKey);
        }
        if (shouldAllowCooldownProbeForReason(decision.reason)) {
          const isTransientCooldownReason = shouldUseTransientCooldownProbeSlot(decision.reason);
          if (isTransientCooldownReason && cooldownProbeUsedProviders.has(candidate.provider)) {
            const error = `Provider ${candidate.provider} is in cooldown (probe already attempted this run)`;
            attempts.push({
              provider: candidate.provider,
              model: candidate.model,
              error,
              reason: decision.reason,
            });
            logModelFallbackDecision({
              decision: "skip_candidate",
              runId: params.runId,
              requestedProvider: params.provider,
              requestedModel: params.model,
              candidate,
              attempt: i + 1,
              total: candidates.length,
              reason: decision.reason,
              error,
              nextCandidate: candidates[i + 1],
              isPrimary,
              requestedModelMatched: requestedModel,
              fallbackConfigured: hasFallbackCandidates,
              profileCount: profileIds.length,
            });
            continue;
          }
          runOptions = { allowTransientCooldownProbe: true };
          if (isTransientCooldownReason) {
            transientProbeProviderForAttempt = candidate.provider;
          }
        }
        attemptedDuringCooldown = true;
        logModelFallbackDecision({
          decision: "probe_cooldown_candidate",
          runId: params.runId,
          requestedProvider: params.provider,
          requestedModel: params.model,
          candidate,
          attempt: i + 1,
          total: candidates.length,
          reason: decision.reason,
          nextCandidate: candidates[i + 1],
          isPrimary,
          requestedModelMatched: requestedModel,
          fallbackConfigured: hasFallbackCandidates,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
          profileCount: profileIds.length,
        });
      }
    }

    const attemptRun = await runFallbackAttempt({
      run: params.run,
      ...candidate,
      attempts,
      options: runOptions,
    });
    if ("success" in attemptRun) {
      if (i > 0 || attempts.length > 0 || attemptedDuringCooldown) {
        logModelFallbackDecision({
          decision: "candidate_succeeded",
          runId: params.runId,
          requestedProvider: params.provider,
          requestedModel: params.model,
          candidate,
          attempt: i + 1,
          total: candidates.length,
          previousAttempts: attempts,
          isPrimary,
          requestedModelMatched: requestedModel,
          fallbackConfigured: hasFallbackCandidates,
        });
      }
      const notFoundAttempt =
        i > 0 ? attempts.find((a) => a.reason === "model_not_found") : undefined;
      if (notFoundAttempt) {
        log.warn(
          `Model "${sanitizeForLog(notFoundAttempt.provider)}/${sanitizeForLog(notFoundAttempt.model)}" not found. Fell back to "${sanitizeForLog(candidate.provider)}/${sanitizeForLog(candidate.model)}".`,
        );
      }
      return attemptRun.success;
    }
    const err = attemptRun.error;
    {
      if (transientProbeProviderForAttempt) {
        const probeFailureReason = describeFailoverError(err).reason;
        if (!shouldPreserveTransientCooldownProbeSlot(probeFailureReason)) {
          cooldownProbeUsedProviders.add(transientProbeProviderForAttempt);
        }
      }
      const errMessage = formatErrorMessage(err);
      if (isLikelyContextOverflowError(errMessage)) {
        throw err;
      }
      const normalized =
        coerceToFailoverError(err, {
          provider: candidate.provider,
          model: candidate.model,
        }) ?? err;

      if (err instanceof LiveSessionModelSwitchError) {
        const switchMsg = err.message;
        const switchNormalized = new FailoverError(switchMsg, {
          reason: "overloaded",
          provider: candidate.provider,
          model: candidate.model,
        });
        lastError = switchNormalized;
        recordFailedCandidateAttempt({
          attempts,
          candidate,
          error: switchNormalized,
          runId: params.runId,
          requestedProvider: params.provider,
          requestedModel: params.model,
          attempt: i + 1,
          total: candidates.length,
          nextCandidate: candidates[i + 1],
          isPrimary,
          requestedModelMatched: requestedModel,
          fallbackConfigured: hasFallbackCandidates,
        });
        continue;
      }

      const isKnownFailover = isFailoverError(normalized);
      if (!isKnownFailover && i === candidates.length - 1) {
        throw err;
      }

      lastError = isKnownFailover ? normalized : err;
      recordFailedCandidateAttempt({
        attempts,
        candidate,
        error: normalized,
        runId: params.runId,
        requestedProvider: params.provider,
        requestedModel: params.model,
        attempt: i + 1,
        total: candidates.length,
        nextCandidate: candidates[i + 1],
        isPrimary,
        requestedModelMatched: requestedModel,
        fallbackConfigured: hasFallbackCandidates,
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: isKnownFailover ? normalized : err,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  return throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "models",
    formatAttempt: (attempt) =>
      `${attempt.provider}/${attempt.model}: ${attempt.error}${
        attempt.reason ? ` (${attempt.reason})` : ""
      }`,
    soonestCooldownExpiry: resolveFallbackSoonestCooldownExpiry({
      authStore,
      agentDir: params.agentDir,
      cfg: params.cfg,
      candidates,
    }),
  });
}
```
