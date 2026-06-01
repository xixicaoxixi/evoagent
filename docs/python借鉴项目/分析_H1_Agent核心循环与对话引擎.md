# 分析_H1_Agent核心循环与对话引擎

> **轮次**：第 H 轮 — Hermes-Agent 拆解
> **日期**：2026-05-08
> **阅读量**：~14,666 行（run_agent.py 全文）
> **对标文档**：分析_02（Agent 编排与生命周期）、分析_15（核心设计原则与架构全景）、代码片段_Agent核心循环与编排

---

## 一、核心发现摘要

### 1.1 与 claude-code / openclaw 的对比

| 维度 | claude-code | openclaw | hermes-agent |
|------|-------------|----------|--------------|
| **主循环模式** | AsyncGenerator 驱动 (`query()`) | 回调驱动 + Harness | **回调驱动 + while 循环** |
| **类规模** | ~500 行核心逻辑 | 分散在多个类 | **单类 14,666 行（God Object）** |
| **迭代预算** | 无显式预算 | 外部控制 | **IterationBudget 线程安全计数器** |
| **工具执行** | 分区并行 | 串行 | **智能决策：并发/串行自动切换** |
| **上下文压缩** | 三级递进 | 可插拔 ContextEngine | **ContextCompressor + 插件引擎** |
| **中断机制** | AbortController | 外部信号 | **interrupt() + steer() 双通道** |
| **Provider 回退** | 无内置 | 手动配置 | **_fallback_chain 自动切换** |
| **API 模式** | Anthropic 原生 | 多适配器 | **chat_completions / codex_responses / anthropic_messages / bedrock_converse** |

### 1.2 核心设计特点

1. **回调驱动的主循环**：不同于 claude-code 的 AsyncGenerator 模式，hermes-agent 使用传统的 while 循环 + 回调机制
2. **线程安全设计**：`IterationBudget`、`_client_lock`、`_tool_worker_threads_lock` 等多处线程同步原语
3. **智能工具执行**：根据工具类型自动决策并发/串行执行
4. **多 Provider 支持**：内置 4 种 API 模式，支持自动回退链
5. **双通道用户干预**：`interrupt()` 硬中断 + `steer()` 软引导

---

## 二、模块架构分析

### 2.1 AIAgent 类结构

```
AIAgent (14,666 行)
├── 构造函数 __init__ (行 908-2255, ~1,347 行)
│   ├── 参数解析与验证
│   ├── Provider/Client 初始化
│   ├── 工具系统加载
│   ├── 记忆系统初始化
│   ├── 上下文压缩器配置
│   └── 状态快照 (_primary_runtime)
│
├── 主循环 run_conversation (行 10768-14434, ~3,666 行)
│   ├── 前置检查与初始化
│   ├── API 调用重试循环
│   ├── 响应处理与工具调度
│   └── 上下文压缩触发
│
├── 工具执行 _execute_tool_calls* (行 9626-10158, ~532 行)
│   ├── _execute_tool_calls (调度器)
│   ├── _execute_tool_calls_concurrent (并发执行)
│   └── _execute_tool_calls_sequential (串行执行)
│
├── 系统提示词 _build_system_prompt (行 5108-5293, ~185 行)
│
├── 上下文压缩 _compress_context (行 9416-9586, ~170 行)
│
├── 中断机制 interrupt/steer (行 4587-4786, ~199 行)
│
├── Provider 回退 _try_activate_fallback (行 7828-8022, ~194 行)
│
└── 简化接口 chat (行 14435-14447, ~12 行)
```

### 2.2 构造函数参数分类

| 类别 | 参数 | 说明 |
|------|------|------|
| **连接配置** | `base_url`, `api_key`, `provider`, `api_mode` | API 端点与认证 |
| **模型配置** | `model`, `max_tokens`, `reasoning_config`, `service_tier` | 模型行为控制 |
| **迭代控制** | `max_iterations`, `tool_delay`, `iteration_budget` | 循环限制 |
| **工具配置** | `enabled_toolsets`, `disabled_toolsets`, `tools` | 工具过滤 |
| **回调接口** | `tool_progress_callback`, `thinking_callback`, `clarify_callback`, `step_callback`, `stream_delta_callback` 等 10+ | 事件通知 |
| **会话标识** | `session_id`, `platform`, `user_id`, `chat_id`, `thread_id`, `gateway_session_key` | 多租户支持 |
| **记忆配置** | `skip_memory`, `session_db`, `parent_session_id` | 记忆系统 |
| **回退配置** | `fallback_model`, `credential_pool` | Provider 故障转移 |
| **检查点** | `checkpoints_enabled`, `checkpoint_max_snapshots` | 文件系统快照 |

