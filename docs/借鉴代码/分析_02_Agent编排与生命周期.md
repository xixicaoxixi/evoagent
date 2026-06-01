# 分析_02_Agent编排与生命周期

> **轮次**：第 2 轮 — Agent 编排 + 生命周期 + Git Worktree 并行
>
> **日期**：2026-04-11
>
> **阅读量**：~530 KB（coordinator + AgentTool + tasks + harness + ACP + worktree）
>
> **产出价值**：Agent 创建→执行→销毁的完整生命周期模式、多 Agent 任务分解与结果聚合、状态机设计、编排模式、Git Worktree 隔离并行策略

---

## 一、核心发现摘要

本轮深入分析了两个项目的 Agent 编排系统，发现了**两种截然不同但同样精妙的编排哲学**：

| 维度 | claude-code-sourcemap | openclaw |
|------|----------------------|----------|
| **编排模式** | Coordinator（协调者）+ Worker（工人）层级 | Harness（线束）+ Runtime（运行时）插件化 |
| **通信机制** | 邮箱文件 + 任务通知 XML | ACP 协议 + Gateway WebSocket |
| **并行策略** | Git Worktree 文件级隔离 | 会话级隔离 + Actor 队列串行化 |
| **生命周期** | 同步/异步双模式 + 前后台切换 | 运行时缓存 + 空闲驱逐 + 身份协调 |
| **Agent 定义** | Markdown frontmatter + 多源合并 | 配置文件 + 插件注册 + 模型目录 |
| **故障转移** | 无（单模型） | 模型级故障转移链 + Harness 回退 |

---

## 二、claude-code-sourcemap 的 Agent 编排体系

### 2.1 整体架构：Coordinator-Worker 模式

```
┌─────────────────────────────────────────────────────────────────┐
│                    Coordinator（协调者）                         │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  coordinatorMode.ts — 系统提示词 + 上下文注入             │  │
│  │  核心工具：Agent（创建工人）/ SendMessage（续接）/        │  │
│  │            TaskStop（停止）/ TeamCreate（团队）           │  │
│  └──────────────────────────┬───────────────────────────────┘  │
│                             │                                   │
│         ┌───────────────────┼───────────────────┐              │
│         ▼                   ▼                   ▼              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│  │  Worker A   │    │  Worker B   │    │  Worker C   │        │
│  │ (research)  │    │ (implement) │    │ (verify)    │        │
│  │ async agent │    │ async agent │    │ async agent │        │
│  └─────────────┘    └─────────────┘    └─────────────┘        │
│         │                   │                   │              │
│         └───────────────────┼───────────────────┘              │
│                             ▼                                   │
│                    <task-notification> XML                      │
│                    结果回传给 Coordinator                        │
└─────────────────────────────────────────────────────────────────┘
```

#### 2.1.1 Coordinator 模式的核心设计

**触发条件**：环境变量 `CLAUDE_CODE_COORDINATOR_MODE=1` + Feature Gate `COORDINATOR_MODE`

**系统提示词结构**（`getCoordinatorSystemPrompt()` 返回 ~370 行详细指令）：

```
## 1. Your Role — 协调者定位
## 2. Your Tools — 工具集（Agent/SendMessage/TaskStop）
## 3. Workers — 工人能力描述
## 4. Task Workflow — 四阶段工作流
## 5. Writing Worker Prompts — 提示词编写指南
## 6. Example Session — 完整示例
```

**关键设计洞察**：

1. **四阶段工作流**：Research（并行研究）→ Synthesis（协调者综合）→ Implementation（工人实现）→ Verification（工人验证）。协调者明确被要求"不要把理解工作委托给工人"——这是防止"懒代理"问题的关键约束。

2. **并行策略指导**：
   - 只读任务（研究）→ 自由并行
   - 写入任务（实现）→ 同一文件集一次一个
   - 验证任务 → 可与不同文件区域的实现并行

3. **Continue vs Spawn 决策矩阵**：

   | 情境 | 机制 | 原因 |
   |------|------|------|
   | 研究恰好覆盖需要编辑的文件 | **Continue**（SendMessage） | 工人已有文件上下文 |
   | 研究广泛但实现狭窄 | **Spawn fresh**（Agent） | 避免拖拽探索噪声 |
   | 修正失败或扩展近期工作 | **Continue** | 工人有错误上下文 |
   | 验证不同工人写的代码 | **Spawn fresh** | 验证者应以全新视角审视 |
   | 完全不相关任务 | **Spawn fresh** | 无可用上下文 |

4. **结果通知格式**：工人完成后以 `<task-notification>` XML 格式回传，包含 `task-id`、`status`、`summary`、`result`、`usage` 五个字段。协调者被明确告知"不要感谢或确认工人结果"。

#### 2.1.2 工人能力约束

`getCoordinatorUserContext()` 动态生成工人能力描述：

- **Simple 模式**：仅 Bash + Read + Edit
- **完整模式**：全部工具减去内部工具（TeamCreate/TeamDelete/SendMessage/SyntheticOutput）
- **MCP 工具**：工人继承协调者的 MCP 服务器连接
- **Scratchpad 目录**：Feature Gate 控制的跨工人共享写入空间

### 2.2 AgentTool — 子代理调度的统一入口

