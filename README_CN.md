# EvoAgent TS

[English](README.md)

基于 TypeScript + Bun 的自进化多智能体系统。Agent 从任务结果中学习——生成、验证、淘汰进化规则，持续优化自身行为。

> ⚠️ **开发中** — 本项目仍在活跃开发阶段，部分模块已实现但尚未接入主闭环，详见[模块状态](#模块状态)。欢迎贡献和讨论。

## 核心亮点

- **自进化**: 错误驱动的规则生成，完整生命周期（sandbox → probation → active → deprecated）。规则源于失败，在不再有效时被淘汰。
- **元进化**: 系统可以调整自身参数——评估权重、晋升阈值、探索策略——由宪法层守护，防止不安全修改。
- **P2P 知识共享**: 实例间通过 HTTP 通信，以 Ed25519 签名消息、Web of Trust 共识和异常检测共享进化规则与知识。
- **零第三方 SDK**: 运行时唯一依赖是 `zod`。所有 LLM 调用使用原生 `fetch`——无 OpenAI/Anthropic SDK，无厂商锁定。

## 快速开始

### 环境要求

- [Bun](https://bun.sh/) 运行时
- 至少一个 LLM Provider API Key（或通过 HTTP/Web UI 配置）

### 安装与运行

```bash
bun install
bun run src/cli.ts help
bun run src/cli.ts server --port=3000
bun run src/cli.ts mcp --transport=http --port=3001 --host=127.0.0.1
```

### 库模式使用

```typescript
import { createEvoAgent } from "evoagent-ts";

const agent = await createEvoAgent();
const response = await agent.chat("分析这个错误日志");
const complex = await agent.chatComplex("构建 REST API", ["设计数据模型", "实现路由"]);
```

### MCP 集成

**Streamable HTTP**（推荐）:

```json
{
  "mcpServers": {
    "evoagent": {
      "url": "http://127.0.0.1:3001/mcp"
    }
  }
}
```

**stdio**:

```json
{
  "mcpServers": {
    "evoagent": {
      "command": "bun",
      "args": ["run", "src/cli.ts", "mcp", "--transport=stdio"]
    }
  }
}
```

### MCP 工具

| 工具 | 需要 Provider | 说明 |
|------|----------------|------|
| `bash` | 否 | 执行 Shell 命令 |
| `file_read` | 否 | 读取文件内容 |
| `file_write` | 否 | 写入文件 |
| `file_edit` | 否 | 搜索替换编辑文件 |
| `glob` | 否 | 文件模式匹配搜索 |
| `chat` | 是 | 与 LLM 对话 |
| `chat_complex` | 是 | 多 Agent 编排复杂任务 |
| `evolution_status` | 是 | 查看进化规则与状态 |
| `observability_status` | 是 | 查看统计、成本、进度 |
| `community_status` | 是 | 查看社区治理与市场 |

## 架构

```
用户入口
  ├── CLI (cli.ts) ──── server / mcp / all
  ├── 库入口 (index.ts) ──── createEvoAgent() → chat / chatComplex
  └── MCP (mcp-entry.ts) ──── stdio / HTTP 传输

核心循环
  ├── EvoAgentContext ──── 统一上下文容器
  │     ├── QueryEngine ──── 单 Agent 对话循环
  │     ├── Orchestrator ──── 多 Agent 任务编排
  │     ├── EvolutionEngine ──── 规则生命周期管理
  │     ├── KnowledgeManager ──── 知识检索与存储
  │     ├── Communication ──── P2P 网关 / 批判分析 / 共识
  │     └── Observability ──── 日志 / 统计 / 成本 / 进度
  │
  └── agentQueryLoop ──── async generator 驱动的 Agentic Loop
        ├── 上下文组装 → LLM 流式调用 → 工具执行 → 循环控制
        ├── 工具发现 + 权限链 + 拒绝计数
        ├── PII 净化 + LLM 输出净化
        └── 错误隔离（错误即数据范式）

对外接口
  ├── HTTP Server ──── 10 组路由 + Web UI
  └── MCP Server ──── 10 个工具 + 2 个资源
```

## 模块状态

| 模块 | 状态 | 说明 |
|------|------|------|
| **core/query** | ✅ 已接入主闭环 | Agentic Loop、流式响应、工具调用 |
| **core/agent** | ✅ 已接入主闭环 | Orchestrator、SubAgent、TaskPlanner |
| **evolution** | ✅ 已接入主闭环 | 完整规则生命周期、元进化 |
| **communication** | ✅ 已接入主闭环 | P2P、共识、声誉、市场 |
| **observability** | ✅ 已接入主闭环 | 日志、统计、成本追踪、PII 净化 |
| **mcp** | ✅ 已接入主闭环 | stdio + HTTP 传输、断路器 |
| **server** | ✅ 已接入主闭环 | HTTP Server、Web UI、全部路由组 |
| **llm** | ✅ 已接入主闭环 | OpenAI/Anthropic/Ollama/Mock Provider |
| **tools** | ✅ 已接入主闭环 | Bash、File、Security 工具 + Zod 验证 |
| **security** | ✅ 已接入主闭环 | 硬编码密钥检测、LLM 净化、截断 |
| **persistence** | ✅ 已接入主闭环 | 原子写入、JSONL、快照 |
| **knowledge** | ⚠️ 部分接入 | 记忆抽取已接入主循环；向量存储/梦境/遗忘未接入 |
| **plugins** | 🔧 仅测试覆盖 | 插件/Hook/Skill 体系已测试但未装配主链 |
| **sandbox** | 🔧 仅扩展能力 | SubprocessSandbox 已实现但工具执行链未使用 |

## Provider 配置

Provider 配置遵循统一优先级链：

1. `runtime_override` — 显式 API 参数
2. `persisted_config` — 通过 HTTP API 保存
3. `env_auto_detected` — 环境变量自动检测

支持的环境变量：

| Provider | API Key | Base URL |
|----------|---------|----------|
| OpenAI | `OPENAI_API_KEY` | `LLM_BASE_URL` |
| Anthropic | `ANTHROPIC_API_KEY` | `LLM_BASE_URL` |
| Ollama | — | `OLLAMA_BASE_URL` |
| DeepSeek | `DEEPSEEK_API_KEY` | `LLM_BASE_URL` |
| Kimi | `KIMI_API_KEY` | `LLM_BASE_URL` |
| GLM | `GLM_API_KEY` | `LLM_BASE_URL` |

通过 API 配置：

```bash
curl -X POST http://localhost:3000/api/v1/config/provider \
  -H "Content-Type: application/json" \
  -d '{"provider_type": "openai", "api_key": "sk-xxx", "model": "gpt-4o"}'
```

## 开发

```bash
bun install
bun test          # 运行测试
bun run check     # TypeScript 类型检查
bun run build     # 编译到 dist/
```

## 安全

本项目重视安全：

- **CI 流水线**: Semgrep SAST、依赖审计、gitleaks 密钥扫描、TypeScript 类型检查、构建审计
- **自定义 Semgrep 规则**: 4 条规则覆盖硬编码密钥、外部引用、eval 禁用、敏感日志
- **自定义 Gitleaks 规则**: 9 条模式覆盖 OpenAI/Anthropic/DeepSeek/Kimi/GLM/AWS/GitHub/Slack/JWT 密钥
- **发布审计**: 8 项预发布审计脚本
- **运行时**: PII 净化、LLM 输出净化、工具权限链、循环检测

## 设计原则

- **类型安全优先**: `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- **Fail-Closed 默认值**: 不确定时选择更安全的选项
- **接口 + 注册表**: 先定义接口，通过注册表发现实现
- **策略模式优于条件分支**: 注册表 + 优先级排序替代 if-else 链
- **错误即数据**: 工具错误不终止循环——它们成为进化的信号
