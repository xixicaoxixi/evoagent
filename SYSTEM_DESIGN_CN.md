# EvoAgent 系统设计

> 面向开发者的系统设计参考。基于 TypeScript + Bun 实际实现，非 Python 原型。

---

## 1. 系统概述

### 1.1 项目定位

EvoAgent 是一个**分布式自进化多智能体系统**。系统通过 Agentic Loop 执行任务，并基于任务执行结果自动进化——生成、验证、淘汰进化规则，持续优化自身行为。系统支持多实例 P2P 通信，实例间可共享进化规则、知识，并通过共识机制建立信任网络。

### 1.2 核心特性

| 特性 | 描述 |
|------|------|
| **自进化** | 基于错误驱动和成功经验自动生成进化规则，规则经历 sandbox → probation → active → deprecated 的完整生命周期 |
| **Agentic Loop** | async generator 驱动的工具调用循环，支持流式响应、工具发现、权限链、错误隔离 |
| **多层 System Prompt** | Core(不可变) + Evolutionary(可进化) + Tunable(临时) 三层锚点架构 |
| **元进化** | 宪法守卫、策略探索、跨实例二阶交流、引擎参数自优化 |
| **P2P 网络** | 实例间 HTTP 通信，Ed25519/Web Crypto 签名验证，Web of Trust 共识机制 |
| **社区治理** | 声誉系统、等级制度、治理提案投票、实例市场 |
| **异常检测** | 四维度检测（频率、恶意模式、拒绝率、信任突降），滑动窗口计数 |
| **知识管理** | 关键词 + 向量混合检索，主动遗忘，来源权重，上下文感知 |
| **多 LLM 支持** | OpenAI/Anthropic/Ollama/Mock 四种 Provider + DeepSeek/Kimi/GLM 自动检测，统一抽象接口 |

### 1.3 技术栈

| 层级 | 技术选型 |
|------|----------|
| 运行时 | Bun |
| 语言 | TypeScript (`strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`) |
| HTTP Server | Bun 原生 `Bun.serve()` |
| 数据持久化 | JSONL + 原子写入（无数据库依赖） |
| LLM 接口 | 原生 `fetch`（无第三方 SDK） |
| 加密签名 | Web Crypto API（Ed25519 + HMAC-SHA256 降级） |
| Schema 验证 | Zod |
| MCP 集成 | 自实现 Streamable HTTP / stdio 传输 |
| 运行时依赖 | 仅 `zod`（零第三方 SDK） |

---

## 2. 系统架构

### 2.1 五层架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户接口层                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │
│  │ Web UI   │  │ REST API │  │ MCP Server│                     │
│  └──────────┘  └──────────┘  └──────────┘                     │
├─────────────────────────────────────────────────────────────────┤
│                        编排层                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Orchestrator                          │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │  │
│  │  │ TaskPlanner  │  │ AgentFactory │  │ KnowledgeMgr  │  │  │
│  │  └─────────────┘  └──────────────┘  └───────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                        执行层                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                  agentQueryLoop                          │  │
│  │  Context → LLM Stream → Tool Execution → Loop Control   │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                        进化层                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                  EvolutionEngine                          │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │  │
│  │  │CodeSandbox│ │ ABJudge  │ │ToolGen   │ │MetaEvolution│ │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                        通信层                                   │
│  ┌────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ ┌────────┐  │
│  │Gateway │ │   P2P    │ │Identity  │ │Consensus│ │Anomaly │  │
│  └────────┘ └──────────┘ └──────────┘ └────────┘ └────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │Marketplace│ │Community │ │Analytics │ │    Critic        │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                        基础设施层                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │AtomicWrite│ │Provider  │ │  Store   │ │  LLM Providers  │  │
│  │  + JSONL  │ │  Config  │ │ (JSONL)  │ │  (fetch-based)  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 模块依赖关系

