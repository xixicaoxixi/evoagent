# 分析_H4_多后端终端沙箱与MCP协议客户端

> **轮次**：第 H 轮 — Hermes-Agent 拆解
> **日期**：2026-05-08
> **阅读量**：~9,700+ 行（base.py 805 + local.py 531 + docker.py 645 + terminal_tool.py 2,342 + mcp_tool.py 3,403 + file_tools.py 片段 + 5 个远程后端）
> **对标文档**：分析_09（终端沙箱）、分析_16（MCP 集成）

---

## 一、核心发现摘要

### 1.1 与 claude-code / openclaw 的对比

| 维度 | claude-code | openclaw | hermes-agent |
|------|-------------|----------|--------------|
| **终端后端数** | 1（本地） | 1（本地） | **7（local/docker/modal/singularity/ssh/daytona/vercel）** |
| **后端抽象** | 无 | 无 | **BaseEnvironment ABC** |
| **容器安全** | 无 | 无 | **cap-drop ALL + no-new-privileges + PID 限制** |
| **CWD 持久化** | 无（每次新 shell） | 无 | **session snapshot + CWD marker** |
| **后台任务** | 无 | 无 | **process_registry + notify_on_complete + watch_patterns** |
| **空闲回收** | 无 | 无 | **后台守护线程 + lifetime_seconds** |
| **MCP 支持** | 无 | 无 | **完整 MCP 客户端（stdio/SSE/HTTP）** |
| **Sampling** | 无 | 无 | **完整 Sampling 回调 + 速率限制** |
| **MCP 断路器** | 无 | 无 | **三级状态机（closed/open/half-open）** |
| **MCP 动态刷新** | 无 | 无 | **notifications/tools/list_changed** |
| **凭证剥离** | 无 | 无 | **正则 + 跨域重定向剥离** |
| **环境变量隔离** | 无 | 无 | **40+ API Key 黑名单 + env_passthrough** |
| **进程组杀死** | 无 | 无 | **SIGTERM→等待→SIGKILL 两阶段** |
| **复合后台重写** | 无 | 无 | **`A && B &` → `A && { B & }`** |
| **退出码语义** | 无 | 无 | **grep=1/diff=1/test=1 等非错误解释** |

### 1.2 核心设计特点

1. **统一 spawn-per-call 模型**：所有后端共享同一个 `execute()` 流程，差异仅在 `_run_bash()` 实现
2. **7 种后端统一接口**：BaseEnvironment ABC 定义了 2 个抽象方法，子类只需实现它们
3. **完整 MCP 客户端**：3 种传输协议 + Sampling + 动态刷新 + 断路器 + OAuth 恢复
4. **多层安全纵深**：环境变量隔离 → 凭证剥离 → 容器加固 → 命令审批 → 文件安全检查
5. **后台任务全生命周期管理**：spawn → poll → notify → auto-reap

---

## 二、模块架构分析

### 2.1 BaseEnvironment ABC 接口

```
BaseEnvironment (ABC)
├── 属性
│   ├── cwd: str                    # 当前工作目录（跨命令持久化）
│   ├── timeout: int                # 默认超时
│   ├── _session_id: str            # 会话唯一标识
│   ├── _snapshot_path: str         # 环境快照文件路径
│   ├── _cwd_file: str              # CWD 文件路径（本地后端）
│   ├── _cwd_marker: str            # CWD 标记（远程后端）
│   ├── _snapshot_ready: bool       # 快照是否就绪
│   ├── _stdin_mode: str            # "pipe" | "heredoc"
│   └── _snapshot_timeout: int      # 快照创建超时
│
├── 抽象方法（子类必须实现）
│   ├── _run_bash(cmd, *, login, timeout, stdin_data) → ProcessHandle
│   └── cleanup()
│
├── 可覆盖钩子
│   ├── get_temp_dir() → str        # 临时目录（Termux 兼容）
│   ├── _kill_process(proc)         # 进程终止方式
│   ├── _update_cwd(result)         # CWD 提取方式
│   └── _before_execute()           # 执行前钩子（文件同步）
│
├── 核心方法（基类提供，所有后端共享）
│   ├── init_session()              # 捕获登录 shell 环境
│   ├── _wrap_command(cmd, cwd)     # 构建完整 bash 脚本
│   ├── _wait_for_process(proc)     # 中断感知的进程等待
│   ├── execute(cmd, cwd, *, timeout, stdin_data) → dict
│   └── stop() / __del__()
│
└── 辅助
    ├── _embed_stdin_heredoc()      # SDK 后端 stdin 嵌入
    ├── _extract_cwd_from_output()  # 远程 CWD 标记解析
    └── _prepare_command()          # sudo 命令变换
```

