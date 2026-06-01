# 分析 H9：Cron 调度与 ACP 协议

> 拆解目标：理解定时任务引擎和 ACP 协议适配
> 复杂度：★★☆☆☆ | 耦合度：低 | 实际阅读量：~6,200 行

---

## 一、核心发现摘要

### 1.1 Cron 调度器：函数式模块设计 + 文件锁并发控制

`cron/scheduler.py`（1,740 行）采用**无类设计**——纯函数协作而非传统 OOP 类结构。核心入口是 `tick()` 函数，由网关每 60 秒调用一次。

**关键设计决策**：
- **延迟导入策略**：`AIAgent` 和 `SessionDB` 仅在需要时导入（第1074行），避免不必要的启动开销
- **动态配置重载**：每次作业运行时重新加载 `.env` 和 `config.yaml`（第1192-1196行），确保配置变更立即生效
- **跨平台文件锁**：Unix 使用 `fcntl.flock`，Windows 使用 `msvcrt.locking`，非阻塞模式（`LOCK_NB`）避免等待

### 1.2 双重 Prompt 注入防护机制

**第一层：创建时扫描**（`tools/cronjob_tools.py` 第60-68行）

**第二层：运行时组装扫描**（`scheduler.py` 第930-952行）

**设计意图**：技能文件可能在作业创建后被篡改，或恶意技能被安装。运行时扫描在技能内容加载完成后执行，确保即使原始 prompt 安全，组装后的完整 prompt 也不会包含注入载荷。

### 1.3 at-most-once 语义：预先推进 next_run_at

**设计权衡**：传统调度器采用 at-least-once 语义（确保任务至少执行一次，可能重复）。Hermes 选择 at-most-once（确保任务最多执行一次，可能丢失），因为重复执行 LLM 任务的成本远高于丢失一次执行。

### 1.4 ACP 协议：完整的 Agent Client Protocol 服务端

`acp_adapter/server.py`（1,714 行）实现了完整的 ACP 服务端，支持 Zed 等编辑器的原生 Agent 集成。

**能力声明**（InitializeResponse）：
- `load_session`: 支持加载已有会话
- `prompt_capabilities.image=True`: 支持图像输入
- `session_capabilities.fork/list/resume`: 会话分叉、列出、恢复

**会话持久化**：会话数据保存到 SQLite（`~/.hermes/state.db`），支持进程重启后恢复。

### 1.5 ForkSession：与 claude-code Fork 的对比

| 特性 | Hermes ForkSession | claude-code Fork |
|------|-------------------|------------------|
| 新工作目录 | 支持指定新的 `cwd` | 继承原目录 |
| 历史复制 | `copy.deepcopy()` 深拷贝 | 类似深拷贝 |
| 会话隔离 | 独立 `session_id` 和 `AIAgent` 实例 | 独立实例 |
| 持久化 | 新会话独立持久化到数据库 | 独立持久化 |
| 演化 | fork 后独立演化，互不影响 | 独立演化 |

### 1.6 流式响应：跨线程回调桥接

**回调类型**：
- `make_message_cb`: 流式传输助手消息文本
- `make_thinking_cb`: 传输推理/思考内容
- `make_tool_progress_cb`: 工具调用开始通知
- `make_step_cb`: 工具调用完成通知

---

## 二、模块架构分析