```
EvoAgentContext (integration/context.ts)
  ├── QueryEngine → agentQueryLoop, LLMAdapter, ToolRegistry
  ├── Orchestrator → TaskPlanner, SubAgent, AgentFactory
  ├── EvolutionEngine → RuleStore, RuleAnalyzer, RuleValidator
  │     ├── CodeSandbox
  │     ├── ABJudge → EvalWeightAdapter
  │     ├── ToolGenerator → CodeSandbox
  │     ├── ConstitutionalGuard
  │     ├── StrategyExplorer → ConstitutionalGuard
  │     ├── MetaCommunicator → ConstitutionalGuard
  │     └── EngineSelfOptimizer → StrategyExplorer, ConstitutionalGuard
  ├── KnowledgeManager → MemoryExtractor, VectorStore
  ├── CommunicationGateway → Critic, MessageProtocol
  │     └── Critic → Store, KnowledgeBase
  └── Observability → Logger, StatsStore(Reservoir), CostTracker, Progress
```

### 2.3 数据流

```
用户输入
  │
  ▼
EvoAgentContext.chat() / chatComplex()
  │
  ├── chat → QueryEngine → agentQueryLoop
  │              │
  │         Agentic Loop:
  │         1. 上下文组装 (System Prompt + 历史 + 知识注入)
  │         2. LLM 流式调用 (provider.stream())
  │         3. 工具调用检测 + 执行 (ToolExecutor)
  │         4. 循环控制 (最大步数 / 预算 / 完成)
  │         5. PII 净化 + LLM 输出净化
  │              │
  ├── chatComplex → Orchestrator
  │     │
  │     TaskPlanner.plan() ───→ ExecutionPlan
  │     │                        │
  │     ▼                        ▼
  │     AgentFactory.create() ──→ SubAgent (各自运行 agentQueryLoop)
  │     │                        │
  │     ▼                        ▼
  │     结果收集 ◄──────────── 执行结果
  │
  ▼
EvolutionEngine.onTaskCompleted()
  ├── 更新任务统计
  ├── 记录 E0 基线
  ├── 递增触发预算
  ├── 周期性生命周期管理
  ├── 知识探索 / 主动遗忘
  ├── 工具生成 / A/B测试
  ├── 策略探索 / 引擎自优化
  └── 通信解锁检查
```

---

## 3. 核心模块设计

### 3.1 EvoAgentContext（统一上下文容器）

**职责**: 整合所有模块的统一入口，由 `createEvoAgent()` 和 CLI/MCP 入口共同使用。

**位置**: `src/integration/context.ts`

**初始化时创建**:
- `ProviderConfigStore` — Provider 配置存储（含自动检测）
- `QueryEngine` — 单 Agent 对话引擎
- `Orchestrator` — 多 Agent 编排器
- `EvolutionEngine` — 进化引擎
- `KnowledgeManager` — 知识管理器
- `CommunicationGateway` — 通信网关
- `Observability` 层 — Logger / StatsStore / CostTracker / Progress

**核心方法**:
```typescript
chat(message: string): Promise<{ response: string }>
chatComplex(message: string, subTasks?: string[]): Promise<{ response: string }>
```

### 3.2 agentQueryLoop（Agentic Loop 核心）

**职责**: async generator 驱动的工具调用循环，是所有 Agent 执行的基础。

**位置**: `src/core/query/loop.ts`

**循环流程**:
1. 上下文组装（System Prompt + 对话历史 + 知识注入）
2. LLM 流式调用（`provider.stream()`）
3. 工具调用检测（从 LLM 输出中提取 tool_calls）
4. 工具执行（ToolExecutor + 权限链 + 拒绝计数）
5. 结果注入对话历史
6. 循环控制（最大步数 / Token 预算 / 完成信号检测）

**关键特性**:
- **错误隔离**: 工具错误作为数据返回，不终止循环
- **PII 净化**: 输出经过 PII 检测和脱敏
- **LLM 净化**: 检测 LLM 输出中的未执行工具调用文本
- **流式支持**: 使用 `async function*` + `yield` 实现流式响应

### 3.3 Orchestrator（主编排器）

**职责**: 多 Agent 编排，管理子 Agent 生命周期，驱动进化引擎。