### 2.2 七种后端对比

| 后端 | _stdin_mode | _run_bash 方式 | 文件同步 | 安全特性 | 持久化 |
|------|-------------|-----------------|----------|----------|--------|
| **Local** | pipe | Popen (os.setsid) | 无（直接访问） | 进程组杀死、env 隔离 | 可选 |
| **Docker** | pipe | Popen (docker exec) | 无（bind mount） | cap-drop ALL、no-new-privileges、PID 限制、tmpfs | bind mount |
| **Singularity** | pipe | Popen (apptainer exec) | 无（bind mount） | --containall、--no-home、capability drop | overlay 目录 |
| **Modal** | heredoc | SDK (_ThreadedProcessHandle) | 有 (sync) | 云沙箱隔离 | snapshot_filesystem |
| **SSH** | pipe | Popen (ssh bash -c) | 有 (SCP/tar) | StrictHostKeyChecking、ControlMaster | 无 |
| **Daytona** | heredoc | SDK (_ThreadedProcessHandle) | 有 (sync + 健康检查) | 云沙箱隔离 | sandbox.stop |
| **Vercel** | heredoc | SDK (_ThreadedProcessHandle) | 有 (sync + 健康检查) | 云沙箱 + 瞬态重试 | snapshot |

### 2.3 统一执行流程

```
execute(command, cwd, *, timeout, stdin_data)
    │
    ├── 1. _before_execute()           # 文件同步（远程后端）
    │
    ├── 2. _prepare_command(command)    # sudo 变换
    │
    ├── 3. _rewrite_compound_background()  # A && B & → A && { B & }
    │
    ├── 4. _wrap_command(cmd, cwd)     # 构建 bash 脚本
    │   ├── source snapshot            # 恢复环境变量
    │   ├── cd -- <cwd>                # 切换工作目录
    │   ├── eval '<command>'           # 执行命令
    │   ├── export -p > snapshot       # 保存环境变量
    │   ├── pwd -P > cwd_file          # 写入 CWD
    │   └── printf CWD_MARKER          # 输出 CWD 标记
    │
    ├── 5. _run_bash(wrapped, ...)     # 子类实现
    │
    ├── 6. _wait_for_process(proc)     # 中断感知等待
    │   ├── select() 非阻塞排水        # 避免后台进程管道泄漏
    │   ├── is_interrupted() 检查      # 用户中断传播
    │   ├── timeout 强制终止            # 超时处理
    │   └── touch_activity_if_due()    # 心跳防不活跃超时
    │
    └── 7. _update_cwd(result)         # 提取 CWD
```

### 2.4 MCP 客户端架构

