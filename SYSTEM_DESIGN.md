# EvoAgent System Design

> Developer-facing system design reference. Based on the actual TypeScript + Bun implementation, not the Python prototype.

---

## 1. System Overview

### 1.1 Project Positioning

EvoAgent is a **distributed self-evolving multi-agent system**. The system executes tasks through an Agentic Loop and automatically evolves based on task outcomes — generating, validating, and retiring evolution rules to continuously optimize its own behavior. The system supports multi-instance P2P communication, where instances can share evolution rules and knowledge, and establish trust networks through consensus mechanisms.

### 1.2 Core Features

| Feature | Description |
|---------|-------------|
| **Self-Evolution** | Error-driven rule generation with full lifecycle (sandbox → probation → active → deprecated) |
| **Agentic Loop** | async generator-driven tool-calling loop with streaming, tool discovery, permission chains, and error isolation |
| **Multi-layer System Prompt** | Core (immutable) + Evolutionary (evolvable) + Tunable (temporary) three-tier anchor architecture |
| **Meta-Evolution** | Constitutional guard, strategy exploration, cross-instance second-order communication, engine parameter self-optimization |
| **P2P Network** | Inter-instance HTTP communication, Ed25519/Web Crypto signature verification, Web of Trust consensus |
| **Community Governance** | Reputation system, tier hierarchy, governance proposal voting, instance marketplace |
| **Anomaly Detection** | Four-dimensional detection (frequency, malicious patterns, rejection rate, trust drop), sliding window counting |
| **Knowledge Management** | Keyword + vector hybrid retrieval, active forgetting, source weighting, context-aware |
| **Multi-LLM Support** | OpenAI/Anthropic/Ollama/Mock providers + DeepSeek/Kimi/GLM auto-detection, unified abstract interface |

### 1.3 Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Language | TypeScript (`strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`) |
| HTTP Server | Bun native `Bun.serve()` |
| Data Persistence | JSONL + atomic write (no database dependency) |
| LLM Interface | Native `fetch` (no third-party SDK) |
| Cryptographic Signing | Web Crypto API (Ed25519 + HMAC-SHA256 fallback) |
| Schema Validation | Zod |
| MCP Integration | Self-implemented Streamable HTTP / stdio transport |
| Runtime Dependencies | Only `zod` (zero third-party SDKs) |

---

## 2. System Architecture

### 2.1 Five-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       User Interface Layer                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │
│  │ Web UI   │  │ REST API │  │ MCP Server│                     │
│  └──────────┘  └──────────┘  └──────────┘                     │
├─────────────────────────────────────────────────────────────────┤
│                        Orchestration Layer                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Orchestrator                          │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │  │
│  │  │ TaskPlanner  │  │ AgentFactory │  │ KnowledgeMgr  │  │  │
│  │  └─────────────┘  └──────────────┘  └───────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                        Execution Layer                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                  agentQueryLoop                          │  │
│  │  Context → LLM Stream → Tool Execution → Loop Control   │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                        Evolution Layer                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                  EvolutionEngine                          │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │  │
│  │  │CodeSandbox│ │ ABJudge  │ │ToolGen   │ │MetaEvolution│ │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                      Communication Layer                        │
│  ┌────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ ┌────────┐  │
│  │Gateway │ │   P2P    │ │Identity  │ │Consensus│ │Anomaly │  │
│  └────────┘ └──────────┘ └──────────┘ └────────┘ └────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │Marketplace│ │Community │ │Analytics │ │    Critic        │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                     Infrastructure Layer                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │AtomicWrite│ │Provider  │ │  Store   │ │  LLM Providers  │  │
│  │  + JSONL  │ │  Config  │ │ (JSONL)  │ │  (fetch-based)  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Module Dependencies

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

### 2.3 Data Flow