**位置**: `src/core/agent/orchestrator.ts`

**核心流程**:
1. 任务规划: `TaskPlanner.plan()` 生成 `ExecutionPlan`
2. 拓扑排序式依赖解析
3. 并行执行就绪任务（依赖已满足的子任务）
4. 输入引用解析: `$task_001.output` 格式
5. 每个任务独立 try/catch，单任务失败不影响其他
6. 进化检查: `EvolutionEngine.onTaskCompleted()`

**聚合策略**: `AggregationStrategy` 枚举控制结果合并方式。

### 3.4 TaskPlanner + AgentFactory

**位置**: `src/core/agent/task-planner.ts`, `src/core/agent/sub-agent.ts`

**TaskPlanner**:
- 有 LLM → LLM 规划（生成 2~10 个子任务，含依赖关系）
- 无 LLM → 简单降级（固定 2 任务模板）
- 规划阶段参考进化规则

**SubAgent**:
- 每个 SubAgent 运行独立的 `agentQueryLoop`
- 支持工具自动选择（按任务类型分配）
- 并发控制: 全局限制 + 同类任务限制

### 3.5 EvolutionEngine（进化引擎）

**位置**: `src/evolution/engine.ts`

**规则数据模型** (`EvolutionRule`):

| 字段 | 类型 | 说明 |
|------|------|------|
| `ruleId` | `string` | 规则 ID |
| `createdAt` | `string` | 创建时间 |
| `sourceErrorId` | `string` | 来源错误 ID |
| `triggerPattern` | `string` | 触发条件 |
| `action` | `string` | 执行动作（16 种之一） |
| `priority` | `number` | 优先级 (0-1) |
| `status` | `RuleStatus` | 生命周期状态 |
| `activationCount` | `number` | 激活次数 |
| `successCount` | `number` | 成功次数 |
| `successRate` | `number` | 成功率 |
| `sandboxTrials` | `number` | 沙盒试运行次数 |
| `variance` | `number` | 规则方差 |
| `scopeTag` | `string` | 作用域标签 |

**16 种合法 Action**:

| Action | 描述 |
|--------|------|
| `RETRY_WITH_HIGHER_TIMEOUT` | 使用更高超时重试 |
| `ADD_VALIDATION_STEP` | 添加验证步骤 |
| `REDUCE_SCOPE` | 缩小任务范围 |
| `SPLIT_SUBTASK` | 拆分子任务 |
| `ADD_KNOWLEDGE_RETRIEVAL` | 添加知识检索 |
| `ADD_ERROR_HANDLING` | 添加错误处理 |
| `IMPROVE_PROMPT_CLARITY` | 改进提示词清晰度 |
| `ADD_FALLBACK_STRATEGY` | 添加回退策略 |
| `SAMPLE_BEFORE_PROCESS` | 处理前采样 |
| `INCREASE_TOKEN_BUDGET` | 增加 Token 预算 |
| `DECREASE_TOKEN_BUDGET` | 减少 Token 预算 |
| `CHANGE_TOOL_SELECTION` | 更换工具选择 |
| `ADD_RETRY_LOGIC` | 添加重试逻辑 |
| `SKIP_OPTIONAL_STEP` | 跳过可选步骤 |
| `REORDER_EXECUTION` | 调整执行顺序 |
| `ADVISORY_ONLY` | 仅建议不执行 |

**进化主流程** (`analyzeAndEvolve`):
1. 检查触发预算
2. 有 LLM → LLM 分析；无 LLM → 规则匹配
3. 冲突检测
4. 沙盒容量检查
5. 根据配置选择路径: 审批队列 / 沙盒试运行 / 直接激活

**生命周期管理** (`onTaskCompleted`):
1. 更新任务统计
2. 记录 E0 基线
3. 递增触发预算
4. 周期性运行 `lifecycleManagement()`
5. 知识探索 / 主动遗忘
6. 工具生成 / A/B 测试
7. 策略探索 / 引擎自优化

### 3.6 MetaEvolution（元进化）

**位置**: `src/evolution/`