```
mcp_tool.py (3,403 行)
├── 传输层
│   ├── stdio_client       # 本地子进程
│   ├── streamablehttp_client  # HTTP（新版）
│   ├── streamable_http_client  # HTTP（旧版）
│   └── sse_client          # Server-Sent Events
│
├── 连接管理
│   ├── _ensure_mcp_loop()          # 后台事件循环（单守护线程）
│   ├── MCPServerTask.run()         # 连接 + 保活 + 重连
│   │   ├── 首次连接：3 次重试，指数退避
│   │   ├── 运行时断连：5 次重试，指数退避
│   │   ├── OAuth 401 恢复：1 次重试
│   │   └── 会话过期恢复：1 次重试
│   └── _wait_for_lifecycle_event() # 3 分钟心跳保活
│
├── 工具管理
│   ├── discover_mcp_tools()        # 主入口
│   ├── _register_server_tools()    # 注册到 ToolRegistry
│   ├── _refresh_tools()            # 动态刷新（就地替换）
│   └── sanitize_mcp_name_component()  # 命名空间隔离
│
├── Sampling
│   └── SamplingHandler             # 完整 MCP Sampling 实现
│       ├── 速率限制（滑动窗口）
│       ├── 模型白名单
│       ├── 工具循环上限
│       └── call_llm() 路由
│
├── 安全
│   ├── _CREDENTIAL_PATTERN         # 凭证正则剥离
│   ├── _build_safe_env()           # 环境变量过滤
│   ├── _strip_auth_on_cross_origin_redirect()  # 跨域重定向
│   └── 断路器（三级状态机）
│
└── 全局状态
    ├── _servers: Dict[str, MCPServerTask]
    ├── _mcp_loop: asyncio.AbstractEventLoop
    ├── _mcp_thread: threading.Thread
    ├── _stdio_pids: Dict[int, str]
    └── _lock: threading.Lock
```

---

## 三、关键设计模式

### 3.1 统一 spawn-per-call 模型

**模式名称**：模板方法 + 策略

**应用位置**：`BaseEnvironment.execute()` (base.py 行 739-785)

**设计亮点**：
- 所有后端共享同一个 `execute()` 流程，差异仅在 `_run_bash()` 实现
- `_wrap_command()` 构建统一的 bash 脚本：source snapshot → cd → eval → save snapshot → CWD marker
- `_wait_for_process()` 在基类中实现，所有后端自动获得中断感知和超时处理

### 3.2 Session Snapshot 环境持久化

**模式名称**：快照 + 增量更新

**应用位置**：`init_session()` (base.py 行 330-370) + `_wrap_command()` (行 387-430)

**代码示例**：
```python
# init_session: 捕获登录 shell 环境
bootstrap = (
    f"export -p > {self._snapshot_path}\n"        # 环境变量
    f"declare -f | grep -vE '^_[^_]' >> {self._snapshot_path}\n"  # 函数
    f"alias -p >> {self._snapshot_path}\n"        # 别名
    f"echo 'shopt -s expand_aliases' >> {self._snapshot_path}\n"
    f"echo 'set +e' >> {self._snapshot_path}\n"
    f"echo 'set +u' >> {self._snapshot_path}\n"
    f"builtin cd {_quoted_cwd} 2>/dev/null || true\n"
    f"pwd -P > {self._cwd_file}\n"
)

# _wrap_command: 每次命令后更新快照
if self._snapshot_ready:
    parts.append(f"source {self._snapshot_path} >/dev/null 2>&1 || true")
# ... run command ...
if self._snapshot_ready:
    parts.append(f"export -p > {self._snapshot_path} 2>/dev/null || true")
```

**设计亮点**：
- 每次命令执行后 `export -p` 更新快照，实现环境变量跨命令持久化
- macOS 兼容：`source` 重定向到 `/dev/null` 避免 declare 泄漏（#15459）
- 降级策略：快照创建失败时回退到 `bash -l`（每次加载登录 profile）

### 3.3 非阻塞排水 + 后台进程管道泄漏修复

**模式名称**：select() 轮询 + 空闲退出

**应用位置**：`_wait_for_process()` (base.py 行 446-670)

**设计亮点**：
- 旧模式 `for line in proc.stdout` 阻塞在 `readline()`，后台进程继承管道导致永久挂起（#8340）
- 新模式使用 `select()` + 0.1s 轮询，bash 退出后 3 个空闲周期（~300ms）即停止排水
- 增量 UTF-8 解码器处理多字节字符跨 chunk 的情况
- Windows 兼容：`os.name == "nt"` 时回退到阻塞 `os.read()`

### 3.4 MCP 断路器

**模式名称**：三级状态机