#### 2.2.1 策略路由架构

```
AgentTool.call(input, context)
    │
    ├── subagent_type === "teammate" → InProcessTeammateTask 路径
    │   └── 团队内队友，共享 AsyncLocalStorage 上下文
    │
    ├── team_name 存在 → Team Agent 路径
    │   └── 团队成员，通过邮箱机制通信
    │
    ├── subagent_type === "fork" → ForkSubagent 路径
    │   └── 继承父代理完整上下文，占位符 tool_result
    │
    ├── isolation === "worktree" → Git Worktree 隔离路径
    │   └── 创建独立 worktree，切换工作目录
    │
    ├── isolation === "remote" → 远程 CCR 启动路径（ant-only）
    │
    └── 默认 → 普通 Agent 路径
        ├── 同步执行（前台）：Promise.race + 动态转后台
        └── 异步执行（后台）：registerAsyncAgent + void runAsyncAgentLifecycle
```

#### 2.2.2 Fork 子代理实验

Fork 是一种创新的上下文共享机制：

```
父代理消息历史:
  [user] "Fix the auth bug"
  [assistant] tool_use: Read(src/auth.ts)
              tool_use: Grep("null pointer")
  [tool_result] "file contents..."
  [tool_result] "found at line 42"

Fork 子代理消息（继承 + 追加）:
  [user] "Fix the auth bug"
  [assistant] tool_use: Read(src/auth.ts)     ← 完整继承
              tool_use: Grep("null pointer")  ← 完整继承
  [tool_result] "Fork started -- processing"  ← 占位符（相同字节长度）
  [tool_result] "Fork started -- processing"  ← 占位符（相同字节长度）
  [user] "Fix the null pointer in src/auth/validate.ts:42..."  ← 独有指令
```

**关键优化**：所有 Fork 子代理的 API 请求前缀字节完全一致（只有最后的指令文本不同），最大化 Prompt Cache 命中率。递归防护通过消息中的 `FORK_BOILERPLATE_TAG` 标记和 `querySource` 双重检测实现。

#### 2.2.3 工具过滤机制

`filterToolsForAgent()` 实现多层过滤管道：

```
全部工具
  │
  ├── MCP 工具 → 始终放行
  │
  ├── 全局禁止列表 → 过滤
  │
  ├── 代理自定义禁止列表 → 过滤
  │
  ├── ASYNC_AGENT_ALLOWED_TOOLS → 白名单过滤（异步代理）
  │
  └── In-process Teammate 特殊放行
      └── 允许 AgentTool + 任务管理工具
```

### 2.3 任务系统 — 七种任务类型的统一框架

#### 2.3.1 任务类型全景

```
TaskState（联合类型）
├── LocalShellTask        — 本地 Shell 命令（bash/monitor）
├── LocalAgentTask        — 本地后台代理（最常用）
├── RemoteAgentTask       — 远程 Claude.ai 会话
├── InProcessTeammateTask — 进程内队友（团队模式）
├── LocalWorkflowTask     — 本地工作流
├── MonitorMcpTask        — MCP 监控任务
└── DreamTask             — 自动梦境整合（后台）
```

#### 2.3.2 LocalAgentTask — 最核心的任务类型

**生命周期状态机**：

```
                    registerAsyncAgent()
                           │
                           ▼
                      ┌─────────┐
                      │ pending │ ←── (短暂过渡)
                      └────┬────┘
                           │ runAsyncAgentLifecycle()
                           ▼
                      ┌─────────┐
           ┌────────→│ running │←──────────┐
           │         └────┬────┘           │
           │              │                │
           │    ┌─────────┼─────────┐      │
           │    ▼         ▼         ▼      │
           │ completed   failed    killed  │
           │    │         │         │      │
           │    ▼         ▼         ▼      │
           │  notified  notified  notified │
           │    │         │         │      │
           └────┴─────────┴─────────┴──────┘
                              │
                              ▼
                          evicted（UI 层驱逐）
```

**前后台切换机制**：

```
registerAgentForeground()
    │
    ├── isBackgrounded = false（前台运行）
    ├── backgroundSignal: Promise（后台化信号）
    └── autoBackgroundMs（可选，定时自动后台化）
                           │
                    Ctrl+B / autoBackground
                           │
                           ▼
              backgroundAgentTask()
                    │
                    ▼
              isBackgrounded = true
              → enqueueAgentNotification()（完成时通知）
```

**ProgressTracker 的 Token 计算策略**：
- Input tokens：取最新值（API 返回的是累积值）
- Output tokens：累加（API 每轮返回独立值）
- 这种差异化处理避免了双重计算

#### 2.3.3 InProcessTeammateTask — 团队队友

与 LocalAgentTask 的关键差异：

| 维度 | LocalAgentTask | InProcessTeammateTask |
|------|---------------|----------------------|
| **运行环境** | 独立 AsyncLocalStorage | 共享进程，AsyncLocalStorage 隔离 |
| **身份** | 匿名 agentId | agentName@teamName |
| **通信** | 任务通知 XML | 邮箱文件 + pendingUserMessages 队列 |
| **Plan Mode** | 不支持 | 支持（awaitingPlanApproval） |
| **空闲状态** | 无 | 支持（isIdle + onIdleCallbacks） |
| **终止方式** | abortController | 双 AbortController（全局 + 当前轮次） |