#### ConstitutionalGuard — 宪法守卫

确保任何修改都不触及宪法层参数。

**宪法层参数**（不可修改）:
- `AB_TEST_JUDGE_WEIGHTS`, `SYSTEM_PROMPT_CORE`, `EVOLUTION_RULE_MAX_COUNT`
- `KNOWLEDGE_MIN_ENTRIES`, `EVOLUTION_MIN_ACTIVE_RULES`, `CODE_SANDBOX_TIMEOUT`
- `PROTOCOL_HMAC_KEY`

**可进化参数**（8 个二阶参数）:
- `TASK_TYPE_IMPORTANCE`, `PROMOTION_IMPROVEMENT_MIN`, `DEPRECATION_RATE_MIN`
- `EVOLUTION_SANDBOX_MIN_SUCCESS_RATE`, `EVOLUTION_SANDBOX_MIN_TRIALS`
- `KNOWLEDGE_FORGET_MAX_UNUSED_DAYS`, `KNOWLEDGE_COHESION_THRESHOLD`
- `KNOWLEDGE_EXPLORATION_INTERVAL`

#### StrategyExplorer — 策略探索器

随机扰动二阶参数进行探索。扰动幅度 0.15，触发条件: 启用 + 最小任务数(30) + 间隔(100) + 并发限制(1)。

#### MetaCommunicator — 二阶交流器

跨实例分享参数修改提案。接收安全流程: 信任度检查 → 来源年龄检查 → 宪法验证 → 提案数量限制 → 接受。

#### EngineSelfOptimizer — 引擎自优化器

分析任务统计并自动调整引擎参数。三种分析策略:
1. 成功率 < 50% → 放宽晋升门槛
2. 淘汰率 > 30% → 收紧淘汰率下限
3. B 胜率 < 20% → 降低沙盒通过门槛

性能退化检测: 下降超过 10% 触发回退。

### 3.7 CodeSandbox + ABJudge + ToolGenerator

**位置**: `src/evolution/`

#### CodeSandbox

安全测试代码修改的隔离环境。
- 静态检查: 体积 ≤ 100KB、语法检查、危险操作检查（AST 级别遍历）
- 禁止的调用: `eval`, `Function`, `child_process.exec` 等
- 隔离执行: 子进程 + 超时 30s

#### ABJudge

独立裁判，评估标准固定（宪法层）。

**评估维度与权重**:
- `success_rate`: 0.40
- `execution_time`: 0.25
- `stability`: 0.20
- `code_complexity`: 0.15

**判决逻辑**: B 胜需改善率 ≥ 10% 且成本增长 ≤ 15%。

#### ToolGenerator

自动工具生成器。触发条件: 启用 + 最小任务数(15) + 间隔(30) + 未达最大工具数(20)。

---

## 4. 通信与安全

### 4.1 P2P 通信层

**位置**: `src/communication/`

**6 种消息类型**: `knowledge_offer` / `rule_sync` / `challenge` / `meta_proposal` / `heartbeat` / `endorsement`

