# 代码片段参考文档 — SystemPrompt与上下文管理

> **范围说明**：本文档收录与 SystemPrompt 构建、缓存分割、工具懒加载、Hook 权限决策相关的核心代码片段。
> 所有片段均来自 claude-code 项目，按功能模块分组，便于交叉对照架构分析文档（分析_12_SystemPrompt与上下文管理.md、分析_13_权限运行时管线.md）。

## 使用指南

1. 每个片段包含来源文件绝对路径和行号范围，可直接定位到源码。
2. 片段按功能模块分组，组内按编号排列，编号全局唯一。
3. 代码块保留原始缩进和注释，部分过长行做了最小化截断以保证可读性。
4. "说明"部分提供该片段在整体架构中的角色和设计意图解读。
5. 如需查看片段上下文，请参考源文件路径中指定的行号范围。

## 总览表格

| 编号 | 片段名称 | 来源项目 | 源文件路径（含行号范围） |
|------|----------|----------|--------------------------|
| 1 | systemPromptSectionCache — SystemPrompt缓存状态定义 | claude-code | `src/bootstrap/state.ts` L1639–L1654, L203 |
| 2 | SYSTEM_PROMPT_DYNAMIC_BOUNDARY — 静态/动态缓存分割 | claude-code | `src/utils/api.ts` L325–L435 |
| 3 | SystemPrompt Branded Type | claude-code | `src/utils/systemPromptType.ts` L1–L14 |
| 4 | Tool shouldDefer定义 | claude-code | `src/Tool.ts` L438–L449 |
| 5 | ToolSearchMode与getToolSearchMode | claude-code | `src/utils/toolSearch.ts` L154–L198 |
| 6 | resolveHookPermissionDecision — Hook权限决策覆盖 | claude-code | `src/services/tools/toolHooks.ts` L332–L433 |
| 7 | hasPermissionsToUseToolInner — 静态规则7步检查链 | claude-code | `src/utils/permissions/permissions.ts` L1158–L1319 |

**片段总数**: 7

---

## 一、SystemPrompt缓存机制

### 1. systemPromptSectionCache — SystemPrompt缓存状态定义

**来源文件**: `claude-code-sourcemap/restored-src/src/bootstrap/state.ts`
**行号范围**: L1639–L1654（访问器函数）、L203（状态字段声明）

**说明**：
`systemPromptSectionCache` 是全局状态对象 `STATE` 中的一个 `Map<string, string | null>` 字段，用于缓存 SystemPrompt 各片段的构建结果。当某个片段的内容在会话期间未发生变化时，直接从缓存读取，避免重复拼接和计算。`null` 值表示该片段存在但内容为空（与未缓存区分）。三个访问器函数遵循"状态字段 + getter/setter/clear"的标准模式，是 claude-code 全局状态管理的典型写法。

```typescript
// src/bootstrap/state.ts L203 — 状态字段声明
  // System prompt section cache state
  systemPromptSectionCache: Map<string, string | null>
```

```typescript
// src/bootstrap/state.ts L1639–L1654 — 访问器函数
// System prompt section accessors

export function getSystemPromptSectionCache(): Map<string, string | null> {
  return STATE.systemPromptSectionCache
}

export function setSystemPromptSectionCacheEntry(
  name: string,
  value: string | null,
): void {
  STATE.systemPromptSectionCache.set(name, value)
}

export function clearSystemPromptSectionState(): void {
  STATE.systemPromptSectionCache.clear()
}
```

---

### 2. SYSTEM_PROMPT_DYNAMIC_BOUNDARY — 静态/动态缓存分割

**来源文件**: `claude-code-sourcemap/restored-src/src/utils/api.ts`
**行号范围**: L325–L435