**内存优化**：`TEAMMATE_MESSAGES_UI_CAP = 50` 限制 UI 层消息数组大小。BQ 分析数据表明：每个代理 500+ 轮会话约 20MB RSS，292 个代理并发达到 36.8GB。消息封顶是必要的内存保护措施。

#### 2.3.4 RemoteAgentTask — 远程会话

**可插拔完成检查器**：通过 `registerCompletionChecker(type, checker)` 注册类型特定的完成逻辑（如 autofix-pr 检查 PR 状态），与通用轮询解耦。

**稳定空闲检测**：远程会话在工具轮次间会短暂变为 idle，需要连续 5 次无增长才确认完成，避免误判。

**Session sidecar 持久化**：远程任务元数据写入独立文件，`--resume` 时通过 API 查询实际状态来决定是否恢复，而非信任本地存储。

#### 2.3.5 DreamTask — 梦境整合

纯 UI 适配层，将 auto-dream 内存整合功能注册到统一任务框架。关键设计：
- **整合锁回滚**：kill 时回滚锁文件时间戳，允许下次会话重试
- **保守文件追踪**：`filesTouched` 仅记录 Edit/Write 路径，标注为"至少修改了这些"
- **无通知路径**：完成时立即设置 `notified: true`，通过 inline 系统消息展示

### 2.4 Agent 定义系统 — 多源合并

#### 2.4.1 五种 Agent 定义来源

```
优先级（低→高）：
  built-in（内置） < plugin（插件） < userSettings（用户） < projectSettings（项目） < flagSettings（策略）
```

**Markdown frontmatter 解析**（`parseAgentFromMarkdown()`）：

```markdown
---
name: security-reviewer
description: Security audit specialist
tools:
  - Read
  - Grep
  - Bash
model: sonnet
permissionMode: dontAsk
mcpServers:
  - security-scanner
hooks:
  PostToolUse: ./hooks/audit.js
maxTurns: 20
memory: true
isolation: worktree
---

You are a security review specialist. Focus on:
1. Input validation
2. Authentication vulnerabilities
3. Authorization checks
...
```

#### 2.4.2 六种内置代理

| 代理 | 类型 | 模型 | 工具 | 特殊能力 |
|------|------|------|------|---------|
| **generalPurpose** | 通用 | inherit | `['*']` | 搜索、分析、多步骤研究 |
| **explore** | 只读 | haiku（外部） | 禁止 Edit/Write/NotebookEdit | `omitClaudeMd` 节省 token |
| **plan** | 只读 | inherit | 禁止 Edit/Write/NotebookEdit | 输出 "Critical Files" 列表 |
| **verification** | 对抗性 | inherit | 全部 | 尝试破坏实现，PASS/FAIL 判定 |
| **claudeCodeGuide** | 文档 | haiku | WebFetch/WebSearch | 动态注入用户配置上下文 |
| **statuslineSetup** | 配置 | sonnet | Read/Edit | 状态栏 JSON 配置 |

**Feature Gate 控制**：Explore/Plan 受 `BUILTIN_EXPLORE_PLAN_AGENTS` + `tengu_amber_stoat` A/B 实验控制；Verification 受 `tengu_hive_evidence` 控制。

### 2.5 Git Worktree 并行隔离策略

#### 2.5.1 EnterWorktree 工具

**工作流程**：

```
EnterWorktree.call({ name: "fix-auth" })
    │
    ├── 检查是否已在 worktree 中 → 若是，抛错
    │
    ├── 解析主仓库根目录
    │
    ├── 若当前在子 worktree 中 → 先切回主仓库
    │
    ├── createWorktreeForSession("fix-auth")
    │   └── git worktree add .claude/worktrees/fix-auth -b fix-auth
    │
    ├── 切换进程工作目录 → 新 worktree 路径
    │
    ├── 清除系统提示缓存 + 内存文件缓存
    │
    └── 返回 { worktreePath, worktreeBranch, message }
```

**关键设计**：
- `shouldDefer: true` — 支持权限确认流程
- 支持 Hook 机制（WorktreeCreate/WorktreeRemove），非 git 仓库也能通过自定义 Hook 实现 worktree 隔离
- 严格的触发条件 — 仅在用户显式提及 "worktree" 时使用

#### 2.5.2 Worktree 与 Agent 的结合

Agent 工具支持 `isolation: "worktree"` 参数，自动为子代理创建隔离的 worktree：

```
AgentTool.call({
  description: "Fix auth bug",
  isolation: "worktree",
  prompt: "Fix the null pointer..."
})
    │
    ├── 创建 worktree（自动命名）
    ├── 在 worktree 中启动子代理
    ├── 子代理的所有文件操作都在隔离分支上
    └── 完成后通知协调者（含 worktree 信息）
```

**与 A/B 测试的天然契合**：多个工人在不同 worktree 分支上并行工作，互不冲突。协调者可以比较不同方案的结果。

### 2.6 通信机制 — 邮箱 + 任务通知

#### 2.6.1 Agent 间通信