**P2P 路由**（8 个）:

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/api/v1/peer/register` | 注册对等节点 |
| POST | `/api/v1/peer/message` | 接收消息 |
| POST | `/api/v1/peer/sync-rules` | 同步进化规则 |
| POST | `/api/v1/peer/endorsement` | 接收共识背书 |
| POST | `/api/v1/peer/anomaly-report` | 接收异常报告 |
| GET | `/api/v1/peer/ping` | 心跳检测 |
| GET | `/api/v1/peer/info` | 获取实例公开信息 |
| GET | `/api/v1/peer/list` | 获取已知对等节点列表 |

### 4.2 Identity + Consensus

**位置**: `src/communication/identity.ts`, `src/communication/consensus.ts`

**Identity**: 使用 Web Crypto API 生成 Ed25519 密钥对。降级策略: Ed25519 不可用时降级为 HMAC-SHA256。

**ConsensusEngine**: Web of Trust 共识机制。
- 背书记录上限 1000 条
- 同实例同对象只能背书一次
- 信任评分算法: `(positive - negative) / total × avg_confidence`

### 4.3 AnomalyDetector + Critic

**位置**: `src/communication/anomaly-detector.ts`, `src/communication/critic.ts`

**AnomalyDetector 四个检测维度**:

| 维度 | 检测内容 | 阈值 |
|------|----------|------|
| 频率异常 | 每小时消息数 | > 50 → high |
| 恶意模式 | 15 条中英文恶意模式 | 匹配 → critical |
| 拒绝率异常 | 被拒绝比例 | > 0.7 → high |
| 信任突降 | 信任评分变化 | 单次下降 > 0.2 → 记录 |

**Critic 处理结果类型**: `ACCEPT` / `ACCEPT_PARTIAL` / `REJECT` / `ARCHIVE_AS_FLAWED` / `CHALLENGE`

### 4.4 抗污染机制

**四层安全防御体系**:

| 层级 | 保护对象 | 机制 |
|------|----------|------|
| 第一层：宪法层 | 核心代码、通信协议、安全约束 | 物理隔离，任何进化不可触及 |
| 第二层：批判性吸收 | 外部接收的知识/规则 | 沙箱测试 + probation 期监控 |
| 第三层：信任网络 | 交流对象的可信度 | 信任评分 + 来源验证 + 滑动窗口 |
| 第四层：社区共识 | 全网范围的恶意行为 | 共识签名 + 异常检测 + 紧急回滚 |

### 4.5 Marketplace + Community

**位置**: `src/communication/marketplace.ts`, `src/communication/community.ts`

**Marketplace**: 实例市场，支持发布/搜索/评分/订阅，综合热度评分 = `avg_rating × log(downloads + 1) × time_decay`。

**Community**: 社区共识网络，综合声誉公式:
```
reputation = consensus_score × 0.4 + market_contribution × 0.3
           + activity_score × 0.2 + longevity_bonus
```

**等级制度**: newcomer(0) → member(20) → trusted(50) → elder(80)，投票权重 1→2→3→5。

---

## 5. 基础设施层

### 5.1 持久化

**位置**: `src/persistence/`

| 组件 | 说明 |
|------|------|
| `atomic-write.ts` | 临时文件 + rename 原子写入 |
| `jsonl-store.ts` | JSONL 格式追加写入 |
| `snapshot.ts` | 快照管理（最多 10 个，30 天自动过期） |

**数据目录映射**:

| 数据类型 | 目录 |
|----------|------|
| 进化规则 | `data/evolution/rules.jsonl` |
| 知识记忆 | `data/knowledge/memories.jsonl` |

### 5.2 Provider 配置

**位置**: `src/core/provider-config.ts`, `src/core/provider-bootstrap.ts`

**统一优先级链**:
1. `runtime_override` — 显式 API 参数
2. `persisted_config` — 通过 HTTP API 保存
3. `env_auto_detected` — 环境变量自动检测

**自动检测映射**:

| 环境变量 | Provider | 默认 Base URL |
|----------|----------|---------------|
| `OPENAI_API_KEY` | openai | `https://api.openai.com/v1` |
| `ANTHROPIC_API_KEY` | anthropic | `https://api.anthropic.com` |
| `OLLAMA_BASE_URL` | ollama | `http://localhost:11434` |
| `DEEPSEEK_API_KEY` | openai | `https://api.deepseek.com` |
| `KIMI_API_KEY` | openai | `https://api.moonshot.cn/v1` |
| `GLM_API_KEY` | openai | `https://open.bigmodel.cn/api/paas/v4` |

**配置快照** (`ProviderConfigSnapshot`):
- `provider`, `model`, `baseUrl`
- `isAutoDetected`, `source` (优先级来源)
- `conflicts` (冲突记录)

### 5.3 LLM Providers

**位置**: `src/llm/`

**LLMProvider 接口**:
```typescript
interface LLMProvider {
  invoke(messages: Message[], options?: InvokeOptions): Promise<string>
  stream(messages: Message[], options?: StreamOptions): AsyncGenerator<string>
  countTokens(text: string): number
  healthCheck(): Promise<boolean>
}
```

