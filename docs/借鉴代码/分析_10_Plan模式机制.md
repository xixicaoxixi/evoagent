# 分析_10_Plan模式机制

> **轮次**：第 10 轮 — Plan模式机制深度拆解
>
> **日期**：2026-04-20
>
> **阅读量**：~120 KB（EnterPlanModeTool、ExitPlanModeV2Tool、permissionSetup、PermissionMode、PermissionUpdate、planModeV2）
>
> **产出价值**：Plan模式完整生命周期分析 + 权限模式体系全景 + Auto模式交互机制 + 对EvoAgent的5项参考价值

---

## 一、Plan模式概述

### 1.1 核心定位

Plan模式是claude-code中一个**硬权限边界**（hard permission boundary），而非软性建议。它将Agent的行为严格划分为两个阶段：

1. **Plan Phase（规划阶段）**：只读探索，不允许写入文件
2. **Execute Phase（执行阶段）**：退出Plan模式后，进入编码实现

这种设计确保了"先理解后行动"的工作流，防止Agent在未充分理解代码库的情况下贸然修改代码。

```
┌──────────────────────────────────────────────────────────────┐
│                    Plan 模式生命周期                            │
│                                                              │
│  ┌─────────────┐    EnterPlanMode    ┌──────────────────┐   │
│  │  任意模式     │ ──────────────────> │  Plan Phase      │   │
│  │ (default/    │   保存prePlanMode   │  (只读探索)       │   │
│  │  auto/accept) │   剥离危险权限      │  Glob/Grep/Read  │   │
│  └─────────────┘                     └────────┬─────────┘   │
│         ^                                     │             │
│         │          ExitPlanMode                │             │
│         │     恢复prePlanMode                  │             │
│         │     恢复危险权限                      │             │
│         │     (circuit breaker检查)            │             │
│         │                                     v             │
│  ┌──────┴──────┐                    ┌──────────────────┐   │
│  │  原始模式     │ <────────────────  │  提交Plan文件     │   │
│  │ (或fallback) │   用户/Leader审批   │  ExitPlanMode    │   │
│  └─────────────┘                     └──────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 关键特性

| 特性 | 说明 |
|------|------|
| **硬权限边界** | 由权限系统（PermissionMode）强制执行，非模型自律 |
| **模型主动发起** | 通过`EnterPlanModeTool`工具调用进入，非用户手动触发 |
| **Save-Restore语义** | `prePlanMode`字段保存进入前的模式，退出时恢复 |
| **Feature Flag门控** | 当`--channels`激活时禁用（审批对话框需要终端） |
| **Agent上下文拒绝** | 在Agent/SubAgent上下文中禁止进入Plan模式 |
| **Interview阶段** | `isPlanModeInterviewPhaseEnabled()`控制详细工作流指令 |

**关键洞察**：Plan模式的设计哲学是"信任但验证"——模型可以主动请求进入Plan模式，但必须经过权限系统审批；退出时必须经过用户或Team Leader审批，确保Plan质量。

### 1.3 Feature Flag门控机制

```typescript
// EnterPlanModeTool.ts / ExitPlanModeV2Tool.ts
isEnabled() {
  // 当 --channels 激活时（Telegram/Discord），审批对话框无法显示
  // 同时禁用Enter和Exit，防止模型进入Plan模式后无法退出
  if (
    (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
    getAllowedChannels().length > 0
  ) {
    return false
  }
  return true
}
```

**设计模式**：成对门控（Paired Gate）——Enter和Exit使用相同的门控条件，避免"只进不出"的陷阱状态。

---

## 二、进入Plan模式 (EnterPlanModeTool)

### 2.1 工具定义

```typescript
// EnterPlanModeTool.ts
export const EnterPlanModeTool: Tool<InputSchema, Output> = buildTool({
  name: 'EnterPlanMode',
  searchHint: 'switch to plan mode to design an approach before coding',
  shouldDefer: true,          // 延迟加载，通过ToolSearch发现
  isConcurrencySafe: true,    // 并发安全
  isReadOnly: true,           // 只读工具
  // ...
})
```

**关键属性解析**：

| 属性 | 值 | 含义 |
|------|-----|------|
| `shouldDefer` | `true` | 工具不在初始工具列表中，通过ToolSearch按需加载 |
| `isReadOnly` | `true` | 进入Plan模式本身是只读操作 |
| `isConcurrencySafe` | `true` | 可与其他工具并发调用 |
| `inputSchema` | `z.strictObject({})` | 无参数——进入Plan模式不需要额外输入 |

### 2.2 进入流程

```
┌─────────────────────────────────────────────────────────────┐
│                  EnterPlanMode 调用链                         │
│                                                             │
│  模型调用 ──> call(input, context)                          │
│                    │                                        │
│                    ├── 1. Agent上下文检查                     │
│                    │   context.agentId? → throw Error        │
│                    │                                        │
│                    ├── 2. 模式转换通知                        │
│                    │   handlePlanModeTransition(old, 'plan') │
│                    │                                        │
│                    ├── 3. 准备Plan上下文                      │
│                    │   prepareContextForPlanMode(context)    │
│                    │   ├── 保存 prePlanMode = currentMode    │
│                    │   ├── 处理auto模式交互                   │
│                    │   └── 剥离危险权限（如需要）              │
│                    │                                        │
│                    ├── 4. 应用权限更新                        │
│                    │   applyPermissionUpdate(                │
│                    │     preparedContext,                    │
│                    │     { type: 'setMode', mode: 'plan' }  │
│                    │   )                                     │
│                    │                                        │
│                    └── 5. 返回确认消息                        │
│                        "Entered plan mode..."                │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 Agent上下文拒绝

```typescript
async call(_input, context) {
  if (context.agentId) {
    throw new Error('EnterPlanMode tool cannot be used in agent contexts')
  }
  // ...
}
```

**设计意图**：SubAgent（通过AgentTool创建的子Agent）不允许进入Plan模式。Plan模式是顶层Agent的特权，子Agent应专注于执行分配给它们的任务。这避免了嵌套Plan模式的复杂性。

### 2.4 Interview阶段与工作流指令

```typescript
mapToolResultToToolResultBlockParam({ message }, toolUseID) {
  const instructions = isPlanModeInterviewPhaseEnabled()
    ? `${message}\n\nDO NOT write or edit any files except the plan file.`
    : `${message}\n\nIn plan mode, you should:\n1. Thoroughly explore...\n...`
  // ...
}
```

Interview阶段通过`isPlanModeInterviewPhaseEnabled()`控制：

```typescript
// planModeV2.ts
export function isPlanModeInterviewPhaseEnabled(): boolean {
  if (process.env.USER_TYPE === 'ant') return true          // Ant始终启用
  const env = process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE
  if (isEnvTruthy(env)) return true                        // 环境变量覆盖
  if (isEnvDefinedFalsy(env)) return false
  return getFeatureValue_CACHED_MAY_BE_STALE(               // GrowthBook实验门控
    'tengu_plan_mode_interview_phase', false,
  )
}
```

| 控制层级 | 优先级 | 说明 |
|---------|--------|------|
| Ant内部用户 | 最高 | 始终启用 |
| 环境变量 | 中 | `CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE` |
| GrowthBook | 最低 | `tengu_plan_mode_interview_phase` Feature Flag |

**设计模式**：分层配置覆盖（Layered Config Override）——环境变量 > Feature Flag > 默认值，同时保留Ant内部用户的硬编码优先级。

---

## 三、退出Plan模式 (ExitPlanModeV2Tool)

### 3.1 防御性验证链

ExitPlanModeV2Tool实现了多层防御机制：

```
┌──────────────────────────────────────────────────────────────┐
│              ExitPlanModeV2Tool 防御链                         │
│                                                              │
│  模型调用 ──> validateInput() ──> checkPermissions() ──> call()│
│                    │                      │              │    │
│                    │                      │              │    │
│  [防御1] 非Plan模式拒绝    [防御2] 权限分级    [防御3] 状态一致性  │
│  mode !== 'plan'         非teammate→ask    prePlanMode恢复  │
│  → errorCode:1           teammate→allow    circuit breaker │
│  (防御compact/clear后     (headless审批)    权限strip/restore│
│   的重复调用)                                           │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 validateInput()：模式守卫

```typescript
async validateInput(_input, { getAppState, options }) {
  // Teammate跳过检查（AppState可能显示Leader的模式）
  if (isTeammate()) {
    return { result: true }
  }
  // 非Plan模式下拒绝调用
  const mode = getAppState().toolPermissionContext.mode
  if (mode !== 'plan') {
    logEvent('tengu_exit_plan_mode_called_outside_plan', {
      model: options.mainLoopModel,
      mode: mode,
      hasExitedPlanModeInSession: hasExitedPlanModeInSession(),
    })
    return {
      result: false,
      message: 'You are not in plan mode...',
      errorCode: 1,
    }
  }
  return { result: true }
}
```

**关键洞察**：`validateInput`在`checkPermissions`之前执行，避免在非Plan模式下弹出不必要的审批对话框。这是因为延迟加载的工具列表（deferred-tool list）会在compact/clear后重新公告此工具，模型可能在已退出Plan模式后仍尝试调用它。

### 3.3 checkPermissions()：权限分级

```typescript
async checkPermissions(input, context) {
  // 所有Teammate绕过权限UI
  if (isTeammate()) {
    return { behavior: 'allow' as const, updatedInput: input }
  }
  // 非Teammate需要用户确认
  return { behavior: 'ask' as const, message: 'Exit plan mode?', updatedInput: input }
}
```

### 3.4 Teammate邮箱审批机制

对于需要Leader审批的Teammate，ExitPlanMode通过邮箱（mailbox）实现异步审批：

```typescript
async call(input, context) {
  // ...
  if (isTeammate() && isPlanModeRequired()) {
    const approvalRequest = {
      type: 'plan_approval_request',
      from: agentName,
      timestamp: new Date().toISOString(),
      planFilePath: filePath,
      planContent: plan,
      requestId,  // 唯一请求ID
    }

    await writeToMailbox('team-lead', {
      from: agentName,
      text: jsonStringify(approvalRequest),
      timestamp: new Date().toISOString(),
    }, teamName)

    // 更新任务状态为"等待审批"
    const agentTaskId = findInProcessTeammateTaskId(agentName, appState)
    if (agentTaskId) {
      setAwaitingPlanApproval(agentTaskId, context.setAppState, true)
    }

    return {
      data: {
        plan,
        isAgent: true,
        filePath,
        awaitingLeaderApproval: true,
        requestId,
      },
    }
  }
  // ...
}
```

**异步审批流程**：

```
┌──────────────┐                          ┌──────────────┐
│  Teammate    │                          │  Team Lead   │
│  (SubAgent)  │                          │  (主Agent)   │
└──────┬───────┘                          └──────┬───────┘
       │                                         │
       │  1. 写Plan文件                           │
       │  2. 调用ExitPlanMode                     │
       │                                         │
       │  3. writeToMailbox('team-lead', {       │
       │       type: 'plan_approval_request',     │
       │       planContent, requestId             │
       │     })                                  │
       │ ──────────────────────────────────────>  │
       │                                         │
       │  4. setAwaitingPlanApproval(true)        │
       │  5. 返回 {awaitingLeaderApproval: true}  │
       │                                         │
       │  [等待]                                  │  6. 读取邮箱
       │                                         │  7. 审查Plan
       │                                         │  8. 批准/拒绝
       │  <────────────────────────────────────── │
       │  9. 收到审批结果                          │
       │  10. 开始执行（或修改Plan）                │
       │                                         │
```

**设计模式**：异步邮箱审批（Async Mailbox Approval）——通过持久化的邮箱消息实现跨Agent的异步审批，无需同步等待。每个请求携带唯一`requestId`用于追踪。

### 3.5 Circuit Breaker防御

退出Plan模式时，系统会检查Auto模式的circuit breaker状态：

```typescript
// ExitPlanModeV2Tool.ts - call()
let gateFallbackNotification: string | null = null
if (feature('TRANSCRIPT_CLASSIFIER')) {
  const prePlanRaw = appState.toolPermissionContext.prePlanMode ?? 'default'
  if (
    prePlanRaw === 'auto' &&
    !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)
  ) {
    // prePlanMode是auto，但gate已关闭 → 回退到default
    const reason = permissionSetupModule?.getAutoModeUnavailableReason()
      ?? 'circuit-breaker'
    gateFallbackNotification =
      permissionSetupModule?.getAutoModeUnavailableNotification(reason)
  }
}
```

**关键洞察**：Circuit Breaker防御确保了即使在Plan模式期间Auto模式的gate被触发（例如服务端配置变更），退出Plan模式时也不会恢复到一个不可用的模式。系统会优雅地回退到`default`模式，并通过通知告知用户。

### 3.6 权限Strip/Restore机制

```typescript
// ExitPlanModeV2Tool.ts - call() 内的 setAppState
context.setAppState(prev => {
  // ...
  let restoreMode = prev.toolPermissionContext.prePlanMode ?? 'default'

  // Circuit breaker检查
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (restoreMode === 'auto' && !isAutoModeGateEnabled()) {
      restoreMode = 'default'  // 回退
    }
    // ...
  }

  // 权限恢复逻辑
  const restoringToAuto = restoreMode === 'auto'
  let baseContext = prev.toolPermissionContext
  if (restoringToAuto) {
    // 恢复到auto → 保持权限剥离
    baseContext = stripDangerousPermissionsForAutoMode(baseContext)
  } else if (prev.toolPermissionContext.strippedDangerousRules) {
    // 恢复到非auto → 还原被剥离的权限
    baseContext = restoreDangerousPermissions(baseContext)
  }

  return {
    ...prev,
    toolPermissionContext: {
      ...baseContext,
      mode: restoreMode,
      prePlanMode: undefined,  // 清除保存的模式
    },
  }
})
```

### 3.7 requiresUserInteraction()：Headless审批

```typescript
requiresUserInteraction() {
  // 所有Teammate不需要本地用户交互
  if (isTeammate()) {
    return false
  }
  // 非Teammate需要用户确认
  return true
}
```

**设计模式**：Headless Approval——Teammate通过邮箱实现无头审批，不阻塞本地终端。这使多Agent协作可以在后台异步进行。

---

## 四、权限模式体系 (PermissionMode)

### 4.1 模式全景

```
┌─────────────────────────────────────────────────────────────────┐
│                    PermissionMode 体系                           │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              ExternalPermissionMode (5个)                 │   │
│  │  ┌────────────┐ ┌──────────┐ ┌─────────┐ ┌──────────┐  │   │
│  │  │acceptEdits  │ │bypassPerms│ │ default │ │ dontAsk  │  │   │
│  │  └────────────┘ └──────────┘ └─────────┘ └──────────┘  │   │
│  │  ┌────────────┐                                           │   │
│  │  │   plan     │                                           │   │
│  │  └────────────┘                                           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Internal-Only Mode (2个)                     │   │
│  │  ┌────────────┐ ┌──────────┐                             │   │
│  │  │   auto     │ │  bubble  │                             │   │
│  │  │(TRANSCRIPT_ │ │          │                             │   │
│  │  │ CLASSIFIER)│ │          │                             │   │
│  │  └────────────┘ └──────────┘                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  完整类型: PermissionMode = ExternalPermissionMode | 'auto' | 'bubble'│
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 模式详细对比