### 2.3 主循环流程图

```
run_conversation(user_message)
    │
    ├── 1. 前置初始化
    │   ├── _ensure_db_session()
    │   ├── set_session_context(session_id)
    │   ├── _restore_primary_runtime()  # 恢复主 Provider
    │   ├── _sanitize_surrogates(user_message)
    │   └── 重置重试计数器
    │
    ├── 2. 系统提示词构建（首次或压缩后重建）
    │   └── _build_system_prompt() → _cached_system_prompt
    │
    ├── 3. 预压缩检查
    │   └── if tokens >= threshold: _compress_context()
    │
    ├── 4. 插件钩子: pre_llm_call
    │
    └── 5. 主循环 while (api_call_count < max_iterations)
        │
        ├── 5.1 中断检查
        │   └── if _interrupt_requested: break
        │
        ├── 5.2 迭代预算消费
        │   └── iteration_budget.consume()
        │
        ├── 5.3 /steer 注入（预 API 调用）
        │
        ├── 5.4 构建 API 请求
        │   ├── _sanitize_tool_call_arguments()
        │   ├── _repair_message_sequence()
        │   ├── 注入记忆上下文
        │   ├── apply_anthropic_cache_control()
        │   └── _sanitize_api_messages()
        │
        ├── 5.5 API 调用（带重试）
        │   ├── _interruptible_streaming_api_call()
        │   └── 错误分类与处理
        │       ├── 上下文溢出 → _compress_context()
        │       ├── Rate Limit → 回退 + 等待
        │       ├── Auth Error → 尝试回退
        │       └── 其他错误 → 重试/回退
        │
        ├── 5.6 响应处理
        │   ├── finish_reason == "length" → 续写请求
        │   ├── has tool_calls → 工具执行
        │   │   ├── _execute_tool_calls()
        │   │   │   ├── 并发判断: _should_parallelize_tool_batch()
        │   │   │   ├── 并发执行: _execute_tool_calls_concurrent()
        │   │   │   └── 串行执行: _execute_tool_calls_sequential()
        │   │   └── 压缩检查: should_compress() → _compress_context()
        │   │
        │   └── 无 tool_calls → 最终响应
        │       ├── 空响应恢复
        │       │   ├── 部分流恢复
        │       │   ├── 后工具空响应 nudge
        │       │   ├── Thinking-only prefill
        │       │   └── 回退尝试
        │       └── break (退出循环)
        │
        └── 5.7 会话持久化
            └── _persist_session()
```

---

## 三、关键设计模式

### 3.1 智能工具执行决策

**模式名称**：策略模式 + 规则引擎

**应用位置**：`_execute_tool_calls()` (行 9626-9647)

**代码示例**：
```python
# 行 9626-9647
def _execute_tool_calls(self, assistant_message, messages: list, effective_task_id: str, api_call_count: int = 0) -> None:
    """Execute tool calls from the assistant message and append results to messages.

    Dispatches to concurrent execution only for batches that look
    independent: read-only tools may always share the parallel path, while
    file reads/writes may do so only when their target paths do not overlap.
    """
    tool_calls = assistant_message.tool_calls
    self._executing_tools = True
    try:
        if not _should_parallelize_tool_batch(tool_calls):
            return self._execute_tool_calls_sequential(...)
        return self._execute_tool_calls_concurrent(...)
    finally:
        self._executing_tools = False
```

**决策规则**（`_should_parallelize_tool_batch`, 行 377-418）：
```python
# 永不并行的工具（交互式）
_NEVER_PARALLEL_TOOLS = frozenset({"clarify"})

# 安全并行的只读工具
_PARALLEL_SAFE_TOOLS = frozenset({
    "ha_get_state", "ha_list_entities", "ha_list_services",
    "read_file", "search_files", "session_search", "skill_view",
    "skills_list", "vision_analyze", "web_extract", "web_search",
})

# 路径作用域工具（需检查路径重叠）
_PATH_SCOPED_TOOLS = frozenset({"read_file", "write_file", "patch"})
```

### 3.2 迭代预算管理

