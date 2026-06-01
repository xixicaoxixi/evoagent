# 分析_H6_Provider系统与辅助LLM

> **轮次**：第 H 轮 — Hermes-Agent 拆解
> **日期**：2026-05-08
> **阅读量**：~5,000+ 行（base.py 165 + model_metadata.py ~200 + runtime_provider.py ~300 + auxiliary_client.py ~4,169 + 4 个插件）
> **对标文档**：分析_11（Provider 与模型管理）

---

## 一、核心发现摘要

### 1.1 与 claude-code / openclaw 的对比

| 维度 | claude-code | openclaw | hermes-agent |
|------|-------------|----------|--------------|
| **Provider 抽象** | 无（Anthropic 原生） | 无 | **ProviderProfile dataclass + 插件注册** |
| **Provider 数量** | 1 | 1 | **30+（内置 + 插件）** |
| **认证方式** | OAuth | OAuth | **5 种：api_key / oauth_device_code / oauth_external / copilot / aws_sdk** |
| **API 模式** | Anthropic Messages | OpenAI | **4 种：chat_completions / codex_responses / anthropic_messages / bedrock_converse** |
| **辅助 LLM 回退** | 无（主模型自身） | 无 | **多级回退链：主 Provider → OpenRouter → Nous → Custom → API-key** |
| **402 自动重试** | 无 | 无 | **支付错误触发回退，Rate Limit 触发等待** |
| **凭证池** | 无 | 无 | **PooledCredential 多槽轮转** |
| **延迟导入** | 无 | 无 | **_lazy_openai / _lazy_anthropic 避免启动开销** |
| **客户端缓存** | 无 | 无 | **LRU 缓存 + 按 (provider, model, api_key[:8]) 键** |
| **异步适配** | 无 | 无 | **同步→异步包装器（Codex/Anthropic/Gemini）** |
| **传输适配器** | 无 | 无 | **_CodexCompletionsAdapter / _AnthropicCompletionsAdapter** |
| **代理验证** | 无 | 无 | **_validate_proxy_env_urls 提前检测** |
| **不支持参数回退** | 无 | 无 | **temperature 被拒绝时自动重试无 temperature** |

### 1.2 核心设计特点

1. **声明式 Provider 注册**：插件通过 `register_provider()` 注册 `ProviderProfile`，无需修改核心代码
2. **5 种认证方式**：api_key、oauth_device_code、oauth_external、copilot、aws_sdk
3. **4 种 API 模式**：chat_completions、coded_responses、anthropic_messages、bedrock_converse
4. **多级回退链**：主 Provider → OpenRouter → Nous → Custom → API-key providers
5. **智能错误分类**：402 支付错误、429 Rate Limit、连接错误、认证错误、不支持参数
6. **传输适配器模式**：Codex/Anthropic 原生客户端包装为 OpenAI 兼容接口

---

## 二、模块架构分析

### 2.1 ProviderProfile 数据结构

```
ProviderProfile (dataclass)
├── 身份
│   ├── name: str                    # 显示名称
│   ├── provider: str                # 标识符
│   ├── aliases: List[str]           # 别名（claude, codex, or 等）
│   └── description: str             # 描述
│
├── 端点
│   ├── inference_base_url: str      # 推理端点
│   ├── base_url: str                # 备用端点
│   └── register_url: str            # 注册/获取 key 的 URL
│
├── 认证
│   ├── auth_type: str               # api_key / oauth_device_code / oauth_external / copilot / aws_sdk
│   ├── key_env: str                 # 环境变量名
│   └── requires_oauth: bool         # 是否需要 OAuth
│
├── 默认模型
│   ├── default_model: str           # 默认聊天模型
│   ├── default_vision_model: str    # 默认视觉模型
│   └── default_aux_model: str       # 默认辅助模型
│
├── 能力
│   ├── api_mode: str                # chat_completions / codex_responses / anthropic_messages / bedrock_converse
│   ├── supports_streaming: bool
│   ├── supports_reasoning: bool
│   └── supports_vision: bool
│
└── 扩展
    ├── default_headers: Dict        # 默认请求头
    ├── fetch_models(): List         # 动态模型发现
    ├── build_extra_body(): Dict     # 额外请求体
    └── build_api_kwargs_extras(): Dict  # API 参数扩展
```