**四种 Provider 实现**:

| Provider | Token 计数 | 特殊能力 |
|----------|-----------|---------|
| `OpenAIProvider` | CJK 感知估算 | 兼容所有 OpenAI API 格式（DeepSeek/Qwen/Kimi/GLM） |
| `AnthropicProvider` | CJK 感知估算 | 支持 thinking/reasoning |
| `OllamaProvider` | CJK 感知估算 | healthCheck 检查模型列表 |
| `MockProvider` | CJK 感知估算 | 模式匹配响应，用于测试 |

**LLMAdapter**: 统一适配层，含错误分类和 Fallback。

**降级策略**:

| 组件 | 降级条件 | 降级方案 |
|------|----------|----------|
| LLM 分析 | fetch 失败 | 规则匹配 / 简单分析 |
| Ed25519 签名 | Web Crypto 不可用 | HMAC-SHA256 |
| 任务规划 | LLM 不可用 | 固定 2 任务模板 |
| 流式输出 | stream 失败 | 降级为同步 invoke |

### 5.4 工具系统

**位置**: `src/tools/`

**Tool<I,O,P> 泛型接口**: 输入/输出/参数均有 Zod Schema 验证。

**内置工具**:

| 工具 | 位置 | 特性 |
|------|------|------|
| `bash` | `src/tools/bash/` | AST 解析、权限控制、语义检查、sed 验证、环境净化 |
| `file_read` | `src/tools/file/` | 文件读取 |
| `file_write` | `src/tools/file/` | 原子写入 |
| `file_edit` | `src/tools/file/` | 搜索替换 |
| `glob` | `src/tools/file/` | 文件模式匹配 |

**安全工具** (`src/tools/security/`):
- `loop-detector.ts` — 重复工具调用模式检测
- `regex-safety.ts` — 正则安全检查
- `secret-detector.ts` — 密钥检测

**ToolRegistry + ToolExecutor + PermissionChain + RejectionCounter**

### 5.5 安全层

**位置**: `src/security/`

| 组件 | 说明 |
|------|------|
| `danger-flags.ts` | 危险标志检测 |
| `external-content.ts` | 外部内容安全处理 |
| `hardwire.ts` | 硬线安全约束 |
| `llm-sanitize.ts` | LLM 输出净化 |
| `redact.ts` | 数据脱敏 |
| `secret-ref.ts` | 密钥引用（替代明文存储） |
| `secret-store.ts` | 密钥安全存储 |
| `truncate.ts` | 两层截断（单条上限 + 总量上限） |

### 5.6 上下文引擎

**位置**: `src/context/`

| 组件 | 说明 |
|------|------|
| `engine.ts` | 上下文引擎主入口 |
| `compress.ts` | 上下文压缩 |
| `summarizer.ts` | 摘要生成 |
| `token-count.ts` | Token 计数 |
| `system-prompt.ts` | 三层 System Prompt 构建 + 缓存 |

### 5.7 可观测性

**位置**: `src/observability/`

| 组件 | 说明 |
|------|------|
| `logger.ts` | 结构化日志 |
| `reservoir.ts` | 水库采样（固定内存流式统计） |
| `cost-tracker.ts` | 成本追踪 |
| `progress.ts` | 进度追踪 |
| `pii-sanitize.ts` | PII 净化 |
| `chat-diagnostics.ts` | 对话诊断 |

---

## 6. 接口层

### 6.1 HTTP Server

**位置**: `src/server/`

**10 组路由**:

| 路由组 | 路径前缀 | 说明 |
|--------|----------|------|
| 任务 | `/api/v1/task` | 提交任务、查询状态 |
| 进化 | `/api/v1/evolution` | 规则列表、仪表盘 |
| 知识 | `/api/v1/knowledge` | 知识库查询、记忆管理 |
| 配置 | `/api/v1/config` | Provider 配置读写 |
| 通信 | `/api/v1/communication` | 通信历史 |
| P2P 网络 | `/api/v1/net` | 对等节点、同步、共识 |
| 市场 | `/api/v1/market` | 发布/搜索/评分/订阅 |
| 社区 | `/api/v1/community` | 声誉、提案、投票 |
| 分析 | `/api/v1/analytics` | 趋势、报告、快照 |
| P2P 内部 | `/api/v1/peer` | 注册/消息/心跳 |