```
User Input
  │
  ▼
EvoAgentContext.chat() / chatComplex()
  │
  ├── chat → QueryEngine → agentQueryLoop
  │              │
  │         Agentic Loop:
  │         1. Context assembly (System Prompt + history + knowledge injection)
  │         2. LLM streaming call (provider.stream())
  │         3. Tool call detection + execution (ToolExecutor)
  │         4. Loop control (max steps / budget / completion)
  │         5. PII sanitization + LLM output sanitization
  │              │
  ├── chatComplex → Orchestrator
  │     │
  │     TaskPlanner.plan() ───→ ExecutionPlan
  │     │                        │
  │     ▼                        ▼
  │     AgentFactory.create() ──→ SubAgent (each runs agentQueryLoop)
  │     │                        │
  │     ▼                        ▼
  │     Result collection ◄──── Execution results
  │
  ▼
EvolutionEngine.onTaskCompleted()
  ├── Update task statistics
  ├── Record E0 baseline
  ├── Increment trigger budget
  ├── Periodic lifecycle management
  ├── Knowledge exploration / active forgetting
  ├── Tool generation / A/B testing
  ├── Strategy exploration / engine self-optimization
  └── Communication unlock check
```

---

## 3. Core Module Design

### 3.1 EvoAgentContext (Unified Context Container)

**Responsibility**: Unified entry point integrating all modules, used by both `createEvoAgent()` and CLI/MCP entry points.

**Location**: `src/integration/context.ts`

**Initialized components**:
- `ProviderConfigStore` — Provider configuration store (with auto-detection)
- `QueryEngine` — Single-agent chat engine
- `Orchestrator` — Multi-agent orchestrator
- `EvolutionEngine` — Evolution engine
- `KnowledgeManager` — Knowledge manager
- `CommunicationGateway` — Communication gateway
- `Observability` layer — Logger / StatsStore / CostTracker / Progress

**Core methods**:
```typescript
chat(message: string): Promise<{ response: string }>
chatComplex(message: string, subTasks?: string[]): Promise<{ response: string }>
```

### 3.2 agentQueryLoop (Agentic Loop Core)

**Responsibility**: async generator-driven tool-calling loop, the foundation of all agent execution.

**Location**: `src/core/query/loop.ts`

**Loop flow**:
1. Context assembly (System Prompt + conversation history + knowledge injection)
2. LLM streaming call (`provider.stream()`)
3. Tool call detection (extract tool_calls from LLM output)
4. Tool execution (ToolExecutor + permission chain + rejection counter)
5. Result injection into conversation history
6. Loop control (max steps / token budget / completion signal detection)

**Key features**:
- **Error isolation**: Tool errors returned as data, do not terminate the loop
- **PII sanitization**: Output undergoes PII detection and redaction
- **LLM sanitization**: Detects unexecuted tool-call text in LLM output
- **Streaming support**: Uses `async function*` + `yield` for streaming responses

### 3.3 Orchestrator (Main Orchestrator)

**Responsibility**: Multi-agent orchestration, managing sub-agent lifecycles, driving the evolution engine.

**Location**: `src/core/agent/orchestrator.ts`

**Core flow**:
1. Task planning: `TaskPlanner.plan()` generates `ExecutionPlan`
2. Topological sort dependency resolution
3. Parallel execution of ready tasks (dependencies satisfied)
4. Input reference resolution: `$task_001.output` format
5. Each task in independent try/catch, single-task failure does not affect others
6. Evolution check: `EvolutionEngine.onTaskCompleted()`

**Aggregation strategy**: `AggregationStrategy` enum controls result merging.

### 3.4 TaskPlanner + AgentFactory

**Location**: `src/core/agent/task-planner.ts`, `src/core/agent/sub-agent.ts`

**TaskPlanner**:
- With LLM → LLM planning (generates 2~10 sub-tasks with dependencies)
- Without LLM → Simple fallback (fixed 2-task template)
- Planning phase references evolution rules

**SubAgent**:
- Each SubAgent runs an independent `agentQueryLoop`
- Supports automatic tool selection (by task type)
- Concurrency control: global limit + per-type limit

### 3.5 EvolutionEngine (Evolution Engine)

**Location**: `src/evolution/engine.ts`

**Rule data model** (`EvolutionRule`):

| Field | Type | Description |
|-------|------|-------------|
| `ruleId` | `string` | Rule ID |
| `createdAt` | `string` | Creation time |
| `sourceErrorId` | `string` | Source error ID |
| `triggerPattern` | `string` | Trigger condition |
| `action` | `string` | Action (one of 16 valid actions) |
| `priority` | `number` | Priority (0-1) |
| `status` | `RuleStatus` | Lifecycle status |
| `activationCount` | `number` | Activation count |
| `successCount` | `number` | Success count |
| `successRate` | `number` | Success rate |
| `sandboxTrials` | `number` | Sandbox trial count |
| `variance` | `number` | Rule variance |
| `scopeTag` | `string` | Scope tag |