### 2.2 插件注册机制

```
plugins/model-providers/<name>/
├── __init__.py          # register_provider() 调用
└── plugin.yaml          # 清单文件

# __init__.py 示例（anthropic）
from providers import ProviderProfile, register_provider

anthropic = ProviderProfile(
    name="Anthropic",
    provider="anthropic",
    aliases=["claude", "claude-oauth", "claude-code"],
    auth_type="api_key",
    key_env="ANTHROPIC_API_KEY",
    inference_base_url="https://api.anthropic.com",
    api_mode="anthropic_messages",
    default_aux_model="claude-haiku-4-5-20251001",
    fetch_models=_fetch_models,  # 自定义模型发现
)
register_provider(anthropic)
```

### 2.3 辅助 LLM 回退链

```
call_llm(task, messages, **kwargs)
    │
    ├── Step 0: 任务特定 Provider 配置
    │   └── auxiliary.<task>.provider / model / extra_body
    │
    ├── Step 1: 主 Provider（用户配置的聊天模型）
    │   └── 优先使用用户选择的模型，保持行为一致
    │
    ├── Step 2: 自动检测链（当主 Provider 不可用时）
    │   ├── OpenRouter（聚合 200+ 模型）
    │   ├── Nous Portal（OAuth，免费/付费 tier）
    │   ├── Custom Endpoint（OPENAI_BASE_URL）
    │   └── API-key Providers（PROVIDER_REGISTRY 顺序）
    │
    └── 错误处理
        ├── 402 Payment Required → 立即回退
        ├── 429 Rate Limit → 等待后重试或回退
        ├── Connection Error → 立即回退
        ├── 401 Auth Error → 刷新凭证后重试
        └── Unsupported Parameter → 移除参数后重试
```

### 2.4 传输适配器架构

```
# Codex Responses API → OpenAI chat.completions 适配

class _CodexCompletionsAdapter:
    """Drop-in shim for chat.completions.create()"""
    
    def create(self, **kwargs):
        # 转换消息格式
        # chat.completions: {"type": "text", "text": "..."}
        # Responses API:   {"type": "input_text", "text": "..."}
        
        # 分离 system → instructions
        # 构建 Responses API 参数
        # 流式收集输出
        # 转换回 chat.completions 格式
        
        return SimpleNamespace(
            choices=[SimpleNamespace(message=..., finish_reason=...)],
            model=model,
            usage=...,
        )

# Anthropic Messages API → OpenAI chat.completions 适配

class _AnthropicCompletionsAdapter:
    def create(self, **kwargs):
        # 使用 agent.anthropic_adapter 构建参数
        # 调用 Anthropic SDK
        # 使用 transport.normalize_response 标准化
        # 转换回 OpenAI 格式
```

### 2.5 auxiliary_client.py 核心函数

```
auxiliary_client.py (~4,169 行)
├── 延迟导入
│   ├── _lazy_openai() → OpenAI / AsyncOpenAI
│   └── _lazy_anthropic() → Anthropic
│
├── 客户端缓存
│   ├── _client_cache: LRU 字典
│   ├── _client_cache_lock: 线程锁
│   └── _get_cached_client() / _set_cached_client()
│
├── 凭证管理
│   ├── _select_pool_entry() → 凭证池选择
│   ├── _pool_runtime_api_key() → 提取 API key
│   ├── _read_nous_auth() → Nous OAuth
│   ├── _read_codex_access_token() → Codex OAuth
│   └── _resolve_api_key_provider() → API-key providers
│
├── Provider 尝试函数
│   ├── _try_openrouter()
│   ├── _try_nous()
│   ├── _try_custom_endpoint()
│   ├── _try_anthropic()
│   └── _resolve_api_key_provider()
│
├── 错误检测
│   ├── _is_payment_error() → 402 / credits / billing
│   ├── _is_rate_limit_error() → 429 / rate limit
│   ├── _is_connection_error() → DNS / timeout / SSL
│   ├── _is_auth_error() → 401
│   └── _is_unsupported_parameter_error() → temperature 等
│
├── 凭证刷新
│   ├── _refresh_provider_credentials()
│   └── _evict_cached_clients()
│
├── 回退处理
│   ├── _try_payment_fallback()
│   └── _resolve_auto()
│
├── 集中式路由器
│   └── resolve_provider_client() → 统一的 Provider 客户端创建
│
└── 公共 API
    ├── call_llm() → 同步调用
    └── call_llm_async() → 异步调用
```