```
Coordinator → Worker（创建）: AgentTool.call()
Coordinator → Worker（续接）: SendMessageTool.call({ to: agentId, message: "..." })
Worker → Coordinator（结果）: <task-notification> XML（作为 user-role 消息注入）
Worker → Worker（不直接通信）: 通过 Coordinator 中转
```

**SendMessageTool 的路由策略**：

| 目标格式 | 路由方式 | 安全级别 |
|---------|---------|---------|
| `teammate-name` | 邮箱文件写入 | 标准 |
| `*`（广播） | 遍历所有团队成员 | 标准 |
| `uds:socket-path` | Unix Domain Socket | 标准 |
| `bridge:session-id` | Remote Control Bridge | `classifierApprovable: false` |

#### 2.6.2 TeamCreate — 团队编排

```
TeamCreate.call({ team_name: "auth-fix" })
    │
    ├── 检查是否已在团队中（每个 leader 只能管理一个团队）
    │
    ├── 生成确定性 Agent ID（team-lead）
    │
    ├── 创建 TeamFile → 写入磁盘
    │
    ├── 创建对应 TaskList 目录
    │
    └── 注册到 AppState.teamContext
```

**设计洞察**：Team = TaskList 的 1:1 映射。故意不设置 `CLAUDE_CODE_AGENT_ID` 给 team-lead，以保持 `isTeammate()` 返回 false，避免 inbox 轮询逻辑混乱。

---

## 三、openclaw 的 Agent 编排体系

### 3.1 整体架构：Harness + Runtime 插件化模式

```
┌─────────────────────────────────────────────────────────────────┐
│                    agent-command.ts（编排层）                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  prepareAgentCommandExecution()                          │  │
│  │  ├─ 参数解析与验证                                       │  │
│  │  ├─ 会话上下文解析                                       │  │
│  │  ├─ 模型选择（model-selection.ts）                      │  │
│  │  ├─ 认证配置（resolveAgentRuntimeConfig）               │  │
│  │  ├─ 工作空间准备                                         │  │
│  │  └─ ACP 会话解析                                         │  │
│  └──────────────────────────┬───────────────────────────────┘  │
│                             │                                   │
│                    ┌────────▼────────┐                          │
│                    │  Harness 层     │                          │
│                    │  (策略选择)     │                          │
│                    └────────┬────────┘                          │
│                             │                                   │
│         ┌───────────────────┼───────────────────┐              │
│         ▼                   ▼                   ▼              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│  │ Plugin A    │    │ Plugin B    │    │ PI 内置     │        │
│  │ Harness     │    │ Harness     │    │ Harness     │        │
│  │ (priority:5)│    │ (priority:3)│    │ (priority:0)│        │
│  └─────────────┘    └─────────────┘    └─────────────┘        │
│         │                   │                   │              │
│         └───────────────────┼───────────────────┘              │
│                             ▼                                   │
│              ┌──────────────────────────┐                      │
│              │  pi-embedded-runner      │                      │
│              │  (执行引擎)              │                      │
│              │  ├─ 模型调用（流式）     │                      │
│              │  ├─ 会话管理             │                      │
│              │  ├─ 上下文压缩           │                      │
│              │  └─ pi-hooks（生命周期）  │                      │
│              └──────────────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 AgentHarness — 可插拔的运行时策略

#### 3.2.1 核心接口

```
AgentHarness（核心接口）
├── id: string                    // 唯一标识
├── label: string                 // 显示名称
├── pluginId?: string             // 所属插件
├── supports(ctx): { supported: boolean, priority: number }
│   └── ctx: { provider, modelId, requestedRuntime }
├── runAttempt(params): Promise<AgentHarnessAttemptResult>
│   └── params: { messages, model, systemPrompt, tools, ... }
├── compact?(params): Promise<AgentHarnessCompactResult>  // 可选
├── reset?(params): Promise<void>  // 可选（new/reset/idle/daily/compaction/deleted）
└── dispose?(): Promise<void>      // 可选
```

#### 3.2.2 选择策略（`selection.ts`）

```
selectAgentHarness(config)
    │
    ├── runtime === "pi" → 直接返回内置 PI Harness
    │
    ├── runtime === 具体ID → 查找插件 Harness
    │   ├── 找到 → 返回
    │   └── 未找到 → 根据 fallback 策略
    │       ├── fallback: "pi" → 回退到 PI
    │       └── fallback: "none" → 抛错
    │
    └── runtime === "auto" → 查询所有插件 Harness
        ├── 收集 supports() 返回 true 的
        ├── 按 priority 降序排序
        ├── 返回最高优先级的
        └── 无支持 → 回退到 PI（兜底）
```

**关键设计**：PI 作为内置兜底方案，priority 始终为 0（最低），确保只在无插件支持时被选中。策略支持 session 级别配置，允许不同会话使用不同的严格度。

#### 3.2.3 全局注册表

```
registerAgentHarness(harness, ownerPluginId)
    │
    └── globalThis[Symbol.for("openclaw.agentHarnessRegistryState")]
        └── Map<string, RegisteredAgentHarness>