### 2.1 Cron 调度器架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        触发层                                    │
│  Gateway 每60秒调用 → tick()                                    │
├─────────────────────────────────────────────────────────────────┤
│  并发控制：跨平台文件锁 (.tick.lock)                              │
│  - Unix: fcntl.flock(LOCK_EX | LOCK_NB)                        │
│  - Windows: msvcrt.locking(LK_NBLCK)                           │
├─────────────────────────────────────────────────────────────────┤
│  作业获取：get_due_jobs()                                        │
│  - 加载 jobs.json                                               │
│  - 检查 next_run_at <= now                                      │
│  - 过期作业快进到下次（避免重启后爆发执行）                        │
├─────────────────────────────────────────────────────────────────┤
│  执行分区：                                                      │
│  ┌─────────────────┐  ┌─────────────────────────────────────┐  │
│  │ workdir_jobs    │  │ parallel_jobs                       │  │
│  │ (串行执行)       │  │ (ThreadPoolExecutor 并行)           │  │
│  │ 修改 TERMINAL_  │  │ 无状态，可安全并行                   │  │
│  │ CWD 环境变量     │  │                                     │  │
│  └─────────────────┘  └─────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  作业执行：_process_job() → run_job()                            │
│  1. 执行前脚本 (wake-gate)                                       │
│  2. 构建 Prompt (技能加载 + 注入扫描)                             │
│  3. 初始化 AIAgent                                               │
│  4. 运行带不活动超时的对话                                        │
│  5. 保存输出 + 交付结果                                           │
├─────────────────────────────────────────────────────────────────┤
│  交付目标：                                                      │
│  - "local": 仅保存到文件                                        │
│  - "origin": 发送到创建作业的平台                                │
│  - "telegram/discord/slack/...": 指定平台                        │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 ACP 服务端架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    ACP JSON-RPC 传输层                           │
│  stdio (stdout 协议帧, stderr 日志)                              │
├─────────────────────────────────────────────────────────────────┤
│  HermesACPAgent (acp.Agent 子类)                                 │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌───────────┐ │
│  │ initialize  │ │ new_session │ │ load_session│ │ fork_     │ │
│  │             │ │             │ │             │ │ session   │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └───────────┘ │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐              │
│  │ prompt      │ │ cancel      │ │ tools/      │              │
│  │ (主处理)     │ │             │ │ resources   │              │
│  └─────────────┘ └─────────────┘ └─────────────┘              │
├─────────────────────────────────────────────────────────────────┤
│  SessionManager                                                  │
│  - 内存中的 SessionState 缓存                                    │
│  - 持久化到 SQLite SessionDB                                     │
│  - 支持进程重启后恢复                                             │
├─────────────────────────────────────────────────────────────────┤
│  AIAgent 实例 (每个会话一个)                                      │
│  - 工具集: hermes-acp + MCP 服务器                               │
│  - 回调桥接: tool_progress → ACP ToolCallStart                   │
│  - 流式: stream_delta → ACP message text                        │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 工具映射：Hermes → ACP ToolKind

```python
TOOL_KIND_MAP = {
    # File operations
    "read_file": "read",
    "write_file": "edit",
    "patch": "edit",
    "search_files": "search",
    # Terminal / execution
    "terminal": "execute",
    "process": "execute",
    "execute_code": "execute",
    # Web / fetch
    "web_search": "fetch",
    "web_extract": "fetch",
    # Browser
    "browser_navigate": "fetch",
    "browser_click": "execute",
    # Agent internals
    "delegate_task": "execute",
    "vision_analyze": "read",
    "image_generate": "execute",
    # Thinking / meta
    "_thinking": "think",
}
```

---

## 三、关键设计模式

### 3.1 串并行分区执行

**设计意图**：`workdir` 作业通过设置 `TERMINAL_CWD` 环境变量影响工具的工作目录。这是一个全局状态，并行修改会导致竞态条件。通过分区，确保有 `workdir` 的作业串行执行，无 `workdir` 的作业可以并行加速。

### 3.2 ContextVar 用于作业隔离

**设计意图**：每个作业可能来自不同的平台/聊天，需要独立的会话上下文。ContextVar 提供了线程（和协程）级别的隔离，确保并行作业不会互相干扰。

### 3.3 脚本路径安全验证

**安全边界**：脚本必须在 `~/.hermes/scripts/` 目录内。通过 `path.relative_to()` 检查，防止 `../../../etc/passwd` 等路径遍历攻击。

### 3.4 不活动超时 vs 绝对超时