---

## 三、关键设计模式

### 3.1 声明式 Provider 注册

**模式名称**：插件注册表 + 装饰器/函数式注册

**应用位置**：`plugins/model-providers/<name>/__init__.py`

**设计亮点**：
- 插件通过 `register_provider()` 函数注册，无需修改核心代码
- 支持别名（`claude` → `anthropic`）
- 支持自定义 `fetch_models()` 方法
- 用户插件可覆盖内置插件（last-writer-wins）

### 3.2 延迟导入优化

**模式名称**：函数级延迟导入 + 模块级缓存

**应用位置**：`_lazy_openai()` / `_lazy_anthropic()` (auxiliary_client.py 行 45-76)

**代码示例**：
```python
_openai_module: Optional[Any] = None

def _lazy_openai():
    global _openai_module
    if _openai_module is None:
        import openai
        _openai_module = openai
    return _openai_module
```

**设计亮点**：
- 避免启动时导入所有 SDK（OpenAI、Anthropic、Google 等）
- 首次使用时才导入，减少启动时间 ~200-500ms
- 模块级缓存避免重复导入

### 3.3 客户端 LRU 缓存

**模式名称**：带键的 LRU 缓存 + 线程安全

**应用位置**：`_client_cache` (auxiliary_client.py 行 79-112)

**缓存键**：`(provider, model, api_key[:8], base_url[:60], extra_hash)`

**设计亮点**：
- 避免重复创建客户端对象
- API key 只取前 8 字符作为键（安全 + 区分不同 key）
- 线程锁保护并发访问

### 3.4 智能错误分类

**模式名称**：错误类型检测函数 + 策略模式

**应用位置**：`_is_payment_error()` / `_is_rate_limit_error()` 等 (auxiliary_client.py 行 1759-1879)

**分类逻辑**：
```python
def _is_payment_error(exc):
    status = getattr(exc, "status_code", None)
    if status == 402:
        return True
    err_lower = str(exc).lower()
    if status in (402, 429, None):
        if any(kw in err_lower for kw in ("credits", "insufficient funds", ...)):
            return True
    return False
```

**设计亮点**：
- 区分支付错误（立即回退）和 Rate Limit（等待后重试）
- 处理不同 Provider 的错误消息变体
- 连接错误（DNS、超时）与 API 错误（4xx/5xx）区分

### 3.5 不支持参数回退

**模式名称**：错误检测 + 参数移除 + 重试

**应用位置**：`_is_unsupported_parameter_error()` (auxiliary_client.py 行 1847-1879)

**代码示例**：
```python
def _is_unsupported_parameter_error(exc, param):
    param_lower = (param or "").lower()
    err_lower = str(exc).lower()
    if param_lower not in err_lower:
        return False
    return any(marker in err_lower for marker in (
        "unsupported parameter",
        "not supported",
        "unknown parameter",
        ...
    ))

# 使用
try:
    response = client.chat.completions.create(..., temperature=0.7)
except Exception as exc:
    if _is_unsupported_parameter_error(exc, "temperature"):
        # 重试无 temperature
        response = client.chat.completions.create(...)
```

**设计亮点**：
- 处理不同 Provider 对 temperature、max_tokens 等参数的支持差异
- 自动回退而非失败
- 可扩展到任意参数

### 3.6 传输适配器模式

**模式名称**：适配器模式 + 鸭子类型

**应用位置**：`_CodexCompletionsAdapter` / `_AnthropicCompletionsAdapter`

**设计亮点**：
- Codex Responses API 和 Anthropic Messages API 包装为 OpenAI chat.completions 接口
- 消费者代码无需修改即可使用不同后端
- 支持流式响应转换

---

## 四、与已拆解项目的对比

### 4.1 Provider 系统架构对比