**模式名称**：线程安全计数器 + 退款机制

**应用位置**：`IterationBudget` 类 (行 272-315)

**代码示例**：
```python
# 行 272-315
class IterationBudget:
    """Thread-safe iteration counter for an agent.

    Each agent (parent or subagent) gets its own ``IterationBudget``.
    The parent's budget is capped at ``max_iterations`` (default 90).
    Each subagent gets an independent budget capped at
    ``delegation.max_iterations`` (default 50).
    """

    def __init__(self, max_total: int):
        self.max_total = max_total
        self._used = 0
        self._lock = threading.Lock()

    def consume(self) -> bool:
        """Try to consume one iteration.  Returns True if allowed."""
        with self._lock:
            if self._used >= self.max_total:
                return False
            self._used += 1
            return True

    def refund(self) -> None:
        """Give back one iteration (e.g. for execute_code turns)."""
        with self._lock:
            if self._used > 0:
                self._used -= 1
```

**设计亮点**：
- 父子 Agent 独立预算，避免子 Agent 耗尽父 Agent 配额
- `refund()` 机制：`execute_code` 调用不消耗预算（程序化工具调用）

### 3.3 双通道用户干预

**模式名称**：硬中断 + 软引导

**应用位置**：`interrupt()` (行 4587-4653) 和 `steer()` (行 4688-4722)

**interrupt() - 硬中断**：
```python
def interrupt(self, message: str = None) -> None:
    """Request the agent to interrupt its current tool-calling loop."""
    self._interrupt_requested = True
    self._interrupt_message = message
    
    # 信号传播到执行线程
    if self._execution_thread_id is not None:
        _set_interrupt(True, self._execution_thread_id)
    
    # 扇出到并发工具工作线程
    with self._tool_worker_threads_lock:
        _worker_tids = list(self._tool_worker_threads)
    for _wtid in _worker_tids:
        _set_interrupt(True, _wtid)
    
    # 传播到子 Agent
    for child in children_copy:
        child.interrupt(message)
```

**steer() - 软引导**：
```python
def steer(self, text: str) -> bool:
    """Inject a user message into the next tool result without interrupting.

    Unlike interrupt(), this does NOT stop the current tool call. The
    text is stashed and the agent loop appends it to the LAST tool
    result's content once the current tool batch finishes.
    """
    if not text or not text.strip():
        return False
    with self._pending_steer_lock:
        if self._pending_steer:
            self._pending_steer = self._pending_steer + "\n" + cleaned
        else:
            self._pending_steer = cleaned
    return True
```

**对比**：
| 特性 | interrupt() | steer() |
|------|-------------|---------|
| 立即停止 | ✅ | ❌ |
| 等待当前工具完成 | ❌ | ✅ |
| 保持角色交替 | N/A | ✅（修改现有 tool 消息） |
| 适用场景 | 用户发送新消息 | 用户补充指导 |

### 3.4 Provider 回退链

**模式名称**：责任链 + 原地替换

**应用位置**：`_try_activate_fallback()` (行 7828-8022)

**代码示例**：
```python
def _try_activate_fallback(self, reason: "FailoverReason | None" = None) -> bool:
    """Switch to the next fallback model/provider in the chain."""
    if self._fallback_index >= len(self._fallback_chain):
        return False

    fb = self._fallback_chain[self._fallback_index]
    self._fallback_index += 1
    
    # 使用集中式路由器构建客户端
    fb_client, _resolved_fb_model = resolve_provider_client(
        fb_provider, model=fb_model, raw_codex=True,
        explicit_base_url=fb_base_url_hint,
        explicit_api_key=fb_api_key_hint)
    
    # 原地替换
    self.model = fb_model
    self.provider = fb_provider
    self.base_url = fb_base_url
    self.api_mode = fb_api_mode
    self._fallback_activated = True
    
    # 更新上下文压缩器限制
    self.context_compressor.update_model(
        model=self.model,
        context_length=fb_context_length,
        ...
    )
    return True
```

**设计亮点**：
- 原地替换所有运行时状态，无需重建 Agent
- 自动更新上下文压缩器的上下文窗口限制
- Rate Limit 触发 60 秒冷却期

### 3.5 系统提示词分层组装

**模式名称**：分层构建 + 缓存

**应用位置**：`_build_system_prompt()` (行 5108-5293)