```

通过 `Symbol.for` + `globalThis` 实现跨模块共享的全局注册表。批量操作（reset/dispose）使用 `Promise.all` + try/catch 确保单个失败不影响整体。

### 3.3 模型管理系统

#### 3.3.1 四层模型管理架构

```
┌─────────────────────────────────────────────────────────┐
│  model-catalog.ts — 模型目录（聚合所有可用模型）          │
│  ├─ SDK 注册表（内置模型发现）                           │
│  ├─ 配置文件（用户自定义）                               │
│  └─ Provider 插件（补充模型）                            │
├─────────────────────────────────────────────────────────┤
│  model-selection.ts — 模型选择与引用解析                 │
│  ├─ parseModelRef("provider/model") → ModelRef           │
│  ├─ buildModelAliasIndex() — 别名索引                    │
│  └─ resolveDefaultModelForAgent() — 默认模型解析         │
├─────────────────────────────────────────────────────────┤
│  model-fallback.ts — 模型故障转移                        │
│  ├─ runWithModelFallback(candidates, runFn)              │
│  └─ FallbackSummaryError — 所有候选耗尽                  │
├─────────────────────────────────────────────────────────┤
│  live-model-switch.ts — 运行时模型热切换                  │
│  ├─ requestLiveSessionModelSwitch() — 请求切换           │
│  └─ shouldSwitchToLiveModel() — 延迟切换判断             │
└─────────────────────────────────────────────────────────┘
```

#### 3.3.2 模型故障转移链

```
runWithModelFallback([modelA, modelB, modelC], runFn)
    │
    ├── 尝试 modelA → 失败 → 记录 FailoverError
    │   └── 检查冷却状态（避免对暂时不可用的模型发起无效请求）
    │
    ├── 尝试 modelB → 失败 → 记录 FailoverError
    │
    ├── 尝试 modelC → 失败 → 记录 FailoverError
    │
    └── 抛出 FallbackSummaryError
        └── 包含所有尝试的详细信息 + 最近冷却到期时间
```

**冷却感知**：考虑认证配置文件的冷却状态，避免对暂时不可用的模型发起无效请求。支持瞬态冷却探测槽位，允许在冷却期间探测模型可用性。

#### 3.3.3 运行时模型热切换

**延迟切换语义**：
- 不在工具调用中途切换，等待安全时机
- 如果运行无法立即重启（如工具调用进行中），标志保持设置状态
- 当当前模型已匹配持久化选择时，标志被提前清除以避免陈旧状态

### 3.4 上下文压缩系统

#### 3.4.1 两级压缩架构

```
┌─────────────────────────────────────────────────────────┐
│  Level 1: Context Pruning（轻量级，每次请求）            │
│  ├─ 软修剪：保留工具结果头尾各 1500 字符                │
│  ├─ 硬清除：替换为 [Old tool result content cleared]     │
│  ├─ 触发阈值：软 30% / 硬 50% 上下文窗口占比           │
│  └─ TTL 缓存：5 分钟内不重复修剪                        │
├─────────────────────────────────────────────────────────┤
│  Level 2: Compaction Safeguard（重量级，溢出时）         │
│  ├─ 双路径摘要：Provider（插件）> LLM（兜底）           │
│  ├─ 质量守卫：可配置重试，检查标识符保留和完整性        │
│  ├─ 自适应修剪：新内容占比过高时，修剪旧历史            │
│  └─ 后缀保护截断：诊断信息优先于主体保留                │
└─────────────────────────────────────────────────────────┘
```

#### 3.4.2 Context Pruning 算法

```
pruneContextMessages(messages, settings)
    │
    ├── 1. 估算当前 token 占比
    │
    ├── 2. 软修剪（占比 > softTrimRatio = 0.3）
    │   ├── 保护边界：第一个用户消息之前的内容不修剪
    │   ├── 尾部保护：保留最近 N 个 assistant 消息
    │   └── 对可修剪工具结果：保留头尾各 1500 字符
    │       └── 移除图片块
    │
    ├── 3. 硬清除（占比仍 > hardClearRatio = 0.5）
    │   └── 工具结果内容 → [Old tool result content cleared]
    │
    └── 4. 返回修剪后的消息数组
```

**工具过滤**：通过 glob 模式匹配决定哪些工具的结果可修剪。先检查 deny 列表，再检查 allow 列表。

#### 3.4.3 Compaction Safeguard

这是整个压缩系统中最大、最复杂的模块（1130+ 行）：

```
compactionSafeguardExtension（session_before_compact 事件处理器）
    │
    ├── 1. 检查是否有真实可摘要内容
    │   └── 无内容 → 写入边界条目（防止重触发循环）
    │
    ├── 2. 收集文件操作和工具失败信息
    │
    ├── 3. 尝试 Provider 路径（插件提供的摘要服务）
    │   ├── 成功 → 使用 Provider 摘要
    │   └── 失败 → 回退到 LLM 路径
    │
    ├── 4. LLM 路径
    │   ├── 解析模型认证
    │   ├── 修剪历史
    │   ├── 分块摘要
    │   ├── 保留最近轮次
    │   └── 质量守卫检查（可重试）
    │
    ├── 5. 组装后缀
    │   ├── 分割轮次
    │   ├── 保留轮次
    │   ├── 工具失败
    │   ├── 文件操作
    │   └── 工作空间上下文
    │
    └── 6. 截断保护
        └── 确保后缀（诊断信息）优先于主体保留