| 模式 | 外部可见 | Symbol | Color | 说明 |
|------|---------|--------|-------|------|
| `default` | 是 | (空) | text | 默认模式，每次工具调用需用户确认 |
| `plan` | 是 | PAUSE_ICON | planMode | Plan模式，只读探索+规划 |
| `acceptEdits` | 是 | ⏵⏵ | autoAccept | 自动接受文件编辑 |
| `bypassPermissions` | 是 | ⏵⏵ | error | 跳过所有权限检查（危险） |
| `dontAsk` | 是 | ⏵⏵ | error | 不询问，自动执行 |
| `auto` | 否 | ⏵⏵ | warning | Auto模式，分类器自动审批（TRANSCRIPT_CLASSIFIER） |
| `bubble` | 否 | - | - | 内部模式，权限冒泡 |

### 4.3 ToolPermissionContext

```typescript
export type ToolPermissionContext = {
  readonly mode: PermissionMode                    // 当前权限模式
  readonly additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>
  readonly alwaysAllowRules: ToolPermissionRulesBySource    // 自动允许规则
  readonly alwaysDenyRules: ToolPermissionRulesBySource     // 自动拒绝规则
  readonly alwaysAskRules: ToolPermissionRulesBySource      // 自动询问规则
  readonly isBypassPermissionsModeAvailable: boolean
  readonly strippedDangerousRules?: ToolPermissionRulesBySource  // 被剥离的危险权限（stash）
  readonly shouldAvoidPermissionPrompts?: boolean
  readonly awaitAutomatedChecksBeforeDialog?: boolean
  readonly prePlanMode?: PermissionMode             // Plan模式保存的前置模式
}
```