**应用位置**：mcp_tool.py 行 1608-1652

```
closed ──(连续失败 >= 3)──→ open ──(冷却 60s)──→ half-open
  ↑                                                    │
  └────────────(探测成功)──────────────────────────────┘
                                │
                        (探测失败)→ open
```

**设计亮点**：
- 防止模型对不可达 MCP 服务器进行 90 次无效重试（#10447）
- half-open 状态的探测调用使用正常工具调用，对模型透明
- 冷却期 60 秒后自动进入 half-open

### 3.5 MCP Sampling 完整实现

**模式名称**：LLM 代理 + 速率限制 + 工具循环治理

**应用位置**：`SamplingHandler` (mcp_tool.py 行 566-931)

**设计亮点**：
- 完整实现 MCP `sampling/createMessage` 规范
- 支持文本和工具调用两种响应类型
- 滑动窗口速率限制（60 秒内最多 N 次）
- 工具循环上限防止无限调用
- 模型白名单限制 MCP 服务器可请求的 LLM
- 使用 `asyncio.to_thread()` 卸载 LLM 调用避免阻塞事件循环

### 3.6 复合后台命令重写

**模式名称**：AST 感知的命令重写

**应用位置**：`_rewrite_compound_background()` (terminal_tool.py 行 649-811)

**问题**：`A && B &` 被 bash 解析为 `(A && B) &`（子 shell 后台），当 B 是长进程时子 shell 永不退出

**解决方案**：重写为 `A && { B & }`（花括号组，无子 shell）

```python
# 输入:  npm run build && python -m http.server 8080 &
# 输出:  npm run build && { python -m http.server 8080 & }
```

**设计亮点**：
- 完整的 shell 解析器：处理引号、转义、注释、子 shell、花括号组
- 幂等：已重写的命令不会二次修改
- 深度 0 仅：不修改子 shell 内部的 `&`

---

## 四、与已拆解项目的对比

### 4.1 七层安全防线

```
第 1 层：环境变量隔离（local.py）
  ├── 40+ API Key 黑名单
  ├── env_passthrough 白名单
  └── Per-profile HOME 隔离

第 2 层：容器加固（docker.py）
  ├── cap-drop ALL + 精细 cap-add
  ├── no-new-privileges
  ├── PID 限制（256）
  ├── tmpfs 大小限制
  └── 可选 --user 运行

第 3 层：命令审批（approval.py，步骤3已分析）
  ├── Hardline 无条件阻止
  ├── Dangerous 模式检测
  └── Smart Approval LLM 评估

第 4 层：凭证剥离（mcp_tool.py）
  ├── 正则剥离错误信息中的凭证
  ├── 跨域重定向 Authorization 头剥离
  └── stdio 子进程安全环境变量

第 5 层：文件安全（file_tools.py）
  ├── 设备路径黑名单（/dev/zero 等）
  ├── 二进制扩展名检测
  ├── 读取大小限制（100K 字符）
  └── redact_sensitive_text 脱敏

第 6 层：进程管理（base.py）
  ├── 进程组杀死（SIGTERM → SIGKILL）
  ├── 超时强制终止
  └── 中断信号传播

第 7 层：MCP 专用安全
  ├── Sampling 模型白名单
  ├── Sampling 工具循环上限
  ├── Prompt 注入扫描
  └── OSV 恶意软件检查
```

### 4.2 Docker 安全加固细节

```python
_BASE_SECURITY_ARGS = [
    "--cap-drop", "ALL",              # 丢弃所有能力
    "--cap-add", "DAC_OVERRIDE",     # root 可写 bind mount
    "--cap-add", "CHOWN",            # 包管理器需要
    "--cap-add", "FOWNER",           # 包管理器需要
    "--security-opt", "no-new-privileges",  # 禁止提权
    "--pids-limit", "256",           # 限制进程数
    "--tmpfs", "/tmp:rw,nosuid,size=512m",
    "--tmpfs", "/var/tmp:rw,noexec,nosuid,size=256m",
    "--tmpfs", "/run:rw,noexec,nosuid,size=64m",
]
```