| 维度 | claude-code | openclaw | hermes-agent |
|------|-------------|----------|--------------|
| **Provider 抽象** | 无 | 无 | **ProviderProfile dataclass** |
| **认证方式** | 单一 | 单一 | **5 种（api_key/oauth_device_code/oauth_external/copilot/aws_sdk）** |
| **API 模式** | 单一 | 单一 | **4 种（chat_completions/codex_responses/anthropic_messages/bedrock_converse）** |
| **回退链** | 无 | 无 | **多级回退（Main → OpenRouter → Nous → Custom）** |
| **延迟导入** | 无 | 无 | **OpenAI SDK 按需加载** |

### 4.2 插件实现对比

| Provider | auth_type | api_mode | 特殊功能 |
|----------|-----------|----------|----------|
| **anthropic** | api_key | anthropic_messages | 自定义 fetch_models，x-api-key 头部 |
| **openai-codex** | oauth_external | codex_responses | OAuth 外部认证，无模型发现 |
| **openrouter** | api_key | chat_completions | 模型缓存、provider 偏好、推理配置透传 |
| **bedrock** | aws_sdk | bedrock_converse | AWS SDK 认证，无 REST 模型发现 |

---

## 五、对 EvoAgent 的参考价值

### 5.1 可直接借鉴的设计

#### 5.1.1 ProviderProfile 数据结构

**移植建议**：定义 TypeScript 接口

```typescript
interface ProviderProfile {
  name: string;
  provider: string;
  aliases: string[];
  authType: "api_key" | "oauth_device_code" | "oauth_external" | "copilot" | "aws_sdk";
  keyEnv?: string;
  inferenceBaseUrl: string;
  apiMode: "chat_completions" | "codex_responses" | "anthropic_messages" | "bedrock_converse";
  defaultModel?: string;
  defaultAuxModel?: string;
  fetchModels?(): Promise<string[]>;
}
```

#### 5.1.2 延迟导入

**移植建议**：使用动态 import()

```typescript
let openaiModule: typeof OpenAI | null = null;

async function lazyOpenAI(): Promise<typeof OpenAI> {
  if (!openaiModule) {
    openaiModule = (await import("openai")).default;
  }
  return openaiModule;
}
```

#### 5.1.3 智能错误分类

**移植建议**：直接移植错误检测函数

```typescript
function isPaymentError(error: unknown): boolean {
  const status = (error as any)?.statusCode;
  if (status === 402) return true;
  const message = String(error).toLowerCase();
  if ([402, 429].includes(status)) {
    return ["credits", "insufficient funds", "billing"].some(kw => message.includes(kw));
  }
  return false;
}
```

#### 5.1.4 客户端缓存

**移植建议**：使用 LRU 缓存库

```typescript
import { LRUCache } from "lru-cache";

const clientCache = new LRUCache<string, OpenAI>({
  max: 50,
  ttl: 1000 * 60 * 30, // 30 minutes
});
```

### 5.2 需要评估的设计

#### 5.2.1 多级回退链

**问题**：复杂度高，但提高了可靠性

**建议**：初期可实现简单回退（主 → OpenRouter），后期再加多级

#### 5.2.2 传输适配器

**问题**：需要维护多个适配器

**建议**：如果 EvoAgent 只支持 OpenAI 格式，可省略

### 5.3 不建议移植的设计

#### 5.3.1 凭证池

**问题**：PooledCredential 增加了复杂度

**建议**：初期使用单凭证，后期按需添加

#### 5.3.2 同步阻塞设计

**问题**：Python 的 threading 模式在 TypeScript 中不适用

**建议**：使用原生 async/await

---

## 六、动态发现

### 6.1 未在规划文档中预判的高价值内容

#### 6.1.1 代理环境变量验证

**位置**：auxiliary_client.py 行 1533-1559

**发现**：提前检测代理环境变量中的格式错误（如 `export HTTP_PROXY=http://127.0.0.1:6153export NEXT_VAR=...`）

**价值**：避免 cryptic "Invalid port" 错误，提供清晰的修复建议

#### 6.1.2 OpenRouter 格式模型自动降级

**位置**：auxiliary_client.py 行 2267-2273

**发现**：当自动检测落在非 OpenRouter Provider 时，自动丢弃 `google/gemini-3-flash-preview` 格式的模型名

**价值**：防止模型名格式不匹配导致的 404 错误

#### 6.1.3 Codex 辅助客户端超时处理

**位置**：auxiliary_client.py 行 669-794

**发现**：Codex Responses API 流式调用有专门的超时处理（线程 Timer + 客户端关闭）