**分层结构**：
```
1. Agent Identity (SOUL.md 或 DEFAULT_AGENT_IDENTITY)
2. Hermes Help Guidance
3. Tool-aware Behavioral Guidance
   ├── Memory Guidance (if "memory" in tools)
   ├── Session Search Guidance (if "session_search" in tools)
   ├── Skills Guidance (if "skill_manage" in tools)
   └── Kanban Guidance (if "kanban_show" in tools)
4. Nous Subscription Prompt
5. Tool-use Enforcement Guidance
6. User/Gateway System Prompt
7. Persistent Memory (MEMORY.md + USER.md)
8. External Memory Provider Block
9. Skills System Prompt
10. Context Files (AGENTS.md, .cursorrules)
11. Timestamp + Session ID + Model Info
12. Environment Hints (WSL, Termux)
13. Platform-specific Hints
```

**缓存策略**：
- 首次构建后缓存到 `_cached_system_prompt`
- 仅在压缩事件后重建
- 会话恢复时从 SQLite 加载（保持前缀一致性）

---

## 四、与已拆解项目的对比

### 4.1 主循环模式对比

| 项目 | 模式 | 优点 | 缺点 |
|------|------|------|------|
| **claude-code** | AsyncGenerator (`query()`) | 天然支持流式、易组合 | 需要异步运行时 |
| **openclaw** | Harness + 回调 | 模块化清晰 | 复杂度高 |
| **hermes-agent** | while 循环 + 回调 | 简单直接、无异步依赖 | God Object、难以测试 |

### 4.2 工具执行对比

| 项目 | 并发策略 | 决策逻辑 |
|------|----------|----------|
| **claude-code** | 分区并行 | 工具类型分区（Bash 独立） |
| **openclaw** | 串行 | 无并发 |
| **hermes-agent** | 智能决策 | 工具类型 + 路径重叠检测 |

### 4.3 上下文压缩对比

| 项目 | 触发时机 | 压缩策略 |
|------|----------|----------|
| **claude-code** | 三级递进（轻→重→紧急） | 迭代摘要 + Token 预算 |
| **openclaw** | 可插拔 ContextEngine | 插件决定 |
| **hermes-agent** | 阈值触发（默认 50%） | ContextCompressor + 插件引擎 |

### 4.4 中断机制对比

| 项目 | 中断方式 | 特点 |
|------|----------|------|
| **claude-code** | AbortController | 单通道、立即中断 |
| **openclaw** | 外部信号 | 依赖外部控制 |
| **hermes-agent** | interrupt() + steer() | **双通道**、软硬结合 |

---

## 五、对 EvoAgent 的参考价值

### 5.1 可直接借鉴的设计

#### 5.1.1 IterationBudget 线程安全计数器

**移植建议**：使用 TypeScript 的 `Atomics` 或 `Mutex` 实现类似机制

```typescript
// TypeScript 移植示例
class IterationBudget {
  private used = 0;
  private lock = new Mutex();
  
  constructor(public readonly maxTotal: number) {}
  
  async consume(): Promise<boolean> {
    const release = await this.lock.acquire();
    try {
      if (this.used >= this.maxTotal) return false;
      this.used++;
      return true;
    } finally {
      release();
    }
  }
  
  async refund(): Promise<void> {
    const release = await this.lock.acquire();
    try {
      if (this.used > 0) this.used--;
    } finally {
      release();
    }
  }
}
```

#### 5.1.2 智能工具执行决策

**移植建议**：定义工具元数据，在调度器中实现决策逻辑

```typescript
// TypeScript 移植示例
const NEVER_PARALLEL_TOOLS = new Set(["clarify"]);
const PARALLEL_SAFE_TOOLS = new Set([
  "read_file", "search_files", "web_search", ...
]);
const PATH_SCOPED_TOOLS = new Set(["read_file", "write_file", "patch"]);

function shouldParallelizeToolBatch(toolCalls: ToolCall[]): boolean {
  if (toolCalls.length <= 1) return false;
  
  const toolNames = toolCalls.map(tc => tc.function.name);
  if (toolNames.some(name => NEVER_PARALLEL_TOOLS.has(name))) return false;
  
  // 路径重叠检测...
  return toolNames.every(name => 
    PARALLEL_SAFE_TOOLS.has(name) || PATH_SCOPED_TOOLS.has(name)
  );
}
```

#### 5.1.3 双通道用户干预

**移植建议**：实现 `interrupt()` 和 `steer()` 两个独立通道