**设计亮点**：
- 仅添加最小必要能力（DAC_OVERRIDE/CHOWN/FOWNER）
- gosu 场景额外添加 SETUID/SETGID，但 `no-new-privileges` 阻止回提权
- tmpfs 分区禁止 setuid 和执行（/var/tmp, /run），/tmp 允许执行（pip/npm 构建）

---

## 五、对 EvoAgent 的参考价值

### 5.1 可直接借鉴的设计

#### 5.1.1 BaseEnvironment ABC

**移植建议**：定义 TypeScript 接口

```typescript
interface ExecutionBackend {
  readonly cwd: string;
  readonly stdinMode: "pipe" | "heredoc";
  
  // 核心
  runBash(cmd: string, options: BashOptions): ProcessHandle;
  cleanup(): Promise<void>;
  
  // 可覆盖
  beforeExecute?(): Promise<void>;
  killProcess?(handle: ProcessHandle): void;
}
```

#### 5.1.2 MCP 断路器

**移植建议**：直接移植三级状态机

```typescript
class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private failureCount = 0;
  private openedAt = 0;
  
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.openedAt < 60_000) throw new Error("Server unreachable");
      this.state = "half-open";
    }
    try {
      const result = await fn();
      this.failureCount = 0;
      this.state = "closed";
      return result;
    } catch {
      if (++this.failureCount >= 3) {
        this.state = "open";
        this.openedAt = Date.now();
      }
      throw new Error("Server unreachable");
    }
  }
}
```

#### 5.1.3 复合后台命令重写

**移植建议**：使用 shell 解析库或移植 AST 感知重写

#### 5.1.4 退出码语义解释

**移植建议**：直接移植 `_interpret_exit_code()` 的语义表

### 5.2 需要评估的设计

#### 5.2.1 后台事件循环

**问题**：Python 的 `asyncio` + `threading` 混合模式复杂

**建议**：TypeScript 原生 async/await 更简洁

#### 5.2.2 Session Snapshot

**问题**：bash 快照在 Windows 上不可用

**建议**：评估是否需要跨命令环境持久化

### 5.3 不建议移植的设计

#### 5.3.1 全局环境状态

**问题**：`_active_environments`、`_servers` 等模块级全局变量

**建议**：使用依赖注入

#### 5.3.2 同步阻塞等待

**问题**：`threading.Event.wait()` 在网关场景下阻塞线程

**建议**：TypeScript 原生 Promise 更简洁

---

## 六、动态发现

### 6.1 未在规划文档中预判的高价值内容

#### 6.1.1 _ThreadedProcessHandle 适配器

**位置**：base.py 行 184-250

**发现**：将 SDK 后端（Modal、Daytona、Vercel）的阻塞调用适配为 ProcessHandle 接口

**价值**：统一的 ProcessHandle 协议让 `_wait_for_process()` 对所有后端透明

#### 6.1.2 Sudo 密码会话隔离缓存

**位置**：terminal_tool.py 行 265-310

**发现**：sudo 密码缓存按 session_key → callback → thread 三级回退隔离

**价值**：防止一个会话的 sudo 密码被另一个会话复用

#### 6.1.3 前台/后台引导系统

**位置**：terminal_tool.py 行 1542-1598

**发现**：检测长生命进程模式（npm run dev、docker compose up 等）并建议使用后台模式

**价值**：减少模型因前台启动服务器而卡住的失败模式

#### 6.1.4 MCP 就地工具替换

**位置**：mcp_tool.py 行 1076-1079

**发现**：动态刷新时采用就地更新而非清除重建，避免正在进行的 agent 回话中的工具调用 ID 失效

**价值**：这是从生产 bug 中提炼的设计，确保刷新不影响进行中的对话

#### 6.1.5 RPC 序列化锁

**位置**：mcp_tool.py 行 976-982

**发现**：每个 MCP 服务器一个 `_rpc_lock`，防止 stdio JSON-RPC 流上的请求竞争