**16 Valid Actions**:

| Action | Description |
|--------|-------------|
| `RETRY_WITH_HIGHER_TIMEOUT` | Retry with higher timeout |
| `ADD_VALIDATION_STEP` | Add validation step |
| `REDUCE_SCOPE` | Reduce task scope |
| `SPLIT_SUBTASK` | Split subtask |
| `ADD_KNOWLEDGE_RETRIEVAL` | Add knowledge retrieval |
| `ADD_ERROR_HANDLING` | Add error handling |
| `IMPROVE_PROMPT_CLARITY` | Improve prompt clarity |
| `ADD_FALLBACK_STRATEGY` | Add fallback strategy |
| `SAMPLE_BEFORE_PROCESS` | Sample before processing |
| `INCREASE_TOKEN_BUDGET` | Increase token budget |
| `DECREASE_TOKEN_BUDGET` | Decrease token budget |
| `CHANGE_TOOL_SELECTION` | Change tool selection |
| `ADD_RETRY_LOGIC` | Add retry logic |
| `SKIP_OPTIONAL_STEP` | Skip optional step |
| `REORDER_EXECUTION` | Reorder execution |
| `ADVISORY_ONLY` | Advisory only, no execution |

**Main evolution flow** (`analyzeAndEvolve`):
1. Check trigger budget
2. With LLM → LLM analysis; without LLM → rule matching
3. Conflict detection
4. Sandbox capacity check
5. Select path based on config: approval queue / sandbox trial / direct activation

**Lifecycle management** (`onTaskCompleted`):
1. Update task statistics
2. Record E0 baseline
3. Increment trigger budget
4. Periodically run `lifecycleManagement()`
5. Knowledge exploration / active forgetting
6. Tool generation / A/B testing
7. Strategy exploration / engine self-optimization

### 3.6 MetaEvolution

**Location**: `src/evolution/`

#### ConstitutionalGuard

Ensures no modifications touch constitutional-layer parameters.

**Constitutional parameters** (immutable):
- `AB_TEST_JUDGE_WEIGHTS`, `SYSTEM_PROMPT_CORE`, `EVOLUTION_RULE_MAX_COUNT`
- `KNOWLEDGE_MIN_ENTRIES`, `EVOLUTION_MIN_ACTIVE_RULES`, `CODE_SANDBOX_TIMEOUT`
- `PROTOCOL_HMAC_KEY`

**Evolvable parameters** (8 second-order parameters):
- `TASK_TYPE_IMPORTANCE`, `PROMOTION_IMPROVEMENT_MIN`, `DEPRECATION_RATE_MIN`
- `EVOLUTION_SANDBOX_MIN_SUCCESS_RATE`, `EVOLUTION_SANDBOX_MIN_TRIALS`
- `KNOWLEDGE_FORGET_MAX_UNUSED_DAYS`, `KNOWLEDGE_COHESION_THRESHOLD`
- `KNOWLEDGE_EXPLORATION_INTERVAL`

#### StrategyExplorer

Randomly perturbs second-order parameters for exploration. Perturbation magnitude 0.15, trigger conditions: enabled + min tasks(30) + interval(100) + concurrency limit(1).

#### MetaCommunicator

Shares parameter modification proposals across instances. Reception safety flow: trust check → source age check → constitutional validation → proposal count limit → accept.

#### EngineSelfOptimizer

Analyzes task statistics and automatically adjusts engine parameters. Three analysis strategies:
1. Success rate < 50% → relax promotion threshold
2. Deprecation rate > 30% → tighten deprecation rate floor
3. B win rate < 20% → lower sandbox pass threshold

Performance degradation detection: > 10% drop triggers rollback.

### 3.7 CodeSandbox + ABJudge + ToolGenerator

**Location**: `src/evolution/`

#### CodeSandbox

Isolated environment for safely testing code modifications.
- Static checks: size ≤ 100KB, syntax check, dangerous operation check (AST-level traversal)
- Forbidden calls: `eval`, `Function`, `child_process.exec`, etc.
- Isolated execution: subprocess + 30s timeout

#### ABJudge

Independent judge with fixed evaluation criteria (constitutional layer).

**Evaluation dimensions and weights**:
- `success_rate`: 0.40
- `execution_time`: 0.25
- `stability`: 0.20
- `code_complexity`: 0.15