**说明**：
`splitSysPromptPrefix` 函数是 SystemPrompt 缓存策略的核心实现。它根据 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记将 SystemPrompt 数组分为静态部分（`cacheScope: 'global'`）和动态部分（`cacheScope: null`）。静态部分在会话中几乎不变（如核心指令、工具定义），可被 API 层全局缓存；动态部分（如日期、上下文摘要）每次请求都可能变化，不参与缓存。

函数有三条执行路径：
1. **工具级缓存路径**（`skipGlobalCacheForSystemPrompt`）：跳过全局缓存，所有块使用 `org` 级别缓存。
2. **边界分割路径**（默认）：找到 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记，标记之前为静态块（`global`），之后为动态块（`null`）。
3. **回退路径**（无标记或功能关闭）：所有块使用 `org` 级别缓存。

`attributionHeader`（计费头）始终不缓存（`cacheScope: null`），`systemPromptPrefix`（CLI 前缀）使用 `org` 级别缓存。

```typescript
// src/utils/api.ts L80–L84 — 类型定义
export type CacheScope = 'global' | 'org'
export type SystemPromptBlock = {
  text: string
  cacheScope: CacheScope | null
}
```

```typescript
// src/utils/api.ts L321–L435 — splitSysPromptPrefix 完整实现
export function splitSysPromptPrefix(
  systemPrompt: SystemPrompt,
  options?: { skipGlobalCacheForSystemPrompt?: boolean },
): SystemPromptBlock[] {
  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  if (useGlobalCacheFeature && options?.skipGlobalCacheForSystemPrompt) {
    logEvent('tengu_sysprompt_using_tool_based_cache', {
      promptBlockCount: systemPrompt.length,
    })

    // Filter out boundary marker, return blocks without global scope
    let attributionHeader: string | undefined
    let systemPromptPrefix: string | undefined
    const rest: string[] = []

    for (const prompt of systemPrompt) {
      if (!prompt) continue
      if (prompt === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue // Skip boundary
      if (prompt.startsWith('x-anthropic-billing-header')) {
        attributionHeader = prompt
      } else if (CLI_SYSPROMPT_PREFIXES.has(prompt)) {
        systemPromptPrefix = prompt
      } else {
        rest.push(prompt)
      }
    }

    const result: SystemPromptBlock[] = []
    if (attributionHeader) {
      result.push({ text: attributionHeader, cacheScope: null })
    }
    if (systemPromptPrefix) {
      result.push({ text: systemPromptPrefix, cacheScope: 'org' })
    }
    const restJoined = rest.join('\n\n')
    if (restJoined) {
      result.push({ text: restJoined, cacheScope: 'org' })
    }
    return result
  }

  if (useGlobalCacheFeature) {
    const boundaryIndex = systemPrompt.findIndex(
      s => s === SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    )
    if (boundaryIndex !== -1) {
      let attributionHeader: string | undefined
      let systemPromptPrefix: string | undefined
      const staticBlocks: string[] = []
      const dynamicBlocks: string[] = []

      for (let i = 0; i < systemPrompt.length; i++) {
        const block = systemPrompt[i]!
        if (!block || block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue

        if (block.startsWith('x-anthropic-billing-header')) {
          attributionHeader = block
        } else if (CLI_SYSPROMPT_PREFIXES.has(block)) {
          systemPromptPrefix = block
        } else if (i < boundaryIndex) {
          staticBlocks.push(block)
        } else {
          dynamicBlocks.push(block)
        }
      }

      const result: SystemPromptBlock[] = []
      if (attributionHeader)
        result.push({ text: attributionHeader, cacheScope: null })
      if (systemPromptPrefix)
        result.push({ text: systemPromptPrefix, cacheScope: null })
      const staticJoined = staticBlocks.join('\n\n')
      if (staticJoined)
        result.push({ text: staticJoined, cacheScope: 'global' })
      const dynamicJoined = dynamicBlocks.join('\n\n')
      if (dynamicJoined) result.push({ text: dynamicJoined, cacheScope: null })

      logEvent('tengu_sysprompt_boundary_found', {
        blockCount: result.length,
        staticBlockLength: staticJoined.length,
        dynamicBlockLength: dynamicJoined.length,
      })

      return result
    } else {
      logEvent('tengu_sysprompt_missing_boundary_marker', {
        promptBlockCount: systemPrompt.length,
      })
    }
  }
  let attributionHeader: string | undefined
  let systemPromptPrefix: string | undefined
  const rest: string[] = []

  for (const block of systemPrompt) {
    if (!block) continue

    if (block.startsWith('x-anthropic-billing-header')) {
      attributionHeader = block
    } else if (CLI_SYSPROMPT_PREFIXES.has(block)) {
      systemPromptPrefix = block
    } else {
      rest.push(block)
    }
  }

  const result: SystemPromptBlock[] = []
  if (attributionHeader)
    result.push({ text: attributionHeader, cacheScope: null })
  if (systemPromptPrefix)
    result.push({ text: systemPromptPrefix, cacheScope: 'org' })
  const restJoined = rest.join('\n\n')
  if (restJoined) result.push({ text: restJoined, cacheScope: 'org' })
  return result
}
```