```

### 3.5 ACP — Agent Client Protocol

#### 3.5.1 三层架构

```
┌─────────────────────────────────────────────────────────┐
│  协议层（顶层）                                          │
│  ├─ server.ts — ACP 网关服务器（stdin/stdout → Gateway）│
│  ├─ translator.ts — ACP ↔ Gateway 协议翻译器（核心）     │
│  └─ client.ts — ACP 客户端（spawn 子进程 + REPL）       │
├─────────────────────────────────────────────────────────┤
│  控制平面层（control-plane/）                             │
│  ├─ manager.core.ts — 会话生命周期管理器（核心）          │
│  ├─ session-actor-queue.ts — 会话级串行化队列            │
│  ├─ runtime-cache.ts — Runtime handle 缓存 + 空闲驱逐    │
│  ├─ runtime-options.ts — 运行时选项验证/合并/签名        │
│  └─ manager.identity-reconcile.ts — 会话身份协调         │
├─────────────────────────────────────────────────────────┤
│  运行时层（runtime/）                                     │
│  ├─ types.ts — AcpRuntime 插件接口                       │
│  ├─ registry.ts — 后端注册表                             │
│  ├─ errors.ts — 错误类型体系（8 种标准错误码）           │
│  ├─ session-meta.ts — 会话元数据持久化                   │
│  └─ session-identity.ts — 三 ID 身份标识管理             │
└─────────────────────────────────────────────────────────┘
```

#### 3.5.2 AcpGatewayAgent — 核心翻译器

`AcpGatewayAgent` 实现了 ACP SDK 的 `Agent` 接口，是 ACP 协议与 Gateway 之间的核心适配层：

```
ACP 操作                    Gateway 操作
─────────                   ────────────
initialize()         →      hello 握手
newSession()         →      chat.new + 历史回放
loadSession()        →      chat.send（恢复）
prompt(message)      →      chat.send（增量事件流）
                     ←      chat 事件 → sessionUpdate 通知
cancel()             →      agent.cancel
```

**增量流处理**：使用 `sentTextLength`/`sentThoughtLength` 跟踪已发送偏移量，确保增量推送不重复不遗漏。

**断线韧性**：通过 `DisconnectContext` 世代计数器和 `reconcilePendingPrompts` 实现断线后的 pending 请求协调。

#### 3.5.3 SessionActorQueue — Actor 模型

```
SessionActorQueue
    │
    ├── actorKey = sessionKey
    │
    └── KeyedAsyncQueue
        └── 每个会话 key 维护一个串行队列
            └── 操作按序执行，避免竞态
```

这是经典的 Actor 模型实现——每个会话是一个 actor，所有操作通过队列串行化，从根本上消除了并发竞态。

#### 3.5.4 会话身份三 ID 体系

```
SessionIdentity
├── acpxRecordId     — ACPX 记录 ID
├── acpxSessionId    — ACPX 会话 ID
├── agentSessionId   — Agent 会话 ID
├── state: "pending" | "resolved"
└── source: "ensure" | "status" | "event"
```

**合并策略**：已 resolved 的身份不接受 pending 来源的覆盖，但接受其他 resolved 来源的更新。这确保了身份标识的最终一致性。

#### 3.5.5 工具审批分类器

```
classifyAcpToolApproval(toolCall)
    │
    ├── read → 路径在 cwd 内？→ readonly_scoped（自动批准）
    │                  └── 路径在 cwd 外？→ 需审批
    │
    ├── search / web_search / memory_search → readonly_search（自动批准）
    │
    ├── exec / bash / shell → exec_capable（需审批）
    │
    ├── sessions_spawn / sessions_send → control_plane（需审批）
    │
    └── isMutatingToolCall() → mutating（需审批）
```

**多源交叉验证**：工具名称从 `_meta`、`rawInput`、`title` 三个来源提取并验证一致性，防止伪造。

### 3.6 配置与运行时管理

#### 3.6.1 models.json 原子写入

```
ensureOpenClawModelsJson()
    │
    ├── 构建配置指纹（配置内容 + 环境变量 + 文件 mtime）
    │
    ├── 检查缓存是否匹配
    │
    ├── 获取写锁（Promise 链实现异步互斥）
    │
    ├── planOpenClawModelsJson() — 计算是否需要写入
    │
    └── 原子写入（先写临时文件再 rename）
        └── 文件权限 0o600（仅所有者可读写）
```

#### 3.6.2 快速模式优先级链

```
resolveFastModeState()
    │
    ├── 1. 会话级覆盖（SessionEntry.fastMode）— 最高优先级
    ├── 2. Agent 默认值（Agent 配置的 fastModeDefault）
    ├── 3. 模型配置值（agents.defaults.models[...].params.fastMode）
    └── 4. 默认值 false
