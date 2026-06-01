# 分析_H5_记忆系统与Curator自进化机制

> **轮次**：第 H 轮 — Hermes-Agent 拆解
> **日期**：2026-05-08
> **阅读量**：~3,500+ 行（memory_provider.py 279 + memory_manager.py 555 + curator.py 1,674 + memory_tool.py 585 + 3 个插件 + 插件发现机制）
> **对标文档**：分析_05（进化引擎与评估体系）、分析_08（技能系统）

---

## 一、核心发现摘要

### 1.1 与 claude-code / openclaw 的对比

| 维度 | claude-code | openclaw | hermes-agent |
|------|-------------|----------|--------------|
| **记忆接口** | 无抽象（内置） | MemoryProvider ABC | **MemoryProvider ABC（更丰富）** |
| **外部提供者** | 无 | 无 | **8 个插件（Honcho/Holographic/Mem0 等）** |
| **提供者限制** | N/A | N/A | **单外部提供者限制** |
| **上下文隔离** | 无 | 无 | **StreamingContextScrubber 状态机** |
| **agent_context** | 无 | 无 | **primary/subagent/cron/flush 四种** |
| **会话切换钩子** | 无 | 无 | **on_session_switch（含 reset 语义）** |
| **压缩前钩子** | 无 | 无 | **on_pre_compress（提取压缩前洞察）** |
| **委托观察** | 无 | 无 | **on_delegation（父 Agent 观察子 Agent）** |
| **内置记忆写入镜像** | 无 | 无 | **on_memory_write（外部提供者镜像）** |
| **配置发现** | 无 | 无 | **get_config_schema + save_config** |
| **技能策展** | 无 | 无 | **Curator（Fork Agent + 自动状态转换）** |
| **技能生命周期** | 无 | 无 | **active → stale → archived 三态** |
| **伞形化合并** | 无 | 无 | **前缀聚类 + 3 种合并策略** |
| **Cron 引用迁移** | 无 | 无 | **自动重写定时任务中的技能引用** |

### 1.2 核心设计特点

1. **MemoryProvider ABC 是最完善的记忆接口**：14 个核心方法 + 7 个可选钩子，覆盖完整生命周期
2. **单外部提供者限制**：防止工具 schema 膨胀和冲突后端
3. **StreamingContextScrubber**：流式状态机，跨 chunk 边界清理 `<memory-context>` 标签
4. **Curator 是自进化的核心**：空闲触发 + Fork Agent + 自动状态转换 + 伞形化合并
5. **三信号分类 reconciliation**：模型声明 > YAML 结构化块 > 工具调用启发式

---

## 二、模块架构分析

### 2.1 MemoryProvider ABC 接口

```
MemoryProvider (ABC)
├── 身份
│   └── name: str (abstract property)
│
├── 核心生命周期（abstract）
│   ├── is_available() → bool              # 配置/凭据检查
│   ├── initialize(session_id, **kwargs)    # 连接、创建资源
│   └── get_tool_schemas() → List[Dict]     # 工具 schema
│
├── 上下文注入
│   ├── system_prompt_block() → str         # 静态系统提示词块
│   ├── prefetch(query, session_id) → str   # 每轮召回（应快速）
│   └── queue_prefetch(query, session_id)   # 后台预取下一轮
│
├── 数据持久化
│   ├── sync_turn(user, assistant)          # 每轮写入（应非阻塞）
│   └── handle_tool_call(name, args) → str  # 工具调用处理
│
├── 可选钩子（override to opt in）
│   ├── on_turn_start(turn, message)        # 每轮开始
│   ├── on_session_end(messages)            # 会话结束
│   ├── on_session_switch(new_id, parent, reset)  # 会话切换
│   ├── on_pre_compress(messages) → str     # 压缩前提取
│   ├── on_delegation(task, result)         # 子 Agent 完成观察
│   └── on_memory_write(action, target, content, metadata)  # 内置写入镜像
│
├── 配置发现
│   ├── get_config_schema() → List[Dict]    # 配置字段声明
│   └── save_config(values, hermes_home)    # 写入非密钥配置
│
└── 清理
    └── shutdown()                          # 刷新队列、关闭连接
```