---

### 3. SystemPrompt Branded Type

**来源文件**: `claude-code-sourcemap/restored-src/src/utils/systemPromptType.ts`
**行号范围**: L1–L14（完整文件）

**说明**：
`SystemPrompt` 是一个 Branded Type（品牌类型），通过交叉类型 `& { readonly __brand: 'SystemPrompt' }` 将普通的 `readonly string[]` 标记为语义明确的 SystemPrompt 类型。这种设计遵循用户规则中的"不同语义ID用 Branded Types"原则，确保 SystemPrompt 数组不会与普通字符串数组混淆。

该模块刻意保持零依赖（intentionally dependency-free），以避免循环初始化问题。`asSystemPrompt` 函数是唯一创建该类型的入口，内部使用类型断言，调用方需自行保证传入值的正确性。

```typescript
// src/utils/systemPromptType.ts — 完整文件
/**
 * Branded type for system prompt arrays.
 *
 * This module is intentionally dependency-free so it can be imported
 * from anywhere without risking circular initialization issues.
 */

export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}
```

---

## 二、shouldDefer工具懒加载

### 4. Tool shouldDefer定义

**来源文件**: `claude-code-sourcemap/restored-src/src/Tool.ts`
**行号范围**: L438–L449

**说明**：
`shouldDefer` 和 `alwaysLoad` 是 Tool 接口上的两个可选布尔字段，共同构成工具懒加载的控制面。

- `shouldDefer: true` — 该工具在初始 prompt 中以 `defer_loading: true` 标记发送，模型不会立即看到其完整 schema，需要先通过 ToolSearch 查询后才能调用。适用于 MCP 工具等 schema 较大但使用频率低的工具，减少初始 prompt 的 token 消耗。
- `alwaysLoad: true` — 该工具永远不被延迟加载，即使 ToolSearch 功能开启，其完整 schema 也会出现在第一轮 prompt 中。用于模型必须在 turn 1 就能看到的工具（如核心交互工具）。MCP 工具可通过 `_meta['anthropic/alwaysLoad']` 设置此属性。

两个字段互斥：`shouldDefer` 控制默认延迟行为，`alwaysLoad` 作为白名单覆盖。

```typescript
// src/Tool.ts L438–L449
  /**
   * When true, this tool is deferred (sent with defer_loading: true) and requires
   * ToolSearch to be used before it can be called.
   */
  readonly shouldDefer?: boolean
  /**
   * When true, this tool is never deferred — its full schema appears in the
   * initial prompt even when ToolSearch is enabled. For MCP tools, set via
   * `_meta['anthropic/alwaysLoad']`. Use for tools the model must see on
   * turn 1 without a ToolSearch round-trip.
   */
  readonly alwaysLoad?: boolean
```

---

### 5. ToolSearchMode与getToolSearchMode