**Judgment logic**: B wins if improvement rate ≥ 10% and cost increase ≤ 15%.

#### ToolGenerator

Automatic tool generator. Trigger conditions: enabled + min tasks(15) + interval(30) + below max tools(20).

---

## 4. Communication & Security

### 4.1 P2P Communication Layer

**Location**: `src/communication/`

**6 message types**: `knowledge_offer` / `rule_sync` / `challenge` / `meta_proposal` / `heartbeat` / `endorsement`

**P2P routes** (8):

| Method | Path | Function |
|--------|------|----------|
| POST | `/api/v1/peer/register` | Register peer node |
| POST | `/api/v1/peer/message` | Receive message |
| POST | `/api/v1/peer/sync-rules` | Sync evolution rules |
| POST | `/api/v1/peer/endorsement` | Receive consensus endorsement |
| POST | `/api/v1/peer/anomaly-report` | Receive anomaly report |
| GET | `/api/v1/peer/ping` | Heartbeat check |
| GET | `/api/v1/peer/info` | Get instance public info |
| GET | `/api/v1/peer/list` | Get known peer list |

### 4.2 Identity + Consensus

**Location**: `src/communication/identity.ts`, `src/communication/consensus.ts`

**Identity**: Uses Web Crypto API to generate Ed25519 key pairs. Fallback: HMAC-SHA256 when Ed25519 is unavailable.

**ConsensusEngine**: Web of Trust consensus mechanism.
- Endorsement record limit: 1000 entries
- Same instance can only endorse the same target once
- Trust score algorithm: `(positive - negative) / total × avg_confidence`

### 4.3 AnomalyDetector + Critic

**Location**: `src/communication/anomaly-detector.ts`, `src/communication/critic.ts`

**AnomalyDetector four detection dimensions**:

| Dimension | Detection Content | Threshold |
|-----------|-------------------|-----------|
| Frequency anomaly | Messages per hour | > 50 → high |
| Malicious patterns | 15 Chinese/English malicious patterns | Match → critical |
| Rejection rate anomaly | Rejection ratio | > 0.7 → high |
| Trust drop | Trust score change | Single drop > 0.2 → record |

**Critic processing result types**: `ACCEPT` / `ACCEPT_PARTIAL` / `REJECT` / `ARCHIVE_AS_FLAWED` / `CHALLENGE`

### 4.4 Anti-Pollution Mechanisms

**Four-layer security defense system**:

| Layer | Protection Target | Mechanism |
|-------|-------------------|-----------|
| Layer 1: Constitutional | Core code, communication protocols, security constraints | Physical isolation, no evolution can touch |
| Layer 2: Critical absorption | Externally received knowledge/rules | Sandbox testing + probation monitoring |
| Layer 3: Trust network | Credibility of communication partners | Trust scores + source verification + sliding window |
| Layer 4: Community consensus | Network-wide malicious behavior | Consensus signatures + anomaly detection + emergency rollback |

### 4.5 Marketplace + Community

**Location**: `src/communication/marketplace.ts`, `src/communication/community.ts`

**Marketplace**: Instance marketplace with publish/search/rate/subscribe. Popularity score = `avg_rating × log(downloads + 1) × time_decay`.

**Community**: Community consensus network. Reputation formula:
```
reputation = consensus_score × 0.4 + market_contribution × 0.3
           + activity_score × 0.2 + longevity_bonus
```

**Tier hierarchy**: newcomer(0) → member(20) → trusted(50) → elder(80), voting weight 1→2→3→5.

---

## 5. Infrastructure Layer

### 5.1 Persistence

**Location**: `src/persistence/`

| Component | Description |
|-----------|-------------|
| `atomic-write.ts` | Temp file + rename atomic write |
| `jsonl-store.ts` | JSONL format append-only storage |
| `snapshot.ts` | Snapshot management (max 10, 30-day auto-expiry) |

**Data directory mapping**:

| Data Type | Directory |
|-----------|-----------|
| Evolution rules | `data/evolution/rules.jsonl` |
| Knowledge memories | `data/knowledge/memories.jsonl` |

### 5.2 Provider Configuration

**Location**: `src/core/provider-config.ts`, `src/core/provider-bootstrap.ts`

**Unified priority chain**:
1. `runtime_override` — explicit API parameters
2. `persisted_config` — saved via HTTP API
3. `env_auto_detected` — auto-detected from environment variables