**设计亮点**：
- `agent_context` 参数区分 primary/subagent/cron/flush，cron 上下文跳过写入
- `on_session_switch` 的 `reset` 语义区分 `/reset`（新对话）和 `/resume`（继续）
- `on_pre_compress` 返回文本被嵌入压缩摘要，确保压缩不丢失提供者提取的洞察
- `on_delegation` 让父 Agent 观察子 Agent 的工作成果

### 2.2 MemoryManager 编排器

```
MemoryManager
├── 注册
│   ├── add_provider(provider)              # 单外部提供者限制
│   ├── _tool_to_provider: Dict             # 工具名→提供者路由
│   └── _has_external: bool                 # 外部提供者标志
│
├── 系统提示词
│   └── build_system_prompt() → str         # 收集所有提供者的静态块
│
├── 上下文注入
│   ├── prefetch_all(query) → str           # 收集所有预取结果
│   ├── queue_prefetch_all(query)           # 触发所有后台预取
│   └── build_memory_context_block(raw) → str  # 包装为 <memory-context> 块
│
├── 数据持久化
│   ├── sync_all(user, assistant)           # 同步到所有提供者
│   └── on_memory_write(action, target, content, metadata)  # 镜像到外部
│
├── 工具路由
│   ├── get_all_tool_schemas() → List       # 收集所有工具
│   ├── handle_tool_call(name, args) → str  # 路由到正确提供者
│   └── has_tool(name) → bool
│
├── 生命周期钩子
│   ├── on_turn_start / on_session_end
│   ├── on_session_switch / on_pre_compress
│   ├── on_delegation
│   └── shutdown_all / initialize_all
│
└── 上下文清洗
    ├── sanitize_context(text) → str       # 一次性正则清理
    └── StreamingContextScrubber             # 流式状态机清理
```

### 2.3 StreamingContextScrubber 流式状态机

```
状态: in_span = false, buf = ""

feed("<memory-context>\nHello")
  ├── 找到 open tag → 进入 in_span
  ├── 输出: "" (丢弃标签前内容为空)
  └── buf = ""

feed("World\n</memory-con")
  ├── in_span=true, 找不到 close tag
  ├── 保留可能的部分 close tag: "con" (7字符后缀)
  ├── buf = "con"
  └── 输出: ""

feed("text>\nVisible text")
  ├── buf + text = "context>\nVisible text"
  ├── 找到 close tag → 退出 in_span
  ├── 输出: "\nVisible text"
  └── buf = ""

flush()
  ├── in_span=false → 输出 buf ("")
  └── 返回 ""
```

**设计亮点**：
- `_max_partial_suffix()` 计算最长标签前缀后缀，避免在标签中间截断
- `flush()` 在 in_span 时丢弃剩余内容（泄漏部分记忆上下文比截断回答更糟）
- 解决了流式响应中 `<memory-context>` 标签跨 chunk 分割的问题

### 2.4 Curator 策展流程