**来源文件**: `claude-code-sourcemap/restored-src/src/utils/toolSearch.ts`
**行号范围**: L154–L198

**说明**：
`ToolSearchMode` 是一个联合字面量类型，定义了三种工具搜索模式：

- `'tst'` — Tool Search Tool 模式：所有可延迟工具（MCP + shouldDefer）始终通过 ToolSearch 发现，初始 prompt 不包含其 schema。
- `'tst-auto'` — 自动模式：仅当可延迟工具数量超过阈值时才启用延迟加载，否则内联暴露所有工具。
- `'standard'` — 标准模式：禁用工具搜索，所有工具的完整 schema 直接内联在 prompt 中。

`getToolSearchMode()` 函数通过环境变量 `ENABLE_TOOL_SEARCH` 决定运行时模式。支持 `auto:N` 语法（N 为 0–100 的百分比阈值），以及 `true`/`false` 布尔值。还有一个紧急开关 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`，当设置时强制回退到 `standard` 模式，防止 beta API 形状（`defer_loading`、`tool_reference`）发送到不支持的代理网关。

```typescript
// src/utils/toolSearch.ts L154–L198
/**
 * Tool search mode. Determines how deferrable tools (MCP + shouldDefer) are
 * surfaced:
 *   - 'tst': Tool Search Tool — deferred tools discovered via ToolSearchTool (always enabled)
 *   - 'tst-auto': auto — tools deferred only when they exceed threshold
 *   - 'standard': tool search disabled — all tools exposed inline
 */
export type ToolSearchMode = 'tst' | 'tst-auto' | 'standard'

/**
 * Determines the tool search mode from ENABLE_TOOL_SEARCH.
 *
 *   ENABLE_TOOL_SEARCH    Mode
 *   auto / auto:1-99      tst-auto
 *   true / auto:0         tst
 *   false / auto:100      standard
 *   (unset)               tst (default: always defer MCP and shouldDefer tools)
 */