**其他**: Auth 中间件、Rate Limit、Web UI。

### 6.2 MCP Server

**位置**: `src/mcp/`

**传输层**: stdio / Streamable HTTP 双模式。

**10 个 MCP Tools**:

| 工具 | 需要 Provider | 功能 |
|------|----------------|------|
| `bash` | 否 | 执行 Shell 命令 |
| `file_read` | 否 | 读取文件 |
| `file_write` | 否 | 写入文件 |
| `file_edit` | 否 | 编辑文件 |
| `glob` | 否 | 文件模式匹配 |
| `chat` | 是 | 与 LLM 对话 |
| `chat_complex` | 是 | 多 Agent 编排 |
| `evolution_status` | 是 | 进化状态 |
| `observability_status` | 是 | 统计/成本/进度 |
| `community_status` | 是 | 社区治理/市场 |

**2 个 MCP Resources**: `config`, `status`。

---

## 7. 数据模型

### 7.1 枚举

| 枚举 | 值 |
|------|-----|
| `TaskStatus` | `PENDING` \| `RUNNING` \| `SUCCESS` \| `FAILED` \| `PARTIAL` |
| `AgentStatus` | `CREATED` \| `INITIALIZING` \| `RUNNING` \| `COMPLETED` \| `FAILED` \| `DESTROYED` |
| `RuleStatus` | `PENDING_APPROVAL` \| `SANDBOX` \| `ACTIVE` \| `PROBATION` \| `DEPRECATED` \| `ROLLED_BACK` |
| `ProcessingResult` | `ACCEPT` \| `ACCEPT_PARTIAL` \| `REJECT` \| `ARCHIVE_AS_FLAWED` \| `CHALLENGE` |

### 7.2 Zod Schema

**位置**: `src/schemas/`

- `agent.ts` — Agent 相关 Schema
- `config.ts` — 配置 Schema
- `evolution.ts` — 进化规则 Schema
- `message.ts` — 消息 Schema
- `tool.ts` — 工具 Schema

### 7.3 Branded Types

**位置**: `src/types/ids.ts`

不同语义 ID 使用 Branded Types 防止混用:
- `RuleId`, `TaskId`, `AgentId`, `MessageId`, `KnowledgeId` 等

---

## 8. 进化规则生命周期

### 8.1 状态机

```
  错误发生
     │
     ▼
  分析错误 ──→ 生成候选规则
     │              │
     │         冲突检测
     │              │
     │         ┌────┴────┐
     │         │ 冲突?   │
     │         │ 是→拒绝  │
     │         │ 否→继续  │
     │         └────┬────┘
     │              │
     ▼              ▼
  ┌──────────────────────────────┐
  │     PENDING_APPROVAL         │  ← 等待审批（如启用）
  └──────────────┬───────────────┘
                 │
                 ▼
  ┌──────────────────────────────┐
  │        SANDBOX               │  ← 沙盒试运行（≥3次，成功率≥60%）
  └──────────────┬───────────────┘
                 │ 通过
                 ▼
  ┌──────────────────────────────┐
  │        PROBATION             │  ← 试运行期（≥10次任务验证）
  │   量化晋升门槛:               │
  │   改善幅度 ≥ 15%             │
  │   额外成本 ≤ 10%             │
  └──────────────┬───────────────┘
                 │ 通过
                 ▼
  ┌──────────────────────────────┐
  │        ACTIVE                │  ← 活跃规则（注入 Agent）
  │   淘汰条件:                   │
  │   成功率 < 30% (≥5次触发)    │
  │   EMA趋势下降                 │
  │   方差过高                    │
  └──────────────┬───────────────┘
                 │ 淘汰
                 ▼
  ┌──────────────────────────────┐
  │       DEPRECATED             │  ← 已淘汰
  └──────────────────────────────┘
```