```
maybe_run_curator(idle_for_seconds)
    │
    ├── 门控检查
    │   ├── curator.enabled == True
    │   ├── not paused
    │   ├── last_run_at > interval_hours (默认 7 天)
    │   └── idle_for_seconds > min_idle_hours (默认 2 小时)
    │
    ├── Phase 1: 自动状态转换（纯计算，无 LLM）
    │   ├── apply_automatic_transitions()
    │   │   ├── stale_cutoff = now - 30 天
    │   │   ├── archive_cutoff = now - 90 天
    │   │   ├── active → stale (无活动 30 天)
    │   │   ├── stale → archived (无活动 90 天)
    │   │   └── stale → active (重新活动)
    │   └── 跳过 pinned 技能
    │
    ├── Phase 2: LLM 审查（Fork Agent）
    │   ├── _run_llm_review(prompt)
    │   │   ├── 创建独立 AIAgent（max_iterations=9999）
    │   │   ├── CURATOR_REVIEW_PROMPT（伞形化合并指令）
    │   │   ├── stdout/stderr 重定向到 /dev/null
    │   │   └── 收集工具调用记录
    │   └── 后台线程运行（daemon=True）
    │
    ├── Phase 3: 结果分类（三信号 reconciliation）
    │   ├── 信号 1: absorbed_into 声明（权威）
    │   ├── 信号 2: YAML 结构化块（模型意图）
    │   └── 信号 3: 工具调用启发式（审计）
    │   └── _reconcile_classification() 合并
    │
    ├── Phase 4: Cron 引用迁移
    │   └── rewrite_skill_refs(consolidated_map, pruned_names)
    │
    └── Phase 5: 报告生成
        ├── run.json（机器可读）
        ├── REPORT.md（人类可读）
        └── cron_rewrites.json（仅当有重写时）
```

### 2.5 技能生命周期状态转换

```
                    ┌──────────────────────────────┐
                    │                              │
            活动    │    pinned=yes 跳过所有转换     │
          (active)  │                              │
                    └──────────────────────────────┘
                       │                  ▲
          无活动 30 天 │                  │ 重新活动
                       ▼                  │
                    过期               (stale)
                  (stale) ──────────────────┘
                       │
          无活动 90 天 │
                       ▼
                    归档
                (archived)
                       │
                  可恢复 │  hermes curator restore <name>
                       ▼
                  .archive/ 目录
```

### 2.6 三信号分类 Reconciliation

```
_reconcile_classification(removed, heuristic, model_block, absorbed_declarations)
    │
    for each removed_skill:
    │
    ├── 1. absorbed_into 声明（权威信号）
    │   ├── into != "" 且目标存在 → consolidated
    │   └── into == "" → pruned
    │
    ├── 2. YAML 结构化块（模型意图）
    │   ├── into 目标存在 → consolidated
    │   └── into 目标不存在 → 幻觉，降级
    │
    ├── 3. 工具调用启发式（审计）
    │   └── 发现引用证据 → consolidated
    │
    └── 4. 无证据 → pruned
```

**设计亮点**：
- `absorbed_into` 声明是最高优先级信号（模型在删除时直接声明意图）
- 模型幻觉的 umbrella（目标不存在）被降级为启发式或修剪
- 启发式能捕获模型遗漏的合并（模型忘记在 YAML 中列出）

---

## 三、关键设计模式

### 3.1 单外部提供者限制

**模式名称**：单例约束 + 注册拒绝

**应用位置**：`MemoryManager.add_provider()` (memory_manager.py 行 204-248)

**设计亮点**：
- 内置提供者（name="builtin"）始终被接受
- 第二个外部提供者被拒绝并记录警告
- 防止工具 schema 膨胀（每个提供者暴露 2-5 个工具）
- 防止冲突后端（两个向量存储竞争写入）

### 3.2 流式上下文清洗状态机

**模式名称**：有限状态自动机 + 前缀缓冲

**应用位置**：`StreamingContextScrubber` (memory_manager.py 行 62-170)

**设计亮点**：
- 解决了流式响应中 `<memory-context>` 标签跨 chunk 分割的问题
- `_max_partial_suffix()` 避免在标签中间截断
- `flush()` 在 in_span 时丢弃剩余内容（安全优先）

### 3.3 Fork Agent 审查

**模式名称**：子 Agent 委托 + stdout 隔离

**应用位置**：`_run_llm_review()` (curator.py 行 1515-1649)