export function getToolSearchMode(): ToolSearchMode {
  // CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is a kill switch for beta API
  // features. Tool search emits defer_loading on tool definitions and
  // tool_reference content blocks — both require the API to accept a beta
  // header. When the kill switch is set, force 'standard' so no beta shapes
  // reach the wire, even if ENABLE_TOOL_SEARCH is also set. This is the
  // explicit escape hatch for proxy gateways that the heuristic in
  // isToolSearchEnabledOptimistic doesn't cover.
  // github.com/anthropics/claude-code/issues/20031
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    return 'standard'
  }

  const value = process.env.ENABLE_TOOL_SEARCH

  // Handle auto:N syntax - check edge cases first
  const autoPercent = value ? parseAutoPercentage(value) : null
  if (autoPercent === 0) return 'tst' // auto:0 = always enabled
  if (autoPercent === 100) return 'standard'
  if (isAutoToolSearchMode(value)) {
    return 'tst-auto' // auto or auto:1-99
  }

  if (isEnvTruthy(value)) return 'tst'
  if (isEnvDefinedFalsy(process.env.ENABLE_TOOL_SEARCH)) return 'standard'
  return 'tst' // default: always defer MCP and shouldDefer tools
}
```

---

## 三、Hook权限决策

### 6. resolveHookPermissionDecision — Hook权限决策覆盖

**来源文件**: `claude-code-sourcemap/restored-src/src/services/tools/toolHooks.ts`
**行号范围**: L332–L433

**说明**：
`resolveHookPermissionDecision` 是 Hook 权限决策的统一入口，被 `toolExecution.ts`（主查询循环）和 `REPLTool/toolWrappers.ts`（REPL 内部调用）共享，确保两处的权限语义完全一致。

函数接收 Hook 返回的 `hookPermissionResult`，根据其 `behavior` 字段分三条路径处理：

1. **`allow`**：Hook 批准工具调用。但仍需检查：
   - `requiresUserInteraction` — 如果工具需要用户交互且 Hook 未提供 `updatedInput`，则回退到 `canUseTool` 标准流程。
   - `requireCanUseTool` — 如果上下文要求必须走权限检查，同样回退。
   - `checkRuleBasedPermissions` — 即使 Hook 批准，deny/ask 规则仍然生效。deny 规则直接覆盖 Hook 的 allow；ask 规则则触发用户确认对话框。
   - 如果以上检查全部通过，直接返回 Hook 的 allow 决策。

2. **`deny`**：Hook 拒绝工具调用，直接返回 deny 决策，不再走后续检查。

3. **`ask` 或无 Hook 决策**：走标准 `canUseTool` 流程。如果 Hook 行为是 `ask`，其 `updatedInput` 会替换原始输入，且 Hook 的 ask 消息作为 `forceDecision` 传递给对话框。

该设计体现了"Hook 是建议而非最终裁决"的理念——allow 可被规则覆盖，deny 是最终裁决，ask 则交给用户。

```typescript
// src/services/tools/toolHooks.ts L332–L433
export async function resolveHookPermissionDecision(
  hookPermissionResult: PermissionResult | undefined,
  tool: Tool,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  toolUseID: string,
): Promise<{
  decision: PermissionDecision
  input: Record<string, unknown>
}> {
  const requiresInteraction = tool.requiresUserInteraction?.()
  const requireCanUseTool = toolUseContext.requireCanUseTool

  if (hookPermissionResult?.behavior === 'allow') {
    const hookInput = hookPermissionResult.updatedInput ?? input

    // Hook provided updatedInput for an interactive tool — the hook IS the
    // user interaction (e.g. headless wrapper that collected AskUserQuestion
    // answers). Treat as non-interactive for the rule-check path.
    const interactionSatisfied =
      requiresInteraction && hookPermissionResult.updatedInput !== undefined

    if ((requiresInteraction && !interactionSatisfied) || requireCanUseTool) {
      logForDebugging(
        `Hook approved tool use for ${tool.name}, but canUseTool is required`,
      )
      return {
        decision: await canUseTool(
          tool,
          hookInput,
          toolUseContext,
          assistantMessage,
          toolUseID,
        ),
        input: hookInput,
      }
    }

    // Hook allow skips the interactive prompt, but deny/ask rules still apply.
    const ruleCheck = await checkRuleBasedPermissions(
      tool,
      hookInput,
      toolUseContext,
    )
    if (ruleCheck === null) {
      logForDebugging(
        interactionSatisfied
          ? `Hook satisfied user interaction for ${tool.name} via updatedInput`
          : `Hook approved tool use for ${tool.name}, bypassing permission prompt`,
      )
      return { decision: hookPermissionResult, input: hookInput }
    }
    if (ruleCheck.behavior === 'deny') {
      logForDebugging(
        `Hook approved tool use for ${tool.name}, but deny rule overrides: ${ruleCheck.message}`,
      )
      return { decision: ruleCheck, input: hookInput }
    }
    // ask rule — dialog required despite hook approval
    logForDebugging(
      `Hook approved tool use for ${tool.name}, but ask rule requires prompt`,
    )
    return {
      decision: await canUseTool(
        tool,
        hookInput,
        toolUseContext,
        assistantMessage,
        toolUseID,
      ),
      input: hookInput,
    }
  }

  if (hookPermissionResult?.behavior === 'deny') {
    logForDebugging(`Hook denied tool use for ${tool.name}`)
    return { decision: hookPermissionResult, input }
  }

  // No hook decision or 'ask' — normal permission flow, possibly with
  // forceDecision so the dialog shows the hook's ask message.
  const forceDecision =
    hookPermissionResult?.behavior === 'ask' ? hookPermissionResult : undefined
  const askInput =
    hookPermissionResult?.behavior === 'ask' &&
    hookPermissionResult.updatedInput
      ? hookPermissionResult.updatedInput
      : input
  return {
    decision: await canUseTool(
      tool,
      askInput,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ),
    input: askInput,
  }
}
```

---

### 7. hasPermissionsToUseToolInner — 静态规则7步检查链

**来源文件**: `claude-code-sourcemap/restored-src/src/utils/permissions/permissions.ts`
**行号范围**: L1158–L1319

**说明**：
`hasPermissionsToUseToolInner` 是权限管线的内部核心函数，实现了一个有序的 7 步检查链（步骤 1a–1g + 步骤 2a–2b + 步骤 3），每一步都有明确的短路返回语义：

**步骤 1：静态规则检查（bypass-immune）**
- **1a — 整工具 deny 规则**：如果该工具被用户配置为完全拒绝（`getDenyRuleForTool`），直接返回 deny，不进入后续流程。
- **1b — 整工具 ask 规则**：如果该工具被配置为始终询问，返回 ask。特殊处理：沙箱模式下的 Bash 命令可跳过 ask 规则，由 Bash 自身的 `checkPermissions` 处理命令级规则。
- **1c — 工具实现级权限检查**：调用 `tool.checkPermissions(parsedInput, context)`，让工具自身根据输入内容做细粒度判断。解析失败时静默降级为 passthrough。
- **1d — 工具实现 deny**：如果工具返回 deny，直接拒绝。
- **1e — 用户交互要求**：如果工具声明 `requiresUserInteraction` 且返回 ask，直接返回 ask（即使在 bypass 模式下也必须交互）。
- **1f — 内容级 ask 规则**：工具返回的 ask 决策中如果 `decisionReason.type === 'rule'` 且 `ruleBehavior === 'ask'`，说明是用户配置的内容级规则（如 `Bash(npm publish:*)`），即使在 bypass 模式下也必须尊重。
- **1g — 安全检查**：针对 `.git/`、`.claude/`、`.vscode/`、shell 配置等敏感路径的检查（`type: 'safetyCheck'`），同样是 bypass-immune 的。

**步骤 2：模式判断**
- **2a — bypass 模式**：如果当前处于 `bypassPermissions` 模式（或 plan 模式且用户最初以 bypass 启动），且通过了步骤 1 的所有检查，直接返回 allow。
- **2b — 整工具 allow 规则**：如果该工具被配置为始终允许（`toolAlwaysAllowedRule`），返回 allow。

**步骤 3：默认行为**
- 将 `passthrough` 转换为 `ask`，生成权限请求消息，返回给调用方触发用户确认对话框。

该设计的关键洞察是：步骤 1 的所有检查都是"不可绕过的安全底线"，即使最高权限的 bypass 模式也不能跳过。步骤 2 才是"模式级别的放行"。这种分层设计确保了安全规则始终优先于便利性。

```typescript
// src/utils/permissions/permissions.ts L1158–L1319
async function hasPermissionsToUseToolInner(
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolUseContext,
): Promise<PermissionDecision> {
  if (context.abortController.signal.aborted) {
    throw new AbortError()
  }

  let appState = context.getAppState()

  // 1. Check if the tool is denied
  // 1a. Entire tool is denied
  const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
  if (denyRule) {
    return {
      behavior: 'deny',
      decisionReason: {
        type: 'rule',
        rule: denyRule,
      },
      message: `Permission to use ${tool.name} has been denied.`,
    }
  }

  // 1b. Check if the entire tool should always ask for permission
  const askRule = getAskRuleForTool(appState.toolPermissionContext, tool)
  if (askRule) {
    // When autoAllowBashIfSandboxed is on, sandboxed commands skip the ask rule and
    // auto-allow via Bash's checkPermissions. Commands that won't be sandboxed (excluded
    // commands, dangerouslyDisableSandbox) still need to respect the ask rule.
    const canSandboxAutoAllow =
      tool.name === BASH_TOOL_NAME &&
      SandboxManager.isSandboxingEnabled() &&
      SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
      shouldUseSandbox(input)

    if (!canSandboxAutoAllow) {
      return {
        behavior: 'ask',
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
        message: createPermissionRequestMessage(tool.name),
      }
    }
    // Fall through to let Bash's checkPermissions handle command-specific rules
  }

  // 1c. Ask the tool implementation for a permission result
  // Overridden unless tool input schema is not valid
  let toolPermissionResult: PermissionResult = {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(tool.name),
  }
  try {
    const parsedInput = tool.inputSchema.parse(input)
    toolPermissionResult = await tool.checkPermissions(parsedInput, context)
  } catch (e) {
    // Rethrow abort errors so they propagate properly
    if (e instanceof AbortError || e instanceof APIUserAbortError) {
      throw e
    }
    logError(e)
  }

  // 1d. Tool implementation denied permission
  if (toolPermissionResult?.behavior === 'deny') {
    return toolPermissionResult
  }

  // 1e. Tool requires user interaction even in bypass mode
  if (
    tool.requiresUserInteraction?.() &&
    toolPermissionResult?.behavior === 'ask'
  ) {
    return toolPermissionResult
  }

  // 1f. Content-specific ask rules from tool.checkPermissions take precedence
  // over bypassPermissions mode. When a user explicitly configures a
  // content-specific ask rule (e.g. Bash(npm publish:*)), the tool's
  // checkPermissions returns {behavior:'ask', decisionReason:{type:'rule',
  // rule:{ruleBehavior:'ask'}}}. This must be respected even in bypass mode,
  // just as deny rules are respected at step 1d.
  if (
    toolPermissionResult?.behavior === 'ask' &&
    toolPermissionResult.decisionReason?.type === 'rule' &&
    toolPermissionResult.decisionReason.rule.ruleBehavior === 'ask'
  ) {
    return toolPermissionResult
  }

  // 1g. Safety checks (e.g. .git/, .claude/, .vscode/, shell configs) are
  // bypass-immune — they must prompt even in bypassPermissions mode.
  // checkPathSafetyForAutoEdit returns {type:'safetyCheck'} for these paths.
  if (
    toolPermissionResult?.behavior === 'ask' &&
    toolPermissionResult.decisionReason?.type === 'safetyCheck'
  ) {
    return toolPermissionResult
  }

  // 2a. Check if mode allows the tool to run
  // IMPORTANT: Call getAppState() to get the latest value
  appState = context.getAppState()
  // Check if permissions should be bypassed:
  // - Direct bypassPermissions mode
  // - Plan mode when the user originally started with bypass mode (isBypassPermissionsModeAvailable)
  const shouldBypassPermissions =
    appState.toolPermissionContext.mode === 'bypassPermissions' ||
    (appState.toolPermissionContext.mode === 'plan' &&
      appState.toolPermissionContext.isBypassPermissionsModeAvailable)
  if (shouldBypassPermissions) {
    return {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
      decisionReason: {
        type: 'mode',
        mode: appState.toolPermissionContext.mode,
      },
    }
  }

  // 2b. Entire tool is allowed
  const alwaysAllowedRule = toolAlwaysAllowedRule(
    appState.toolPermissionContext,
    tool,
  )
  if (alwaysAllowedRule) {
    return {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
      decisionReason: {
        type: 'rule',
        rule: alwaysAllowedRule,
      },
    }
  }

  // 3. Convert "passthrough" to "ask"
  const result: PermissionDecision =
    toolPermissionResult.behavior === 'passthrough'
      ? {
          ...toolPermissionResult,
          behavior: 'ask' as const,
          message: createPermissionRequestMessage(
            tool.name,
            toolPermissionResult.decisionReason,
          ),
        }
      : toolPermissionResult

  if (result.behavior === 'ask' && result.suggestions) {
    logForDebugging(
      `Permission suggestions for ${tool.name}: ${jsonStringify(result.suggestions, null, 2)}`,
    )
  }

  return result
}
```

---