```

返回的 `FastModeState` 包含 `source` 字段，便于调试和日志追踪。

---

## 四、双项目对比分析

### 4.1 编排模式对比

| 维度 | claude-code-sourcemap | openclaw |
|------|----------------------|----------|
| **编排角色** | Coordinator（LLM 自身充当协调者） | agent-command.ts（代码编排）+ Harness（策略选择） |
| **工人创建** | AgentTool.call() — LLM 自主决策 | API 调用 — 外部触发 |
| **任务分解** | LLM 自主分解（Prompt 驱动） | 配置驱动（Agent 定义 + 技能系统） |
| **结果聚合** | LLM 自主综合（Prompt 指导） | 事件流回调（增量推送） |
| **并发控制** | LLM 自主判断（Prompt 指导） | SessionActorQueue（强制串行化） |

**关键差异**：claude-code 将编排智慧交给 LLM（通过精心设计的系统提示词），openclaw 将编排逻辑编码在代码中。前者更灵活但不可预测，后者更可控但需要预定义。

### 4.2 生命周期管理对比

| 维度 | claude-code-sourcemap | openclaw |
|------|----------------------|----------|
| **任务注册** | `registerAsyncAgent()` — 内存状态 | `AcpSessionManager.initializeSession()` — 持久化 |
| **进度跟踪** | ProgressTracker（input/output tokens） | AcpRuntimeEvent 流（text_delta/tool_call/done） |
| **前后台切换** | `isBackgrounded` 标志 + Ctrl+B | 不适用（始终后台运行） |
| **完成通知** | `<task-notification>` XML → 注入为 user 消息 | 事件流回调 → sessionUpdate 通知 |
| **停止机制** | AbortController（单/双） | cancelSession() → AbortController + 运行时 cancel |
| **状态恢复** | resumeAgent() — 从磁盘 transcript 恢复 | reconcilePendingSessionIdentities() — 身份协调 |
| **空闲驱逐** | 无 | RuntimeCache.collectIdleCandidates() |

### 4.3 通信机制对比

| 维度 | claude-code-sourcemap | openclaw |
|------|----------------------|----------|
| **协议** | 邮箱文件 + XML 通知 | ACP 协议（NDJSON over stdin/stdout） |
| **消息格式** | `<task-notification>` XML | ACP SDK `sessionUpdate` 事件 |
| **路由方式** | 文件写入 + 轮询读取 | Gateway WebSocket + 事件流 |
| **跨进程** | UDS socket + Remote Control Bridge | ACP server/client（子进程 spawn） |
| **安全验证** | bridge 消息 `classifierApprovable: false` | 工具审批分类器（7 种分类） |

### 4.4 模型管理对比

| 维度 | claude-code-sourcemap | openclaw |
|------|----------------------|----------|
| **模型支持** | 仅 Anthropic Claude | 40+ 提供商 |
| **故障转移** | 无 | 责任链模式（按优先级尝试候选） |
| **运行时切换** | 无 | 延迟切换（等待安全时机） |
| **模型目录** | 硬编码 | 动态聚合（SDK + 配置 + 插件） |
| **别名系统** | 无 | 双向映射索引 |

### 4.5 上下文压缩对比

| 维度 | claude-code-sourcemap | openclaw |
|------|----------------------|----------|
| **触发方式** | autoCompact / reactiveCompact | 两级：Pruning（每次请求）+ Safeguard（溢出时） |
| **压缩算法** | LLM 驱动摘要 | 双路径：Provider（插件）> LLM（兜底） |
| **质量保证** | 无显式质量检查 | 质量守卫（可配置重试 + 标识符保留检查） |
| **分块策略** | 固定比例 | 自适应（根据平均消息大小动态调整） |
| **安全防护** | 无 | 工具调用对完整性保护 + 敏感数据剥离 |

---

## 五、通用设计模式提炼

### 5.1 可直接复用的模式

#### 模式 1：Actor 队列串行化（openclaw）

```
适用场景：需要确保同一实体的操作不会产生竞态
实现方式：KeyedAsyncQueue，每个 key 维护一个串行 Promise 链
优势：从根本上消除并发竞态，无需锁
```

#### 模式 2：策略路由 + 兜底（openclaw Harness）

```
适用场景：需要支持多种运行时后端，同时保证至少一种可用
实现方式：注册表 + supports() 优先级排序 + 内置兜底
优势：插件化扩展 + 零配置可用
```

#### 模式 3：Prompt Cache 优化的 Fork（claude-code）

```
适用场景：需要并行执行多个相似子任务
实现方式：共享消息前缀 + 占位符 tool_result + 独有指令后缀
优势：最大化 Prompt Cache 命用率，降低 API 成本
```

#### 模式 4：两级压缩（openclaw）

```
适用场景：需要在性能和信息保留之间取得平衡
实现方式：轻量级 Pruning（每次请求）+ 重量级 Compaction（溢出时）
优势：避免不必要的全量压缩，同时确保溢出时优雅降级
```

#### 模式 5：延迟切换（openclaw live-model-switch）

```
适用场景：需要在运行时动态变更配置，但不能中断进行中的操作
实现方式：设置标志 → 等待安全时机 → 检查标志 → 执行切换 → 清除标志
优势：不中断用户操作，同时确保配置最终生效
```

#### 模式 6：Coordinator-Worker 分工（claude-code）

```
适用场景：需要 LLM 自主编排多个子任务
实现方式：精心设计的系统提示词 + 工具约束 + 结果通知格式
优势：利用 LLM 的理解能力进行智能任务分解和结果综合
```

#### 模式 7：多源合并 + 优先级覆盖（两个项目共有）

```
适用场景：需要从多个来源加载配置/定义
实现方式：按优先级排序加载，后加载覆盖先加载
claude-code: built-in < plugin < user < project < policy
openclaw: 配置 > 发现 > 默认
```

#### 模式 8：可插拔完成检查器（claude-code RemoteAgentTask）

```
适用场景：不同类型的任务有不同的完成判定逻辑
实现方式：registerCompletionChecker(type, checker) 注册表
优势：与通用轮询解耦，新增类型只需注册检查器
```

### 5.2 需要适配的设计

| 设计 | 来源 | 适配建议 |
|------|------|---------|
| 邮箱文件通信 | claude-code | 适用于单机多进程场景，分布式需替换为消息队列 |
| Git Worktree 隔离 | claude-code | 适用于 git 仓库场景，非 git 项目需替代方案 |
| ACP 协议 | openclaw | 适用于 OpenClaw 生态，通用场景需定义自己的协议 |
| PI SDK 扩展点 | openclaw | 与 PI SDK 强耦合，通用场景需抽象自己的扩展点 |

---

## 六、为后续轮次准备的关键发现

### 6.1 第 3 轮（工具系统）应关注的问题

1. **claude-code 的工具权限系统如何与 Agent 编排交互？** `filterToolsForAgent()` 的多层过滤管道 + `checkPermissions()` 的分级决策
2. **openclaw 的审批分类器如何与 ACP 协议集成？** 7 种工具分类 → 自动批准/需审批
3. **LSP 集成如何降低编码 Agent 的错误率？**（claude-code 独有）

### 6.2 第 5 轮（进化/自优化）应关注的问题

1. **openclaw 的两级压缩（Pruning + Safeguard）是否优于 claude-code 的单级压缩？** 质量守卫机制的价值
2. **claude-code 的 DreamTask 与 openclaw 的 memory-host-sdk dreaming 有何异同？** 两者都是后台自动整理机制
3. **模型故障转移链的冷却感知设计是否可以应用于其他资源管理场景？**

### 6.3 第 6 轮（通信协议）应关注的问题

1. **ACP 协议的三层架构（协议层/控制平面层/运行时层）是否可以作为通用 Agent 通信协议的参考？**
2. **claude-code 的邮箱文件通信与 openclaw 的 ACP 协议，哪种更适合分布式场景？**
3. **会话身份三 ID 体系的设计是否解决了分布式系统中的身份一致性问题？**

---

## 七、高价值代码片段索引

| 片段 | 文件 | 参考价值 | → 代码片段文档 |
|------|------|---------|---------------|
| Coordinator 系统提示词（370 行） | `coordinatorMode.ts` `getCoordinatorSystemPrompt()` | Agent 编排 Prompt 设计范本 | → [代码片段_Agent核心循环与编排.md](代码片段_Agent核心循环与编排.md) #7 |
| AgentTool 策略路由 | `AgentTool/AgentTool.tsx` `call()` | 多路径子代理调度 | → [代码片段_Agent核心循环与编排.md](代码片段_Agent核心循环与编排.md) #8 |
| Fork 消息构建 | `AgentTool/forkSubagent.ts` `buildForkedMessages()` | Prompt Cache 优化 | → [代码片段_Agent核心循环与编排.md](代码片段_Agent核心循环与编排.md) #9 |
| 工具过滤管道 | `AgentTool/agentToolUtils.ts` `filterToolsForAgent()` | 多层安全过滤 | → [代码片段_Agent核心循环与编排.md](代码片段_Agent核心循环与编排.md) #10 |
| 异步代理生命周期 | `AgentTool/agentToolUtils.ts` `runAsyncAgentLifecycle()` | 模板方法模式 | → [代码片段_Agent核心循环与编排.md](代码片段_Agent核心循环与编排.md) #11 |
| Harness 选择策略 | `agents/harness/selection.ts` `selectAgentHarness()` | 策略路由 + 兜底 | → [代码片段_Agent核心循环与编排.md](代码片段_Agent核心循环与编排.md) #12 |
| 模型故障转移 | `agents/model-fallback.ts` `runWithModelFallback()` | 责任链模式 | → [代码片段_Agent核心循环与编排.md](代码片段_Agent核心循环与编排.md) #13 |
| 上下文修剪算法 | `agents/pi-hooks/context-pruning/pruner.ts` `pruneContextMessages()` | 两阶段修剪 | → [代码片段_上下文记忆与通信协议.md](代码片段_上下文记忆与通信协议.md)（合并到压缩相关片段） |
| 压缩安全守卫 | `agents/pi-hooks/compaction-safeguard.ts` | 双路径摘要 + 质量守卫 | → [代码片段_上下文记忆与通信协议.md](代码片段_上下文记忆与通信协议.md) #11 |
| ACP 协议翻译器 | `acp/translator.ts` `AcpGatewayAgent` | 协议适配器模式 | → [代码片段_上下文记忆与通信协议.md](代码片段_上下文记忆与通信协议.md) #42 |
| Actor 队列 | `acp/control-plane/session-actor-queue.ts` | 并发控制 | → [代码片段_上下文记忆与通信协议.md](代码片段_上下文记忆与通信协议.md) #44 |
| 会话身份管理 | `acp/runtime/session-identity.ts` | 三 ID 身份体系 | → [代码片段_上下文记忆与通信协议.md](代码片段_上下文记忆与通信协议.md) #45 |