**价值**：解决 list_changed 通知处理期间工具调用超时的问题

#### 6.1.6 OSV 恶意软件检查

**位置**：mcp_tool.py 行 1194-1200

**发现**：启动 stdio 子进程前检查包是否在 OSV 恶意软件数据库中

**价值**：防止恶意 MCP 服务器执行任意代码

### 6.2 潜在的反模式警示

#### 6.2.1 terminal_tool.py 2,342 行

**问题**：单文件职责过多（环境管理 + 命令执行 + 后台任务 + sudo + 审批集成）

**建议**：拆分为 terminal_env.py（环境管理）、terminal_exec.py（命令执行）、terminal_background.py（后台任务）

#### 6.2.2 mcp_tool.py 3,403 行

**问题**：单文件包含连接管理、工具注册、Sampling、安全、OAuth 等所有 MCP 逻辑

**建议**：拆分为 mcp_transport.py、mcp_registry.py、mcp_sampling.py、mcp_security.py

---

## 七、高价值代码片段

### 7.1 进程组杀死（两阶段）

**位置**：local.py 行 436-504

```python
def _kill_process(self, proc):
    # Phase 1: SIGTERM
    os.killpg(pgid, signal.SIGTERM)
    if _wait_for_group_exit(pgid, 1.0):
        return
    # Phase 2: SIGKILL
    os.killpg(pgid, signal.SIGKILL)
    _wait_for_group_exit(pgid, 2.0)
```

### 7.2 MCP 凭证剥离正则

**位置**：mcp_tool.py 行 268-280

```python
_CREDENTIAL_PATTERN = re.compile(
    r"(?:"
    r"ghp_[A-Za-z0-9_]{1,255}"           # GitHub PAT
    r"|sk-[A-Za-z0-9_]{1,255}"            # OpenAI-style key
    r"|Bearer\s+\S+"                        # Bearer token
    r"|(?:token|key|API_KEY|password|secret)\s*=\s*\S+"
    r")",
    re.IGNORECASE,
)
```

### 7.3 设备路径黑名单

**位置**：file_tools.py 行 69-78

```python
_BLOCKED_DEVICE_PATHS = frozenset({
    "/dev/zero", "/dev/random", "/dev/urandom", "/dev/full",  # 无限输出
    "/dev/stdin", "/dev/tty", "/dev/console",                   # 阻塞等待
    "/dev/stdout", "/dev/stderr",                               # 无意义
    "/dev/fd/0", "/dev/fd/1", "/dev/fd/2",                     # fd 别名
})
```

---

## 八、总结

### 8.1 核心收获

1. **BaseEnvironment ABC 是最完善的终端后端抽象**：7 种后端统一接口，差异仅在 `_run_bash()`
2. **Session Snapshot 实现了跨命令环境持久化**：每次命令后 `export -p` 更新快照
3. **非阻塞排水修复了后台进程管道泄漏**：select() + 空闲退出替代阻塞 readline
4. **MCP 客户端是生产级实现**：3 种传输 + Sampling + 断路器 + 动态刷新 + OAuth 恢复
5. **七层安全纵深**：从环境变量隔离到 MCP 专用安全，层层递进
6. **复合后台命令重写解决了 shell 语义陷阱**：`A && B &` → `A && { B & }`

### 8.2 对 EvoAgent 的建议

1. **采纳 BaseEnvironment ABC**：定义统一的执行后端接口
2. **采纳 MCP 断路器**：防止对不可达服务器的无效重试
3. **采纳退出码语义解释**：减少模型对非错误退出码的误判
4. **采纳凭证剥离正则**：防止 API Key 泄露到模型上下文
5. **改进文件组织**：将 2,000+ 行的单文件拆分为多个专注模块
6. **改进全局状态**：使用依赖注入替代模块级全局变量

### 8.3 后续步骤建议

- 步骤 5：分析 `gateway/` 的多平台适配层
- 步骤 6：分析 `agent/memory_manager.py` + `agent/memory_provider.py` 的记忆系统