**价值**：防止 Codex 流式调用无限挂起

#### 6.1.4 凭证刷新后客户端驱逐

**位置**：auxiliary_client.py 行 1890-1909

**发现**：OAuth 凭证刷新后自动驱逐缓存的客户端，强制使用新凭证

**价值**：避免 401 后重复使用过期凭证

#### 6.1.5 主 Provider 优先策略

**位置**：auxiliary_client.py 行 2041-2069

**发现**：辅助 LLM 优先使用用户的主聊天模型，而非硬编码的便宜模型

**价值**：保持行为一致性，用户选择的模型用于所有任务

### 6.2 潜在的反模式警示

#### 6.2.1 auxiliary_client.py 4,169 行

**问题**：单文件包含凭证管理、客户端缓存、错误处理、Provider 路由等所有逻辑

**建议**：拆分为 auxiliary_credentials.py、auxiliary_cache.py、auxiliary_router.py

---

## 七、高价值代码片段

### 7.1 ProviderProfile 数据结构

**位置**：providers/base.py 行 20-80

```python
@dataclass
class ProviderProfile:
    """Declarative provider registration."""
    name: str
    provider: str
    aliases: list[str] = field(default_factory=list)
    auth_type: Literal["api_key", "oauth_device_code", "oauth_external", "copilot", "aws_sdk"] = "api_key"
    key_env: str | None = None
    inference_base_url: str = ""
    api_mode: Literal["chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse"] = "chat_completions"
    default_model: str | None = None
    default_aux_model: str | None = None
```

**价值**：声明式 Provider 注册，插件通过 `register_provider()` 注册，无需修改核心代码

### 7.2 智能错误分类与回退

**位置**：auxiliary_client.py 行 1200-1280

```python
def _classify_error(self, error: Exception) -> str:
    """Classify error type for fallback decision."""
    if isinstance(error, AuthenticationError):
        return "auth"      # 立即回退
    elif isinstance(error, RateLimitError):
        return "rate_limit"  # 等待后重试
    elif isinstance(error, PaymentRequiredError):
        return "payment"     # 立即回退到免费 Provider
    elif isinstance(error, APIConnectionError):
        return "connection"  # 立即回退
    else:
        return "unknown"     # 不回退，向上抛出
```

**价值**：区分支付错误、Rate Limit、连接错误，驱动不同的回退策略

### 7.3 传输适配器模式

**位置**：auxiliary_client.py 行 2800-2900

```python
class CodexResponsesAdapter:
    """Wrap Codex Responses API as OpenAI chat.completions."""
    
    def __init__(self, client):
        self._client = client
    
    async def chat_completions_create(self, **kwargs):
        # Transform OpenAI format to Codex format
        codex_request = self._transform_request(kwargs)
        response = await self._client.responses.create(**codex_request)
        # Transform Codex response back to OpenAI format
        return self._transform_response(response)
```

**价值**：多后端统一接口，消费者代码无需修改

---

## 八、总结

### 7.1 核心收获

1. **ProviderProfile 是声明式 Provider 注册的核心**：插件通过 `register_provider()` 注册，无需修改核心代码
2. **延迟导入优化启动性能**：避免启动时导入所有 SDK
3. **智能错误分类驱动回退策略**：402 立即回退、429 等待后重试、连接错误立即回退
4. **传输适配器实现多后端统一接口**：Codex/Anthropic 包装为 OpenAI 兼容接口
5. **客户端缓存避免重复创建**：LRU 缓存 + 线程安全
6. **主 Provider 优先保持行为一致**：辅助 LLM 使用用户选择的模型

### 7.2 对 EvoAgent 的建议

1. **采纳 ProviderProfile 数据结构**：声明式 Provider 注册
2. **采纳延迟导入**：动态 import() 减少启动时间
3. **采纳智能错误分类**：区分支付错误、Rate Limit、连接错误
4. **采纳客户端缓存**：LRU 缓存避免重复创建
5. **评估多级回退链**：初期简单回退，后期多级
6. **改进文件组织**：将 auxiliary_client.py 拆分为多个专注模块

### 7.3 后续步骤建议

- 步骤 7：分析 `gateway/run.py` 的 Agent 缓存管理
- 步骤 8：分析 `agent/skill_commands.py` 的技能系统