```typescript
// TypeScript 移植示例
class AIAgent {
  private interruptRequested = false;
  private pendingSteer: string | null = null;
  
  interrupt(message?: string): void {
    this.interruptRequested = true;
    // 传播到子 Agent 和工作线程...
  }
  
  steer(text: string): boolean {
    if (!text.trim()) return false;
    this.pendingSteer = this.pendingSteer 
      ? `${this.pendingSteer}\n${text.trim()}`
      : text.trim();
    return true;
  }
}
```

### 5.2 需要评估的设计

#### 5.2.1 God Object 问题

**问题**：`AIAgent` 类 14,666 行，职责过多

**建议**：拆分为多个专注的类
- `ConversationLoop`：主循环逻辑
- `ToolExecutor`：工具执行
- `ProviderManager`：Provider 切换与回退
- `SystemPromptBuilder`：系统提示词构建
- `CompressionManager`：上下文压缩

#### 5.2.2 回调地狱

**问题**：10+ 个回调参数，难以管理

**建议**：使用事件发射器模式

```typescript
// TypeScript 重构建议
interface AgentEvents {
  'tool:started': (tool: string, args: unknown) => void;
  'tool:completed': (tool: string, result: string, duration: number) => void;
  'thinking': (text: string) => void;
  'reasoning:available': (text: string) => void;
  'step': (count: number, prevTools: ToolSummary[]) => void;
  'status': (message: string) => void;
}

class AIAgent extends EventEmitter<AgentEvents> {
  // 使用 emit() 替代多个回调参数
}
```

### 5.3 不建议移植的设计

#### 5.3.1 同步阻塞式设计

**问题**：大量 `time.sleep()` 和同步等待

**建议**：使用 TypeScript 的 `Promise` + `AbortController`

#### 5.3.2 全局状态依赖

**问题**：`_openrouter_prewarm_done` 等全局变量

**建议**：使用依赖注入或单例模式管理

---

## 六、动态发现

### 6.1 未在规划文档中预判的高价值内容

#### 6.1.1 _SafeWriter 管道保护

**位置**：行 182-229

**发现**：处理 systemd/Docker 环境下 stdout/stderr 管道断开导致的 OSError

**价值**：提高服务稳定性，避免静默崩溃

```python
class _SafeWriter:
    """Transparent stdio wrapper that catches OSError/ValueError from broken pipes."""
    def write(self, data):
        try:
            return self._inner.write(data)
        except (OSError, ValueError):
            return len(data) if isinstance(data, str) else 0
```

#### 6.1.2 OpenAI SDK 延迟加载

**位置**：行 63-90

**发现**：使用代理类延迟加载 OpenAI SDK（~240ms 导入时间）

**价值**：优化启动性能，避免不必要的导入

```python
class _OpenAIProxy:
    """Module-level proxy that looks like ``openai.OpenAI`` but imports lazily."""
    def __call__(self, *args, **kwargs):
        return _load_openai_cls()(*args, **kwargs)

OpenAI = _OpenAIProxy()  # 替代 from openai import OpenAI
```

#### 6.1.3 Surrogate 字符清理

**位置**：行 450-500

**发现**：处理从富文本编辑器（Google Docs、Word）粘贴导致的代理对字符问题

**价值**：防止 JSON 序列化崩溃

```python
_SURROGATE_RE = re.compile(r'[\ud800-\udfff]')

def _sanitize_surrogates(text: str) -> str:
    """Replace lone surrogate code points with U+FFFD."""
    if _SURROGATE_RE.search(text):
        return _SURROGATE_RE.sub('\ufffd', text)
    return text
```

#### 6.1.4 破坏性命令检测

**位置**：行 348-374

**发现**：使用正则表达式检测终端命令是否可能修改/删除文件

**价值**：为检查点机制提供触发条件