**关键洞察**：`prePlanMode`和`strippedDangerousRules`是Plan模式Save-Restore语义的核心字段。`prePlanMode`记录进入Plan前的模式，`strippedDangerousRules`暂存被剥离的危险权限规则，退出时还原。

### 4.4 PermissionUpdate判别联合

PermissionUpdate是一个6种操作的判别联合（Discriminated Union），通过`type`字段区分：

```typescript
export type PermissionUpdate =
  | { type: 'addRules';      destination; rules; behavior }      // 添加规则
  | { type: 'replaceRules';  destination; rules; behavior }      // 替换规则
  | { type: 'removeRules';   destination; rules; behavior }      // 移除规则
  | { type: 'setMode';       destination; mode }                 // 设置模式
  | { type: 'addDirectories'; destination; directories }         // 添加目录
  | { type: 'removeDirectories'; destination; directories }      // 移除目录
```

**设计模式**：判别联合（Discriminated Union）——通过`type`字段实现类型安全的模式匹配，编译器可以在`switch`中自动穷举所有分支。

---

## 五、Plan模式与Auto模式的交互

### 5.1 交互全景

Plan模式和Auto模式的交互是整个权限系统中最复杂的部分，涉及多个状态维度：

```
┌──────────────────────────────────────────────────────────────────┐
│               Plan ↔ Auto 模式交互状态机                           │
│                                                                  │
│                    ┌──────────┐                                  │
│                    │  default │                                  │
│                    └────┬─────┘                                  │
│                         │                                        │
│              ┌──────────┼──────────┐                             │
│              │          │          │                             │
│              v          v          v                             │
│        ┌──────────┐ ┌───────┐ ┌──────────┐                     │
│        │  accept  │ │ auto  │ │  plan    │                     │
│        │  Edits   │ │       │ │(from def)│                     │
│        └──────────┘ └───┬───┘ └──────────┘                     │
│                         │                                        │
│                    ┌────┴────┐                                   │
│                    │         │                                   │
│                    v         v                                   │
│              ┌──────────┐ ┌──────────┐                          │
│              │  plan    │ │  plan    │                          │
│              │(from auto│ │(auto     │                          │
│              │ opt-out) │ │ active)  │                          │
│              └──────────┘ └──────────┘                          │
│                                                                  │
│  关键状态变量:                                                   │
│  - mode: 当前权限模式                                            │
│  - prePlanMode: 进入Plan前的模式                                  │
│  - isAutoModeActive(): Auto分类器是否激活                         │
│  - strippedDangerousRules: 被暂存的危险权限                        │
│  - isAutoModeGateEnabled(): Auto模式gate是否开启                  │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2 prepareContextForPlanMode()

这是进入Plan模式时的核心准备函数，处理所有Auto模式相关的副作用：

```typescript
export function prepareContextForPlanMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const currentMode = context.mode
  if (currentMode === 'plan') return context  // 已在Plan中

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const planAutoMode = shouldPlanUseAutoMode()

    // 场景1: 从auto进入plan，且plan期间保持auto
    if (currentMode === 'auto') {
      if (planAutoMode) {
        return { ...context, prePlanMode: 'auto' }
      }
      // 从auto进入plan，但plan期间不使用auto → 关闭分类器，恢复权限
      autoModeStateModule?.setAutoModeActive(false)
      setNeedsAutoModeExitAttachment(true)
      return {
        ...restoreDangerousPermissions(context),
        prePlanMode: 'auto',
      }
    }

    // 场景2: 从非auto进入plan，但用户opt-in了plan期间使用auto
    if (planAutoMode && currentMode !== 'bypassPermissions') {
      autoModeStateModule?.setAutoModeActive(true)
      return {
        ...stripDangerousPermissionsForAutoMode(context),
        prePlanMode: currentMode,
      }
    }
  }

  // 场景3: 普通plan进入
  return { ...context, prePlanMode: currentMode }
}
```

**三种进入场景对比**：

| 场景 | 前置模式 | Plan中Auto | prePlanMode | 权限处理 |
|------|---------|-----------|-------------|---------|
| Auto→Plan（保持Auto） | auto | 是 | 'auto' | 无变化 |
| Auto→Plan（关闭Auto） | auto | 否 | 'auto' | 恢复危险权限 |
| Default→Plan（启用Auto） | default | 是 | 'default' | 剥离危险权限 |
| Default→Plan（普通） | default | 否 | 'default' | 无变化 |

### 5.3 transitionPlanAutoMode()

当用户在Plan模式期间修改设置（如切换`useAutoModeDuringPlan`）时，此函数负责调和Auto模式状态：

```typescript
export function transitionPlanAutoMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (!feature('TRANSCRIPT_CLASSIFIER')) return context
  if (context.mode !== 'plan') return context
  // 从bypassPermissions进入plan时，永不激活auto
  if (context.prePlanMode === 'bypassPermissions') return context

  const want = shouldPlanUseAutoMode()     // 期望状态
  const have = autoModeStateModule?.isAutoModeActive() ?? false  // 实际状态

  if (want && have) {
    // 两者一致且为true → 重新剥离（syncPermissionRulesFromDisk可能重新添加了危险规则）
    return stripDangerousPermissionsForAutoMode(context)
  }
  if (!want && !have) return context  // 两者一致且为false → 无操作

  if (want) {
    // 需要激活auto
    autoModeStateModule?.setAutoModeActive(true)
    setNeedsAutoModeExitAttachment(false)
    return stripDangerousPermissionsForAutoMode(context)
  }
  // 需要关闭auto
  autoModeStateModule?.setAutoModeActive(false)
  setNeedsAutoModeExitAttachment(true)
  return restoreDangerousPermissions(context)
}
```

### 5.4 危险权限剥离与恢复

#### 5.4.1 危险权限判定

```typescript
// 三类危险权限检查
function isDangerousClassifierPermission(toolName, ruleContent): boolean {
  return (
    isDangerousBashPermission(toolName, ruleContent) ||      // Bash通配/解释器
    isDangerousPowerShellPermission(toolName, ruleContent) || // PowerShell危险cmdlet
    isDangerousTaskPermission(toolName, ruleContent)          // Agent工具
  )
}
```

**危险Bash权限模式**：

| 模式 | 示例 | 危险原因 |
|------|------|---------|
| 工具级允许 | `Bash` / `Bash(*)` | 允许所有命令 |
| 解释器前缀 | `python:*` / `node:*` | 允许任意代码执行 |
| 通配符匹配 | `python*` / `node*` | 匹配所有解释器变体 |
| 参数通配 | `python -*` | 允许`python -c 'code'` |

#### 5.4.2 Strip与Restore流程

```
┌─────────────────────────────────────────────────────────────┐
│              危险权限 Strip/Restore 流程                      │
│                                                             │
│  进入Auto/Plan(Auto)时:                                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ stripDangerousPermissionsForAutoMode(context)        │  │
│  │  1. 遍历 alwaysAllowRules 所有来源                   │  │
│  │  2. 识别危险规则 (Bash(*), python:*, Agent, etc.)    │  │
│  │  3. 从context中移除危险规则                          │  │
│  │  4. 暂存到 strippedDangerousRules (按来源分组)        │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  退出到非Auto模式时:                                         │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ restoreDangerousPermissions(context)                 │  │
│  │  1. 读取 strippedDangerousRules                      │  │
│  │  2. 按来源重新添加到context                          │  │
│  │  3. 清除 strippedDangerousRules (防止重复恢复)        │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  数据结构:                                                   │
│  strippedDangerousRules: {                                  │
│    userSettings: ['Bash(python:*)', 'Agent(*)'],           │
│    cliArg: ['Bash(*)'],                                    │
│  }                                                          │
└─────────────────────────────────────────────────────────────┘
```

### 5.5 Circuit Breaker与模式转换的集成

Circuit Breaker可以在Plan模式期间被触发，系统需要优雅地处理这种情况：

```
┌──────────────────────────────────────────────────────────────┐
│            Circuit Breaker 集成时序                            │
│                                                              │
│  t=0: 用户在auto模式，进入plan                               │
│       prePlanMode = 'auto'                                   │
│       isAutoModeActive = true                                │
│                                                              │
│  t=1: Plan模式中，用户探索代码库                              │
│                                                              │
│  t=2: 服务端触发circuit breaker                              │
│       isAutoModeGateEnabled() → false                        │
│                                                              │
│  t=3: 用户退出plan模式                                       │
│       ┌─────────────────────────────────────────────┐       │
│       │ 检查: prePlanMode='auto'                     │       │
│       │       但 isAutoModeGateEnabled()=false       │       │
│       │ → restoreMode = 'default' (而非'auto')       │       │
│       │ → 通知用户: "auto mode unavailable"           │       │
│       │ → 恢复危险权限 (因为目标是default)             │       │
│       └─────────────────────────────────────────────┘       │
│                                                              │
│  结果: 用户安全回退到default模式，不会卡在不可用的auto模式     │
└──────────────────────────────────────────────────────────────┘
```

---

## 六、对EvoAgent的参考价值

### 6.1 价值总览

| # | 参考价值 | 来源机制 | 适用场景 |
|---|---------|---------|---------|
| 1 | 探索/执行硬边界 | Plan Mode两阶段生命周期 | EvoAgent的任务分解与执行 |
| 2 | 异步审批模式 | Teammate邮箱审批 | 多Agent协作中的任务审批 |
| 3 | Save-Restore权限语义 | prePlanMode + strippedDangerousRules | 模式切换时的状态保全 |
| 4 | Circuit Breaker集成 | Auto模式gate与Plan退出 | 运行时安全策略动态调整 |
| 5 | 权限Strip/Restore | 危险权限暂存与恢复 | 安全关键的模式变更 |

### 6.2 探索/执行硬边界

**claude-code的做法**：Plan模式通过权限系统强制执行只读约束。在Plan阶段，写入工具的权限被系统级限制，而非依赖模型自律。

**对EvoAgent的启发**：

```
┌──────────────────────────────────────────────────────────────┐
│              EvoAgent 探索/执行边界设计                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Phase 1: 探索阶段 (Explore)                          │   │
│  │  - 只读工具: Glob, Grep, Read, WebSearch              │   │
│  │  - 禁止工具: Write, Edit, Bash(写操作), API(写操作)    │   │
│  │  - 产出: 探索报告 + 实施方案                           │   │
│  │  - 硬边界: 权限系统拒绝写入操作                        │   │
│  └──────────────────────────────────────────────────────┘   │
│                         │ 审批通过                             │
│                         v                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Phase 2: 执行阶段 (Execute)                          │   │
│  │  - 全部工具可用                                       │   │
│  │  - 按方案逐步执行                                     │   │
│  │  - 每步验证结果                                       │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 6.3 异步审批模式