**设计意图**：绝对超时可能误杀长时间运行的合法任务（如大型代码库分析）。不活动超时只在没有新输出时触发，允许任务持续运行只要它还在产生进展。

### 3.5 ACP 权限桥接

**桥接模式**：Hermes 内部使用 `"once"`/`"always"`/`"deny"` 字符串，ACP 使用结构化 `PermissionOption`。桥接函数将两者转换，使 Hermes 的危险操作审批系统可以与 ACP 客户端的权限 UI 无缝集成。

### 3.6 作业链：context_from

**设计意图**：支持作业流水线——一个作业收集数据，下一个作业处理数据。通过 `context_from` 声明依赖，调度器自动注入上游输出作为下游的上下文。

---

## 四、与已拆解项目的对比

### 4.1 Cron 引擎对比

| 维度 | 分析_07 (对标项目) | hermes-agent |
|------|-------------------|--------------|
| 调度语义 | at-least-once | at-most-once (预先推进 next_run_at) |
| 并发控制 | 未提及 | 文件锁 + 串并行分区 |
| Prompt 注入防护 | 未提及 | 双重扫描（创建时 + 运行时） |
| 作业链 | 未提及 | context_from 依赖注入 |
| 交付目标 | 本地文件 | 多平台（telegram/discord/slack/...） |
| 超时策略 | 绝对超时 | 不活动超时 |

### 4.2 ACP 协议对比

| 维度 | 分析_06 (对标项目) | hermes-agent |
|------|-------------------|--------------|
| 协议实现 | ACP 客户端 | ACP 服务端 |
| 会话持久化 | 未提及 | SQLite 持久化 + 进程重启恢复 |
| Fork 机制 | 类似 | 支持指定新 cwd |
| MCP 集成 | 未提及 | 动态 MCP 服务器注册 |
| 权限桥接 | 未提及 | ACP PermissionOption ↔ hermes 回调桥接 |

---

## 五、对 EvoAgent 的参考价值

### 5.1 应采纳的模式

1. **双重 Prompt 注入防护**：创建时扫描 + 运行时组装扫描。技能内容可能在创建后被篡改，运行时扫描是最后一道防线。

2. **at-most-once 调度语义**：预先推进 `next_run_at` 再执行，避免崩溃后重复执行。对于 LLM 任务，重复执行的成本远高于丢失一次执行。

3. **串并行分区执行**：识别有状态（修改全局状态）和无状态作业，分别串行和并行执行。最大化吞吐量的同时保证正确性。

4. **不活动超时**：替代绝对超时，允许长时间运行的合法任务，只中断真正卡住的作业。

5. **ContextVar 隔离**：每作业独立的会话上下文，避免并行作业互相干扰。

6. **ACP 回调桥接**：通过 `asyncio.run_coroutine_threadsafe` 将工作线程的事件桥接到主事件循环，实现流式响应。

7. **会话 Fork**：深拷贝历史记录创建新会话，支持探索不同路径而不影响原会话。

### 5.2 应改进的模式

1. **1,740 行的 scheduler.py**：函数式模块设计虽然简洁，但单文件过大。建议按功能拆分：`scheduler_tick.py`, `scheduler_run.py`, `scheduler_delivery.py`。

2. **全局文件锁**：`.tick.lock` 是全局锁，所有 profile 共享。建议按 profile 隔离锁文件。

3. **TERMINAL_CWD 环境变量**：全局状态导致 workdir 作业必须串行。建议将工作目录作为参数传递给工具，而非依赖环境变量。

### 5.3 创新点

1. **Grace 窗口过期处理**：根据调度周期动态计算 grace 窗口（daily=2h, hourly=30m），平衡"及时执行"和"避免爆发"。

2. **作业链 context_from**：声明式依赖注入，上游输出自动作为下游上下文。

3. **ACP 工具映射**：将 Hermes 的丰富工具集映射到 ACP 的标准 ToolKind，使编辑器可以展示一致的工具图标和行为。