```python
_DESTRUCTIVE_PATTERNS = re.compile(
    r"""(?:^|\s|&&|\|\||;|`)(?:
        rm\s|rmdir\s|
        cp\s|install\s|
        mv\s|
        sed\s+-i|
        truncate\s|
        dd\s|
        shred\s|
        git\s+(?:reset|clean|checkout)\s
    )""",
    re.VERBOSE,
)
_REDIRECT_OVERWRITE = re.compile(r'[^>]>[^>]|^>[^>]')

def _is_destructive_command(cmd: str) -> bool:
    """Heuristic: does this terminal command look like it modifies/deletes files?"""
    ...
```

### 6.2 潜在的反模式警示

#### 6.2.1 God Object

**问题**：`AIAgent` 类 14,666 行，包含 140+ 方法

**影响**：难以测试、难以维护、职责不清

**建议**：拆分为多个专注的类

#### 6.2.2 深层嵌套

**问题**：`run_conversation()` 方法嵌套深度超过 5 层

**影响**：代码可读性差、难以追踪控制流

**建议**：使用 Guard Clauses 和提取方法

---

## 七、高价值代码片段

### 7.1 并发工具执行工作线程

**位置**：行 9911-9984

```python
def _run_tool(index, tool_call, function_name, function_args):
    """Worker function executed in a thread."""
    _worker_tid = threading.current_thread().ident
    with self._tool_worker_threads_lock:
        self._tool_worker_threads.add(_worker_tid)
    
    # 中断信号传播
    if self._interrupt_requested:
        _set_interrupt(True, _worker_tid)
    
    # 设置活动回调（用于心跳）
    set_activity_callback(self._touch_activity)
    
    # 传播审批回调
    if _parent_approval_cb is not None:
        _set_approval_callback(_parent_approval_cb)
    
    try:
        result = self._invoke_tool(...)
    except Exception as tool_error:
        result = f"Error executing tool '{function_name}': {tool_error}"
    finally:
        with self._tool_worker_threads_lock:
            self._tool_worker_threads.discard(_worker_tid)
        _set_interrupt(False, _worker_tid)
        _set_approval_callback(None)
    
    return result
```

### 7.2 空响应恢复策略

**位置**：行 13829-14082

```python
# 部分流恢复
_partial_streamed = getattr(self, "_current_streamed_assistant_text", "") or ""
if self._has_content_after_think_block(_partial_streamed):
    final_response = self._strip_think_blocks(_partial_streamed).strip()
    break

# 后工具空响应 nudge
if _prior_was_tool and not getattr(self, "_post_tool_empty_retried", False):
    self._post_tool_empty_retried = True
    messages.append({
        "role": "user",
        "content": "You just executed tool calls but returned an empty response. "
                   "Please process the tool results above and continue with the task."
    })
    continue

# Thinking-only prefill 续写
if _has_structured and self._thinking_prefill_retries < 2:
    self._thinking_prefill_retries += 1
    interim_msg["_thinking_prefill"] = True
    messages.append(interim_msg)
    continue
```

### 7.3 上下文压缩会话分割

**位置**：行 9483-9514

```python
if self._session_db:
    # 触发记忆提取
    self.commit_memory_session(messages)
    
    # 结束旧会话
    self._session_db.end_session(self.session_id, "compression")
    old_session_id = self.session_id
    
    # 创建新会话
    self.session_id = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
    self._session_db.create_session(
        session_id=self.session_id,
        parent_session_id=old_session_id,
    )
    
    # 传播标题
    if old_title:
        new_title = self._session_db.get_next_title_in_lineage(old_title)
        self._session_db.set_session_title(self.session_id, new_title)
```

---

## 八、总结

### 8.1 核心收获

1. **回调驱动的主循环**：hermes-agent 使用传统的 while 循环 + 回调机制，不同于 claude-code 的 AsyncGenerator 模式
2. **智能工具执行**：根据工具类型和路径重叠自动决策并发/串行执行
3. **双通道用户干预**：`interrupt()` 硬中断 + `steer()` 软引导，提供灵活的用户控制
4. **Provider 回退链**：内置故障转移机制，支持多级 Provider 切换
5. **线程安全设计**：多处线程同步原语，支持并发访问

### 8.2 对 EvoAgent 的建议

1. **采纳 IterationBudget**：实现线程安全的迭代预算管理
2. **采纳智能工具执行**：根据工具元数据自动决策并发策略
3. **采纳双通道干预**：实现 interrupt() + steer() 双通道
4. **避免 God Object**：将 AIAgent 拆分为多个专注的类
5. **避免回调地狱**：使用事件发射器模式替代多个回调参数

### 8.3 后续步骤建议

- 步骤 2：深入分析 `context_compressor.py` 的压缩算法
- 步骤 3：分析 `tools/registry.py` 的 AST 扫描自注册机制
- 步骤 4：分析 `tools/mcp_tool.py` 的 MCP 客户端实现
