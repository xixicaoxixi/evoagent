# EvoAgent TS

[中文文档](README_CN.md)

A self-evolving multi-agent system built with TypeScript + Bun. Agents learn from task outcomes — generating, validating, and retiring evolution rules to continuously improve their own behavior.

> ⚠️ **Work in Progress** — This project is under active development. Many modules are implemented but not yet wired into the main loop. See [Module Status](#module-status) for details. Contributions and ideas welcome.

## What Makes It Different

- **Self-Evolution**: Error-driven rule generation with full lifecycle (sandbox → probation → active → deprecated). Rules are born from failures and retired when they stop helping.
- **Meta-Evolution**: The system can tune its own parameters — evaluation weights, promotion thresholds, exploration strategies — guarded by a constitutional layer that prevents unsafe modifications.
- **P2P Knowledge Sharing**: Instances communicate via HTTP, sharing evolution rules and knowledge through Ed25519-signed messages, Web-of-Trust consensus, and anomaly detection.
- **Zero Third-Party SDKs**: Only runtime dependency is `zod`. All LLM calls use native `fetch` — no OpenAI/Anthropic SDK, no vendor lock-in.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) runtime
- At least one LLM provider API key (or configure via HTTP/Web UI)

### Install & Run

```bash
bun install
bun run src/cli.ts help
bun run src/cli.ts server --port=3000
bun run src/cli.ts mcp --transport=http --port=3001 --host=127.0.0.1
```

### Library Usage

```typescript
import { createEvoAgent } from "evoagent-ts";

const agent = await createEvoAgent();
const response = await agent.chat("Analyze this error log");
const complex = await agent.chatComplex("Build a REST API", ["design schema", "implement routes"]);
```

### MCP Integration

**Streamable HTTP** (recommended):

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

### MCP Tools

| Tool | Requires Provider | Description |
|------|-------------------|-------------|
| `bash` | No | Execute shell commands |
| `file_read` | No | Read file contents |
| `file_write` | No | Write files |
| `file_edit` | No | Search-and-replace file editing |
| `glob` | No | File pattern matching |
| `chat` | Yes | Chat with LLM |
| `chat_complex` | Yes | Multi-agent orchestration for complex tasks |
| `evolution_status` | Yes | View evolution rules and status |
| `observability_status` | Yes | View stats, costs, progress |
| `community_status` | Yes | View community governance and marketplace |

## Architecture

```
User Entry
  ├── CLI (cli.ts) ──── server / mcp / all
  ├── Library (index.ts) ──── createEvoAgent() → chat / chatComplex
  └── MCP (mcp-entry.ts) ──── stdio / HTTP transport

Core Loop
  ├── EvoAgentContext ──── unified context container
  │     ├── QueryEngine ──── single-agent agentic loop
  │     ├── Orchestrator ──── multi-agent task orchestration
  │     ├── EvolutionEngine ──── rule lifecycle management
  │     ├── KnowledgeManager ──── knowledge retrieval & storage
  │     ├── Communication ──── P2P gateway / critic / consensus
  │     └── Observability ──── logger / stats / cost / progress
  │
  └── agentQueryLoop ──── async generator agentic loop
        ├── Context assembly → LLM streaming → Tool execution → Loop control
        ├── Tool discovery + permission chain + rejection counter
        ├── PII sanitization + LLM output sanitization
        └── Error isolation (errors-as-data pattern)

External Interfaces
  ├── HTTP Server ──── 10 route groups + Web UI
  └── MCP Server ──── 10 tools + 2 resources
```

## Module Status

| Module | Status | Notes |
|--------|--------|-------|
| **core/query** | ✅ Mainline | Agentic loop, streaming, tool calling |
| **core/agent** | ✅ Mainline | Orchestrator, SubAgent, TaskPlanner |
| **evolution** | ✅ Mainline | Full rule lifecycle, meta-evolution |
| **communication** | ✅ Mainline | P2P, consensus, reputation, marketplace |
| **observability** | ✅ Mainline | Logger, stats, cost tracking, PII sanitization |
| **mcp** | ✅ Mainline | stdio + HTTP transport, circuit breaker |
| **server** | ✅ Mainline | HTTP server, Web UI, all route groups |
| **llm** | ✅ Mainline | OpenAI/Anthropic/Ollama/Mock providers |
| **tools** | ✅ Mainline | Bash, File, Security tools with Zod validation |
| **security** | ✅ Mainline | Hardcoded key detection, LLM sanitization, truncation |
| **persistence** | ✅ Mainline | Atomic write, JSONL, snapshots |
| **knowledge** | ⚠️ Partial | Memory extractor in main loop; vector-store/dreaming/forgetting not wired |
| **plugins** | 🔧 Test-only | Plugin/Hook/Skill system tested but not assembled in main loop |
| **sandbox** | 🔧 Extension | SubprocessSandbox implemented but not used by tool execution |

## Provider Configuration

Provider config follows a unified priority chain:

1. `runtime_override` — explicit API parameters
2. `persisted_config` — saved via HTTP API
3. `env_auto_detected` — auto-detected from environment variables

Supported environment variables:

| Provider | API Key | Base URL |
|----------|---------|----------|
| OpenAI | `OPENAI_API_KEY` | `LLM_BASE_URL` |
| Anthropic | `ANTHROPIC_API_KEY` | `LLM_BASE_URL` |
| Ollama | — | `OLLAMA_BASE_URL` |
| DeepSeek | `DEEPSEEK_API_KEY` | `LLM_BASE_URL` |
| Kimi | `KIMI_API_KEY` | `LLM_BASE_URL` |
| GLM | `GLM_API_KEY` | `LLM_BASE_URL` |

Configure via API:

```bash
curl -X POST http://localhost:3000/api/v1/config/provider \
  -H "Content-Type: application/json" \
  -d '{"provider_type": "openai", "api_key": "sk-xxx", "model": "gpt-4o"}'
```

## Development

```bash
bun install
bun test          # Run test suite
bun run check     # TypeScript type check
bun run build     # Compile to dist/
```

## Security

This project takes security seriously:

- **CI Pipeline**: Semgrep SAST, npm audit, gitleaks secret scanning, TypeScript type check, build audit
- **Custom Semgrep Rules**: 4 rules for hardcoded keys, external references, eval prevention, sensitive logging
- **Custom Gitleaks Rules**: 9 patterns covering OpenAI/Anthropic/DeepSeek/Kimi/GLM/AWS/GitHub/Slack/JWT keys
- **Pack Audit**: 8-item pre-publish audit script
- **Runtime**: PII sanitization, LLM output sanitization, tool permission chains, loop detection

## Design Principles

- **Type-safe first**: `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- **Fail-closed defaults**: When uncertain, choose the safer option
- **Interface + Registry**: Define interfaces, discover implementations via registries
- **Strategy over branching**: Registry + priority sorting instead of if-else chains
- **Errors as data**: Tool errors don't terminate the loop — they become signals for evolution