**claude-code的做法**：Teammate通过`writeToMailbox('team-lead', ...)`发送审批请求，Leader异步审批后通过邮箱返回结果。

**对EvoAgent的启发**：

```
┌──────────────────────────────────────────────────────────────┐
│              EvoAgent 异步审批设计                              │
│                                                              │
│  实现要素:                                                    │
│  1. 唯一请求ID (requestId) — 追踪审批状态                     │
│  2. 持久化消息通道 (mailbox) — 跨进程/跨Agent通信              │
│  3. 状态标记 (awaitingApproval) — 防止重复提交                │
│  4. 超时机制 — 防止审批挂起                                   │
│  5. 审批结果结构化 — 包含批准/拒绝/修改建议                    │
│                                                              │
│  扩展方向:                                                    │
│  - 多级审批链 (Agent → Team Lead → Human)                    │
│  - 审批超时自动升级                                           │
│  - 批量审批 (多个Plan合并审批)                                 │
└──────────────────────────────────────────────────────────────┘
```

### 6.4 Save-Restore权限语义

**claude-code的做法**：`prePlanMode`字段保存进入前的模式，`strippedDangerousRules`暂存被剥离的权限，退出时精确还原。

**对EvoAgent的启发**：

```typescript
// 推荐的EvoAgent模式切换接口
interface ModeTransition {
  fromMode: AgentMode
  toMode: AgentMode
  savedState: {
    previousMode: AgentMode
    strippedCapabilities: Capability[]  // 被限制的能力
    timestamp: number
  }
  circuitBreakerCheck: () => boolean   // 退出前的安全检查
}
```