**Auto-detection mapping**:

| Environment Variable | Provider | Default Base URL |
|----------------------|----------|------------------|
| `OPENAI_API_KEY` | openai | `https://api.openai.com/v1` |
| `ANTHROPIC_API_KEY` | anthropic | `https://api.anthropic.com` |
| `OLLAMA_BASE_URL` | ollama | `http://localhost:11434` |
| `DEEPSEEK_API_KEY` | openai | `https://api.deepseek.com` |
| `KIMI_API_KEY` | openai | `https://api.moonshot.cn/v1` |
| `GLM_API_KEY` | openai | `https://open.bigmodel.cn/api/paas/v4` |

**Configuration snapshot** (`ProviderConfigSnapshot`):
- `provider`, `model`, `baseUrl`
- `isAutoDetected`, `source` (priority origin)
- `conflicts` (conflict records)

### 5.3 LLM Providers

**Location**: `src/llm/`

**LLMProvider interface**:
```typescript
interface LLMProvider {
  invoke(messages: Message[], options?: InvokeOptions): Promise<string>
  stream(messages: Message[], options?: StreamOptions): AsyncGenerator<string>
  countTokens(text: string): number
  healthCheck(): Promise<boolean>
}
```

**Four provider implementations**:

| Provider | Token Counting | Special Capabilities |
|----------|---------------|---------------------|
| `OpenAIProvider` | CJK-aware estimation | Compatible with all OpenAI API formats (DeepSeek/Qwen/Kimi/GLM) |
| `AnthropicProvider` | CJK-aware estimation | Supports thinking/reasoning |
| `OllamaProvider` | CJK-aware estimation | healthCheck queries model list |
| `MockProvider` | CJK-aware estimation | Pattern-matched responses for testing |

**LLMAdapter**: Unified adapter layer with error classification and fallback.

**Degradation strategies**:

| Component | Degradation Condition | Fallback |
|-----------|----------------------|----------|
| LLM analysis | fetch failure | Rule matching / simple analysis |
| Ed25519 signing | Web Crypto unavailable | HMAC-SHA256 |
| Task planning | LLM unavailable | Fixed 2-task template |
| Streaming output | stream failure | Fallback to synchronous invoke |

### 5.4 Tool System

**Location**: `src/tools/`

**Tool<I,O,P> generic interface**: Input/output/parameters all validated with Zod schemas.

**Built-in tools**:

| Tool | Location | Features |
|------|----------|----------|
| `bash` | `src/tools/bash/` | AST parsing, permission control, semantic checks, sed validation, environment sanitization |
| `file_read` | `src/tools/file/` | File reading |
| `file_write` | `src/tools/file/` | Atomic write |
| `file_edit` | `src/tools/file/` | Search and replace |
| `glob` | `src/tools/file/` | File pattern matching |

**Security tools** (`src/tools/security/`):
- `loop-detector.ts` — Repetitive tool-call pattern detection
- `regex-safety.ts` — Regex safety checks
- `secret-detector.ts` — Secret detection

**ToolRegistry + ToolExecutor + PermissionChain + RejectionCounter**

### 5.5 Security Layer

**Location**: `src/security/`

| Component | Description |
|-----------|-------------|
| `danger-flags.ts` | Danger flag detection |
| `external-content.ts` | External content safety handling |
| `hardwire.ts` | Hardwired security constraints |
| `llm-sanitize.ts` | LLM output sanitization |
| `redact.ts` | Data redaction |
| `secret-ref.ts` | Secret references (replacing plaintext storage) |
| `secret-store.ts` | Secure secret storage |
| `truncate.ts` | Two-tier truncation (per-item limit + total limit) |

### 5.6 Context Engine

**Location**: `src/context/`

| Component | Description |
|-----------|-------------|
| `engine.ts` | Context engine main entry |
| `compress.ts` | Context compression |
| `summarizer.ts` | Summary generation |
| `token-count.ts` | Token counting |
| `system-prompt.ts` | Three-layer System Prompt construction + caching |

### 5.7 Observability

**Location**: `src/observability/`

| Component | Description |
|-----------|-------------|
| `logger.ts` | Structured logging |
| `reservoir.ts` | Reservoir sampling (fixed-memory streaming statistics) |
| `cost-tracker.ts` | Cost tracking |
| `progress.ts` | Progress tracking |
| `pii-sanitize.ts` | PII sanitization |
| `chat-diagnostics.ts` | Chat diagnostics |