4. **MCP 动态注册**：ACP 客户端提供的 MCP 服务器在会话创建时动态注册，无需预配置。

---

## 六、动态发现

### 6.1 Cron 相关文件

| 文件 | 职责 |
|------|------|
| `cron/scheduler.py` | 主调度器实现（1,740行） |
| `cron/jobs.py` | 作业 CRUD、调度计算、输出存储 |
| `tools/cronjob_tools.py` | Cron 工具 API、Prompt 注入扫描 |
| `~/.hermes/cron/jobs.json` | 作业存储 |
| `~/.hermes/cron/output/{job_id}/` | 作业输出目录 |
| `~/.hermes/cron/.tick.lock` | 调度器锁文件 |

### 6.2 ACP 相关文件

| 文件 | 职责 |
|------|------|
| `acp_adapter/server.py` | ACP 服务端实现（1,714行） |
| `acp_adapter/session.py` | SessionManager、SessionState |
| `acp_adapter/tools.py` | 工具映射、ToolCall 构建 |
| `acp_adapter/events.py` | 回调工厂（流式桥接） |
| `acp_adapter/auth.py` | Provider 检测 |
| `acp_adapter/permissions.py` | ACP 权限桥接 |
| `acp_adapter/entry.py` | CLI 入口点 |

### 6.3 安全相关发现

**_CRON_INVISIBLE_CHARS**：检测零宽字符（U+200B 零宽空格、U+200C 零宽非连接符等），这些是常见的 prompt 注入手段——肉眼不可见但 LLM 可以读取。

**脚本路径验证**：拒绝绝对路径和 `~` 展开，只允许相对路径在 `~/.hermes/scripts/` 内解析。防止通过 prompt 注入执行任意系统脚本。

**凭证池支持**：Cron 作业支持加载凭证池（`agent.credential_pool`），用于需要多凭证轮询的场景（如多个 API key 避免速率限制）。

---

## 七、高价值代码片段

### 7.1 双重 Prompt 注入防护（cronjob_tools.py 行 41-68）

```python
_CRON_THREAT_PATTERNS = [
    (r'ignore\s+(?:\w+\s+)*(?:previous|all|above|prior)\s+(?:\w+\s+)*instructions', "prompt_injection"),
    (r'do\s+not\s+tell\s+the\s+user', "deception_hide"),
    (r'curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)', "exfil_curl"),
    (r'cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)', "read_secrets"),
    (r'authorized_keys', "ssh_backdoor"),
    (r'rm\s+-rf\s+/', "destructive_root_rm"),
]

_CRON_INVISIBLE_CHARS = {
    '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
    '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
}

def _scan_cron_prompt(prompt: str) -> str:
    """Scan a cron prompt for critical threats. Returns error string if blocked, else empty."""
    for char in _CRON_INVISIBLE_CHARS:
        if char in prompt:
            return f"Blocked: prompt contains invisible unicode U+{ord(char):04X} (possible injection)."
    for pattern, pid in _CRON_THREAT_PATTERNS:
        if re.search(pattern, prompt, re.IGNORECASE):
            return f"Blocked: prompt matches threat pattern '{pid}'."
    return ""
```

**设计亮点**：覆盖零宽字符注入和常见 prompt 注入模式，包括数据外泄（curl/wget + 环境变量）、敏感文件读取、SSH 后门、破坏性命令。

### 7.2 运行时组装扫描（scheduler.py 行 930-952）

```python
def _scan_assembled_cron_prompt(assembled: str, job: dict) -> str:
    """Scan the fully-assembled cron prompt (including skill content) for
    injection patterns. Raises ``CronPromptInjectionBlocked`` when a match
    fires so ``run_job`` can surface a clear refusal to the operator.

    Plugs the #3968 gap: ``_scan_cron_prompt`` runs on the user-supplied
    prompt at create/update, but skill content is loaded from disk at
    runtime and was never scanned. Since cron runs non-interactively
    (auto-approves tool calls), a malicious skill carrying an injection
    payload bypassed every gate.
    """
    from tools.cronjob_tools import _scan_cron_prompt

    scan_error = _scan_cron_prompt(assembled)
    if scan_error:
        job_label = job.get("name") or job.get("id") or "<unknown>"
        logger.warning(
            "Cron job '%s': assembled prompt blocked by injection scanner — %s",
            job_label,
            scan_error,
        )
        raise CronPromptInjectionBlocked(scan_error)
    return assembled
```