### 6.5 Circuit Breaker集成

**claude-code的做法**：Auto模式的circuit breaker可以在Plan模式期间被触发，退出时系统检查gate状态并优雅回退。

**对EvoAgent的启发**：

- 模式切换时始终检查目标模式的可用性
- 不可用时回退到安全的默认模式（Fail-Closed原则）
- 通过通知机制告知用户模式变更原因
- 避免将Agent困在不可用的模式中（"只进不出"防护）

### 6.6 权限Strip/Restore

**claude-code的做法**：进入Auto模式时剥离危险权限（如`Bash(*)`、`python:*`），退出时精确还原。暂存结构按来源分组，确保还原时回到正确的位置。

**对EvoAgent的启发**：

```
┌──────────────────────────────────────────────────────────────┐
│              EvoAgent 能力限制设计                              │
│                                                              │
│  核心原则:                                                    │
│  1. 进入受限模式时，暂存被限制的能力（而非删除）                 │
│  2. 按来源分组暂存，确保还原时精确恢复                          │
│  3. 使用"暂存+清除"模式防止重复还原                             │
│  4. 还原前检查目标模式是否仍然安全                              │
│                                                              │
│  适用场景:                                                    │
│  - 自动模式: 限制高风险操作，由分类器逐个审批                   │
│  - 沙箱模式: 限制文件系统/网络访问                             │
│  - 审计模式: 记录所有操作但不执行                              │
│  - 演示模式: 只允许只读操作                                    │
└──────────────────────────────────────────────────────────────┘
```

---

## 附录：核心源文件索引

| 文件路径 | 核心职责 |
|---------|---------|
| `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts` | Plan模式进入工具实现 |
| `src/tools/EnterPlanModeTool/prompt.ts` | EnterPlanMode的Prompt（含Ant/External双版本） |
| `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` | Plan模式退出工具实现（含Teammate审批） |
| `src/tools/ExitPlanModeTool/prompt.ts` | ExitPlanMode的Prompt |
| `src/utils/permissions/permissionSetup.ts` | 权限模式转换核心逻辑（prepareContextForPlanMode、transitionPlanAutoMode等） |
| `src/utils/permissions/PermissionMode.ts` | 权限模式定义与配置 |
| `src/utils/permissions/PermissionUpdate.ts` | 权限更新操作实现（applyPermissionUpdate） |
| `src/types/permissions.ts` | 权限类型定义（ToolPermissionContext、PermissionUpdate等） |
| `src/utils/planModeV2.ts` | Plan模式V2特性（Interview阶段、Agent计数等） |
| `src/bootstrap/state.ts` | 全局状态管理（handlePlanModeTransition等） |