**代码示例**：
```python
review_agent = AIAgent(
    max_iterations=9999,  # 伞形化需要大量 API 调用
    quiet_mode=True,
    platform="curator",
    skip_context_files=True,
    skip_memory=True,     # 不触发递归策展
)

# 禁用递归触发器
review_agent._memory_nudge_interval = 0
review_agent._skill_nudge_interval = 0

# stdout/stderr 隔离
with open(os.devnull, "w") as _devnull, \
     redirect_stdout(_devnull), \
     redirect_stderr(_devnull):
    conv_result = review_agent.run_conversation(user_message=prompt)
```

**设计亮点**：
- 独立 AIAgent 实例，不影响主会话
- stdout/stderr 重定向到 /dev/null 避免污染前台
- `max_iterations=9999` 允许处理数百个候选技能
- 禁用递归触发器防止策展器触发自己的审查

### 3.4 伞形化合并策略

**模式名称**：前缀聚类 + 3 种合并方式

**应用位置**：`CURATOR_REVIEW_PROMPT` (curator.py 行 329-444)

**三种合并方式**：
1. **合并到现有伞形**：选择最宽泛的成员作为伞形，添加标记子节
2. **创建新伞形**：无合适成员时，`skill_manage action=create` 创建新的
3. **降级为支撑文件**：窄但有价值的内容移入 `references/`、`templates/`、`scripts/`

**设计亮点**：
- 策展器被明确告知"少即是多"——数百个窄技能是失败，不是特性
- 前缀聚类（hermes-config-*、gateway-*、mcp-* 等）自动发现合并机会
- `absorbed_into` 参数驱动 cron 引用迁移

### 3.5 插件发现机制

**模式名称**：双目录扫描 + 文本检测 + 单例激活

**应用位置**：`plugins/memory/__init__.py`

```
discover_memory_providers()
    │
    ├── 1. 扫描内置目录 plugins/memory/<name>/
    │   └── 检查 __init__.py 是否含 "register_memory_provider" 或 "MemoryProvider"
    │
    ├── 2. 扫描用户目录 $HERMES_HOME/plugins/<name>/
    │   └── 同上
    │
    ├── 3. 内置优先（同名冲突时内置覆盖用户）
    │
    └── 4. 返回 [(name, description, is_available), ...]

load_memory_provider(name)
    │
    ├── 1. 尝试 register(ctx) 函数模式
    │   └── _ProviderCollector 伪上下文捕获提供者实例
    │
    └── 2. 回退到直接查找 MemoryProvider 子类并实例化
```

---

## 四、与已拆解项目的对比

### 4.1 与 claude-code / openclaw 记忆系统对比

| 维度 | claude-code | openclaw | hermes-agent |
|------|-------------|----------|--------------|
| **记忆接口** | 无抽象（内置） | MemoryProvider ABC | **MemoryProvider ABC（更丰富）** |
| **外部提供者** | 无 | 无 | **8 个插件** |
| **上下文隔离** | 无 | 无 | **StreamingContextScrubber** |

### 4.2 三插件实现对比

| 维度 | Honcho | Holographic | Mem0 |
|------|--------|-------------|------|
| **存储** | 云端 | 本地 SQLite | 云端 |
| **向量** | SDK 托管 | HRR + FTS5 | Platform 托管 |
| **事实提取** | 辩证推理（多轮 LLM） | 正则 + 手动 | 服务端 LLM |
| **信任评分** | 无 | 有 | 无 |
| **组合推理** | 无 | HRR reason | 无 |
| **矛盾检测** | 无 | contradict | 无 |
| **recall 模式** | 3 种 | 1 种 | 1 种 |
| **离线可用** | 否 | **是** | 否 |
| **工具数** | 5 | 2（9 action） | 3 |
| **复杂度** | 最高（~1320 行） | 中（~400 行） | 最低（~370 行） |

---

## 五、对 EvoAgent 的参考价值

### 5.1 可直接借鉴的设计

#### 5.1.1 MemoryProvider ABC

**移植建议**：定义 TypeScript 接口