---

## 6. Interface Layer

### 6.1 HTTP Server

**Location**: `src/server/`

**10 route groups**:

| Route Group | Path Prefix | Description |
|-------------|-------------|-------------|
| Tasks | `/api/v1/task` | Submit tasks, query status |
| Evolution | `/api/v1/evolution` | Rule list, dashboard |
| Knowledge | `/api/v1/knowledge` | Knowledge queries, memory management |
| Config | `/api/v1/config` | Provider config read/write |
| Communication | `/api/v1/communication` | Communication history |
| P2P Network | `/api/v1/net` | Peers, sync, consensus |
| Marketplace | `/api/v1/market` | Publish/search/rate/subscribe |
| Community | `/api/v1/community` | Reputation, proposals, voting |
| Analytics | `/api/v1/analytics` | Trends, reports, snapshots |
| P2P Internal | `/api/v1/peer` | Register/message/heartbeat |

**Other**: Auth middleware, rate limiting, Web UI.

### 6.2 MCP Server

**Location**: `src/mcp/`

**Transport**: stdio / Streamable HTTP dual mode.

**10 MCP Tools**:

| Tool | Requires Provider | Function |
|------|-------------------|----------|
| `bash` | No | Execute shell commands |
| `file_read` | No | Read files |
| `file_write` | No | Write files |
| `file_edit` | No | Edit files |
| `glob` | No | File pattern matching |
| `chat` | Yes | Chat with LLM |
| `chat_complex` | Yes | Multi-agent orchestration |
| `evolution_status` | Yes | Evolution status |
| `observability_status` | Yes | Stats/cost/progress |
| `community_status` | Yes | Community governance/market |

**2 MCP Resources**: `config`, `status`.

---

## 7. Data Models

### 7.1 Enums

| Enum | Values |
|------|--------|
| `TaskStatus` | `PENDING` \| `RUNNING` \| `SUCCESS` \| `FAILED` \| `PARTIAL` |
| `AgentStatus` | `CREATED` \| `INITIALIZING` \| `RUNNING` \| `COMPLETED` \| `FAILED` \| `DESTROYED` |
| `RuleStatus` | `PENDING_APPROVAL` \| `SANDBOX` \| `ACTIVE` \| `PROBATION` \| `DEPRECATED` \| `ROLLED_BACK` |
| `ProcessingResult` | `ACCEPT` \| `ACCEPT_PARTIAL` \| `REJECT` \| `ARCHIVE_AS_FLAWED` \| `CHALLENGE` |

### 7.2 Zod Schemas

**Location**: `src/schemas/`

- `agent.ts` — Agent-related schemas
- `config.ts` — Configuration schemas
- `evolution.ts` — Evolution rule schemas
- `message.ts` — Message schemas
- `tool.ts` — Tool schemas

### 7.3 Branded Types

**Location**: `src/types/ids.ts`

Different semantic IDs use Branded Types to prevent misuse:
- `RuleId`, `TaskId`, `AgentId`, `MessageId`, `KnowledgeId`, etc.

---

## 8. Evolution Rule Lifecycle

### 8.1 State Machine

```
  Error occurs
     │
     ▼
  Analyze error ──→ Generate candidate rule
     │              │
     │         Conflict detection
     │              │
     │         ┌────┴────┐
     │         │ Conflict?│
     │         │ Yes→reject
     │         │ No→continue
     │         └────┬────┘
     │              │
     ▼              ▼
  ┌──────────────────────────────┐
  │     PENDING_APPROVAL         │  ← Awaiting approval (if enabled)
  └──────────────┬───────────────┘
                 │
                 ▼
  ┌──────────────────────────────┐
  │        SANDBOX               │  ← Sandbox trial (≥3 runs, ≥60% success rate)
  └──────────────┬───────────────┘
                 │ Pass
                 ▼
  ┌──────────────────────────────┐
  │        PROBATION             │  ← Probation period (≥10 task validations)
  │   Quantified promotion gate: │
  │   Improvement ≥ 15%          │
  │   Extra cost ≤ 10%           │
  └──────────────┬───────────────┘
                 │ Pass
                 ▼
  ┌──────────────────────────────┐
  │        ACTIVE                │  ← Active rule (injected into agents)
  │   Deprecation conditions:    │
  │   Success rate < 30% (≥5)    │
  │   EMA trend declining        │
  │   Variance too high          │
  └──────────────┬───────────────┘
                 │ Deprecate
                 ▼
  ┌──────────────────────────────┐
  │       DEPRECATED             │  ← Deprecated
  └──────────────────────────────┘
```