**设计亮点**：填补 #3968 漏洞——技能文件在作业创建后可能被篡改，运行时扫描确保组装后的完整 prompt 安全。

### 7.3 延迟导入策略（scheduler.py 行 1074）

```python
# ---------------------------------------------------------------
# Default (LLM) path — import and construct the agent machinery now
# that we know we actually need it. Doing these imports here instead of
# at module top keeps no_agent ticks from paying for AIAgent / SessionDB
# construction costs.
# ---------------------------------------------------------------
from run_agent import AIAgent
```

**设计亮点**：对于纯脚本的 no_agent 作业，完全跳过 AIAgent 导入，避免不必要的启动开销。

### 7.4 跨平台文件锁（scheduler.py 行 20-28）

```python
# fcntl is Unix-only; on Windows use msvcrt for file locking
try:
    import fcntl
except ImportError:
    fcntl = None
    try:
        import msvcrt
    except ImportError:
        msvcrt = None
```

**设计亮点**：Unix 使用 `fcntl.flock`，Windows 使用 `msvcrt.locking`，确保跨平台兼容性。

### 7.5 ACP 资源链接处理（acp_adapter/server.py 行 211-272）

```python
def _resource_link_to_parts(block: ResourceContentBlock) -> list[dict[str, Any]]:
    """Convert an ACP resource_link block to OpenAI content parts.

    Returns a list of {"type": "text", ...} and/or {"type": "image_url", ...}
    parts. Image resources produce an image_url part with a small text header
    so the model knows which attachment it is.
    """
    uri = str(getattr(block, "uri", "") or "").strip()
    if not uri:
        return []

    # Image files: emit a short text header + image_url data URL
    image_mime = mime_type if _is_image_resource(mime_type) else _guess_image_mime_from_path(path)
    if image_mime and _is_image_resource(image_mime):
        try:
            size = path.stat().st_size
            if size > _MAX_ACP_RESOURCE_BYTES:
                return [{"type": "text", "text": f"[Image too large to inline: {size} bytes]"}]
            with path.open("rb") as fh:
                data = fh.read()
        except OSError as exc:
            return [{"type": "text", "text": f"[Could not read attached image: {exc}]"}]
        return [
            {"type": "text", "text": f"[Attached image: {display}]\nURI: {uri}"},
            {"type": "image_url", "image_url": {"url": _image_data_url(data, image_mime)}},
        ]
```

**设计亮点**：将 ACP 资源链接转换为 OpenAI 兼容的内容格式，支持图像和文本文件，自动处理大小限制和 MIME 类型检测。

---

## 后续步骤建议

本步骤（步骤9）已完成 Cron 调度与 ACP 协议的完整分析。后续可继续：

1. **步骤10**：工具安全护栏与测试架构（`agent/tool_guardrails.py`、`tools/process_registry.py`、`tests/conftest.py`）

2. **交叉引用**：
   - 分析 `tools/path_security.py`（缺失文件）以补充路径安全验证细节
   - 分析 `agent/redact.py`（缺失文件）以补充敏感信息脱敏规则

3. **深度验证**：
   - 运行 `test_cron_prompt_injection_skill.py` 验证 #3968 回归测试
   - 运行 `test_cron_inactivity_timeout.py` 验证不活动超时机制

4. **EvoAgent 应用**：
   - 实现 at-most-once 调度语义
   - 实现双重 Prompt 注入防护
   - 实现 ACP 协议适配层