### 8.2 关键阈值

| 阈值 | 默认值 | 说明 |
|------|--------|------|
| 沙盒最少试运行 | 3 | 沙盒阶段最少执行次数 |
| 沙盒最低成功率 | 0.6 | 沙盒通过门槛 |
| 试运行最少任务 | 10 | Probation 阶段最少验证任务数 |
| 晋升改善幅度 | 0.15 | 晋升 ACTIVE 的最小改善 |
| 晋升成本上限 | 0.10 | 晋升允许的最大额外成本 |
| 淘汰成功率 | 0.3 | 低于此值触发淘汰 |
| 淘汰最少触发 | 5 | 淘汰最少触发次数 |
| 最大规则数 | 50 | 宪法层上限 |
| EMA alpha | 0.3 | 趋势平滑系数 |
| 触发预算比例 | 0.2 | 最大触发预算比例 |

---

## 9. P0-P4 优先级改良体系

| 优先级 | 代号 | 核心关注点 | 关键机制 |
|--------|------|-----------|----------|
| **P0** | 安全底线 | 防止进化导致系统退化 | 保底策略、触发预算、审批门控、沙盒试运行、快照回退 |
| **P1** | 效率提升 | 减少无效进化开销 | 分段验证、分级错误处理、不确定性信号、多层Prompt |
| **P2** | 评估精度 | 更准确的进化效果评估 | 任务类型权重、E0基线、量化晋升/淘汰门槛、动态资源分配 |
| **P3** | 可复现性 | 确保实验可重复 | 随机种子控制、Token分布记录、HMAC签名 |
| **P4** | 高级进化 | 代码级和策略级进化 | 知识探索、主动遗忘、代码沙箱、工具自动生成、A/B测试、策略探索、引擎自优化 |

---

## 10. 设计模式应用

| 模式 | 应用位置 |
|------|----------|
| 接口+注册表 | LLMProvider、Tool、Store、SandboxBackend、PluginEntry |
| 策略模式 | LLMAdapter 注册表、Orchestrator AggregationStrategy |
| 原子写入 | `atomic-write.ts` (tmp + rename) |
| 串行化消竞态 | `async-lock.ts`、`session-actor-queue.ts` |
| 水库采样 | `reservoir.ts` (固定内存流式统计) |
| 环形缓冲去重 | LRU 缓存 + dedup |
| 滑动窗口限流 | `rate-limiter.ts` |
| 观察者+错误隔离 | 工具错误作为数据，不终止循环 |
| 两层截断 | `truncate.ts` (单条上限 + 总量上限) |
| 半衰期衰减 | 市场热度评分 (7天半衰期) |
| 代际计数器 | 异步操作过期检测 |
| CoW | 快照深拷贝，失败回滚 |

---

## 11. 模块接入状态

基于 `src/module-ledger.ts` 的权威记录:

| 模块 | 状态 | 说明 |
|------|------|------|
| core/query | mainline_integrated | Agentic Loop 主闭环 |
| core/agent | mainline_integrated | Orchestrator + SubAgent |
| evolution | mainline_integrated | 完整规则生命周期 + 元进化 |
| communication | mainline_integrated | P2P + 共识 + 声誉 + 市场 |
| observability | mainline_integrated | 日志/统计/成本/进度/PII |
| mcp | mainline_integrated | stdio + HTTP 双传输 |
| server | mainline_integrated | HTTP Server + Web UI + 路由 |
| llm | mainline_integrated | 四种 Provider + Fallback |
| tools | mainline_integrated | Bash/File/Security 工具 |
| security | mainline_integrated | 密钥检测/净化/截断 |
| persistence | mainline_integrated | 原子写入/JSONL/快照 |
| knowledge | partially_integrated | 记忆抽取已接入；向量存储/梦境/遗忘未接入 |
| plugins | test_only | 插件/Hook/Skill 体系已测试但未装配主链 |
| sandbox | extension_only | SubprocessSandbox 已实现但工具执行链未使用 |