```typescript
interface MemoryProvider {
  readonly name: string;
  
  // 核心
  isAvailable(): boolean;
  initialize(sessionId: string, options: MemoryInitOptions): Promise<void>;
  getToolSchemas(): ToolSchema[];
  
  // 上下文注入
  systemPromptBlock(): string;
  prefetch(query: string, sessionId?: string): string;
  queuePrefetch?(query: string, sessionId?: string): void;
  
  // 持久化
  syncTurn(user: string, assistant: string, sessionId?: string): void;
  handleToolCall(name: string, args: Record<string, unknown>): string;
  
  // 可选钩子
  onSessionEnd?(messages: Message[]): void;
  onSessionSwitch?(newId: string, options: { parent?: string; reset?: boolean }): void;
  onPreCompress?(messages: Message[]): string;
  onDelegation?(task: string, result: string): void;
  
  // 清理
  shutdown(): void;
}
```

#### 5.1.2 StreamingContextScrubber

**移植建议**：直接移植状态机逻辑

```typescript
class StreamingContextScrubber {
  private inSpan = false;
  private buf = "";
  
  feed(text: string): string {
    const combined = this.buf + text;
    this.buf = "";
    const out: string[] = [];
    // ... 同 Python 逻辑
    return out.join("");
  }
  
  flush(): string {
    if (this.inSpan) { this.buf = ""; this.inSpan = false; return ""; }
    const tail = this.buf; this.buf = ""; return tail;
  }
}
```

#### 5.1.3 Curator 自动状态转换

**移植建议**：实现 active → stale → archived 三态自动转换

### 5.2 需要评估的设计

#### 5.2.1 Fork Agent 审查

**问题**：创建完整 AIAgent 实例成本高

**建议**：评估是否可用轻量级 LLM 调用替代

#### 5.2.2 三信号 Reconciliation

**问题**：复杂度高，但解决了模型幻觉问题

**建议**：初期可用单信号（absorbed_into），后期再加 reconciliation

### 5.3 不建议移植的设计

#### 5.3.1 全局插件注册

**问题**：`plugins/memory/__init__.py` 的全局发现机制

**建议**：使用依赖注入

#### 5.3.2 同步阻塞线程

**问题**：`threading.Thread(daemon=True)` 同步运行

**建议**：TypeScript 原生 async/await

---

## 六、动态发现

### 6.1 未在规划文档中预判的高价值内容

#### 6.1.1 agent_context 四种模式

**位置**：memory_provider.py 行 73-75

**发现**：`initialize()` 的 kwargs 包含 `agent_context`，区分 primary/subagent/cron/flush

**价值**：cron 系统提示词不会污染用户表示（cron 跳过写入）

#### 6.1.2 on_memory_write 镜像机制

**位置**：memory_provider.py 行 262-278

**发现**：内置 memory 工具的写入会自动镜像到外部提供者

**价值**：用户偏好写入 MEMORY.md 时自动同步到 Honcho/Mem0

#### 6.1.3 _provider_memory_write_metadata_mode 自省

**位置**：memory_manager.py 行 457-481

**发现**：使用 `inspect.signature()` 检测提供者的 `on_memory_write` 签名，自动适配参数传递方式

**价值**：向后兼容旧版提供者（无 metadata 参数）

#### 6.1.4 Curator 预运行快照

**位置**：curator.py 行 1320-1329

**发现**：LLM 审查前自动创建技能目录快照（curator_backup.snapshot_skills）

**价值**：策展错误可通过快照恢复

#### 6.1.5 Cron 引用自动迁移

**位置**：curator.py 行 976-1001

**发现**：策展合并后自动重写 cron 任务中的技能引用

**价值**：定时任务不会因技能合并而失效

#### 6.1.6 首次运行延迟

**位置**：curator.py 行 226-241

**发现**：首次安装后不立即运行策展，而是等待一个完整间隔（7 天）

**价值**：避免 `hermes update` 后立即修改用户技能库

### 6.2 潜在的反模式警示