### 8.2 Key Thresholds

| Threshold | Default | Description |
|-----------|---------|-------------|
| Min sandbox trials | 3 | Minimum executions in sandbox phase |
| Min sandbox success rate | 0.6 | Sandbox pass threshold |
| Min probation tasks | 10 | Minimum validation tasks in probation |
| Promotion improvement | 0.15 | Minimum improvement for ACTIVE promotion |
| Promotion cost cap | 0.10 | Maximum extra cost allowed for promotion |
| Deprecation success rate | 0.3 | Below this triggers deprecation |
| Min deprecation activations | 5 | Minimum activations before deprecation |
| Max rule count | 50 | Constitutional layer limit |
| EMA alpha | 0.3 | Trend smoothing coefficient |
| Trigger budget ratio | 0.2 | Maximum trigger budget ratio |

---

## 9. P0-P4 Priority Improvement System

| Priority | Code Name | Core Focus | Key Mechanisms |
|----------|-----------|------------|----------------|
| **P0** | Safety baseline | Prevent evolution-induced degradation | Floor strategies, trigger budgets, approval gates, sandbox trials, snapshot rollbacks |
| **P1** | Efficiency | Reduce wasted evolution overhead | Segmented validation, tiered error handling, uncertainty signals, multi-layer prompts |
| **P2** | Evaluation accuracy | More accurate evolution effect assessment | Task type weights, E0 baseline, quantified promotion/deprecation thresholds, dynamic resource allocation |
| **P3** | Reproducibility | Ensure experiments are repeatable | Random seed control, token distribution logging, HMAC signing |
| **P4** | Advanced evolution | Code-level and strategy-level evolution | Knowledge exploration, active forgetting, code sandbox, automatic tool generation, A/B testing, strategy exploration, engine self-optimization |

---

## 10. Design Patterns Applied

| Pattern | Application Location |
|---------|---------------------|
| Interface + Registry | LLMProvider, Tool, Store, SandboxBackend, PluginEntry |
| Strategy pattern | LLMAdapter registry, Orchestrator AggregationStrategy |
| Atomic write | `atomic-write.ts` (tmp + rename) |
| Serialization for race elimination | `async-lock.ts`, `session-actor-queue.ts` |
| Reservoir sampling | `reservoir.ts` (fixed-memory streaming statistics) |
| Ring buffer dedup | LRU cache + dedup |
| Sliding window rate limiting | `rate-limiter.ts` |
| Observer + error isolation | Tool errors as data, loop not terminated |
| Two-tier truncation | `truncate.ts` (per-item limit + total limit) |
| Half-life decay | Marketplace popularity score (7-day half-life) |
| Generational counter | Async operation staleness detection |
| CoW | Snapshot deep copy, rollback on failure |

---

## 11. Module Integration Status

Based on the authoritative record in `src/module-ledger.ts`:

| Module | Status | Notes |
|--------|--------|-------|
| core/query | mainline_integrated | Agentic Loop main loop |
| core/agent | mainline_integrated | Orchestrator + SubAgent |
| evolution | mainline_integrated | Full rule lifecycle + meta-evolution |
| communication | mainline_integrated | P2P + consensus + reputation + marketplace |
| observability | mainline_integrated | Logging/stats/cost/progress/PII |
| mcp | mainline_integrated | stdio + HTTP dual transport |
| server | mainline_integrated | HTTP Server + Web UI + routes |
| llm | mainline_integrated | Four providers + fallback |
| tools | mainline_integrated | Bash/File/Security tools |
| security | mainline_integrated | Key detection/sanitization/truncation |
| persistence | mainline_integrated | Atomic write/JSONL/snapshots |
| knowledge | partially_integrated | Memory extractor wired; vector-store/dreaming/forgetting not wired |
| plugins | test_only | Plugin/Hook/Skill system tested but not assembled in main loop |
| sandbox | extension_only | SubprocessSandbox implemented but not used by tool execution |