#### 6.2.1 curator.py 1,674 行

**问题**：单文件包含状态管理、自动转换、LLM 审查、报告生成、分类 reconciliation

**建议**：拆分为 curator_state.py、curator_transitions.py、curator_review.py、curator_report.py

---

## 七、高价值代码片段

### 7.1 MemoryProvider ABC 核心接口

**位置**：memory_provider.py 行 50-120

```python
class MemoryProvider(ABC):
    """Abstract base class for memory providers."""
    
    @abstractmethod
    def is_available(self) -> bool:
        """Check if provider is properly configured."""
        ...
    
    @abstractmethod
    def initialize(self, session_id: str, **kwargs) -> None:
        """Initialize provider for a session."""
        ...
    
    @abstractmethod
    def get_tool_schemas(self) -> list[dict]:
        """Return tool schemas for memory operations."""
        ...
    
    # Context injection
    @abstractmethod
    def system_prompt_block(self) -> str:
        """Return static system prompt block."""
        ...
    
    @abstractmethod
    def prefetch(self, query: str, session_id: str | None = None) -> str:
        """Prefetch relevant memories for query."""
        ...
```

**价值**：14 个核心方法 + 7 个可选钩子，覆盖完整生命周期

### 7.2 StreamingContextScrubber 状态机

**位置**：memory_manager.py 行 180-250

```python
class StreamingContextScrubber:
    """FSM for scrubbing <memory-context> tags across stream chunks."""
    
    def __init__(self):
        self._state = "outside"  # outside | in_tag | in_content
        self._buffer = ""
    
    def process(self, chunk: str) -> str:
        """Process a chunk and return scrubbed text."""
        # State machine handles partial tags across chunk boundaries
        ...
```

**价值**：解决流式场景中记忆标签跨 chunk 边界的问题

### 7.3 Curator 自动状态转换

**位置**：curator.py 行 450-520

```python
def _maybe_transition_skills(self, now: float) -> list[str]:
    """Auto-transition skills based on last_used_at."""
    transitions = []
    for skill in self._skills.values():
        age_days = (now - skill.last_used_at) / 86400
        if skill.state == "active" and age_days > STALE_THRESHOLD_DAYS:
            skill.state = "stale"
            transitions.append(skill.name)
        elif skill.state == "stale" and age_days > ARCHIVE_THRESHOLD_DAYS:
            skill.state = "archived"
            transitions.append(skill.name)
    return transitions
```

**价值**：自动化的技能生命周期管理，无需用户干预

---

## 八、总结

### 7.1 核心收获

1. **MemoryProvider ABC 是最完善的记忆接口**：14 个核心方法 + 7 个可选钩子
2. **StreamingContextScrubber 解决了流式场景的记忆标签泄漏**：有限状态机 + 前缀缓冲
3. **Curator 是自进化的核心**：空闲触发 + Fork Agent + 自动状态转换 + 伞形化合并
4. **三信号 reconciliation 解决了模型幻觉问题**：absorbed_into > YAML > 启发式
5. **8 个记忆插件展示了生态丰富性**：从纯本地（Holographic）到全云端（Honcho/Mem0）
6. **Cron 引用迁移是生产级细节**：策展后定时任务不会失效

### 7.2 对 EvoAgent 的建议

1. **采纳 MemoryProvider ABC**：定义完整的 TypeScript 接口
2. **采纳 StreamingContextScrubber**：流式场景的记忆标签清理
3. **采纳 Curator 自动状态转换**：active → stale → archived 三态
4. **采纳单外部提供者限制**：防止 schema 膨胀
5. **评估 Fork Agent 审查**：成本高但效果好
6. **改进文件组织**：将 curator.py 拆分为多个专注模块

### 7.3 后续步骤建议

- 步骤 6：分析 `providers/base.py` + `agent/auxiliary_client.py` 的 Provider 系统
- 步骤 7：分析 `gateway/run.py` 的 Agent 缓存管理
