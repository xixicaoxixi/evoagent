/**
 * Critic — 批判性吸收分析器。
 *
 * 处理外部知识/规则，决定接受/拒绝/质疑。
 * 修复 C-01: 信任更新死代码。
 *
 * E.1 增强：
 * - LLM 深度分析模式（事实核查 → 上下文分析 → 来源评估 → 决策）
 * - 分析结果缓存（避免重复分析相同内容）
 * - 置信度过滤（EXTERNAL_KNOWLEDGE_MIN_CONFIDENCE）
 */

import { createHash } from "node:crypto";
import { filterArchitectureKeywords } from "../security/llm-sanitize";
import { extractJSONObject, safeJSONParse } from "../utils/llm-parse";
import { z } from "zod";

// ─── 处理结果枚举 ───

export type ProcessingResult =
  | "ACCEPT"
  | "ACCEPT_PARTIAL"
  | "REJECT"
  | "ARCHIVE_AS_FLAWED"
  | "CHALLENGE";

// ─── 外部知识 ───

export interface ExternalKnowledge {
  readonly id: string;
  readonly sourceAgent: string;
  readonly originalClaim: string;
  readonly processingResult: ProcessingResult;
  readonly analysis: Record<string, unknown>;
  readonly confidence: number;
  readonly validAspects: readonly string[];
  readonly flawedAspects: readonly string[];
  readonly correctedStatement: string;
  readonly timestamp: number;
}

// ─── 信任更新队列 ───

interface TrustUpdateEntry {
  readonly sourceAgent: string;
  readonly result: ProcessingResult;
  readonly confidence: number;
  readonly timestamp: number;
}

// ─── 常量 ───

const EXTERNAL_KNOWLEDGE_DROP_RATE = 0.1;
const EXTERNAL_KNOWLEDGE_MIN_CONFIDENCE = 0.15;
const TRUST_UPDATE_INTERVAL = 10;
const TRUST_SCORE_WINDOW = 20;
const HIGH_TRUST_THRESHOLD = 0.7;

// ─── E.1: LLM Provider 接口 ───

export interface LLMAnalysisResult {
  readonly result: ProcessingResult;
  readonly confidence: number;
  readonly validAspects: readonly string[];
  readonly flawedAspects: readonly string[];
  readonly correctedStatement: string;
  readonly reasoning: string;
  readonly isFallback: boolean;
}

export interface LLMProvider {
  readonly name: string;
  invoke(messages: ReadonlyArray<{ readonly role: string; readonly content: string }>): Promise<string>;
}

// ─── E.1: 分析缓存 ───

interface CacheEntry {
  readonly hash: string;
  readonly result: LLMAnalysisResult;
  readonly timestamp: number;
}

const CACHE_MAX_SIZE = 256;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

// ─── Critic 接口 ───

export interface Critic {
  analyzeMessage(
    sourceAgent: string,
    claim: string,
    currentTrustScore: number,
  ): Promise<ExternalKnowledge>;

  getTrustScore(sourceAgent: string): number;
  getKnowledge(sourceAgent: string): readonly ExternalKnowledge[];
  count(): number;
  clear(): void;
  /** E.1: 获取缓存统计 */
  getCacheStats(): { size: number; maxSize: number };
  /** E.1: 清空缓存 */
  clearCache(): void;
}

// ─── Critic 配置 ───

export interface CriticConfig {
  readonly llmProvider?: LLMProvider;
  readonly cacheEnabled?: boolean;
  readonly cacheMaxSize?: number;
  readonly cacheTtlMs?: number;
  readonly dropRate?: number;
}

// ─── 创建 Critic ───

export function createCritic(config?: CriticConfig): Critic {
  const knowledgeStore: ExternalKnowledge[] = [];
  const trustScores = new Map<string, number>();
  const trustUpdateQueue: TrustUpdateEntry[] = [];

  // E.1: 分析缓存
  const cacheMaxSize = config?.cacheMaxSize ?? CACHE_MAX_SIZE;
  const cacheTtlMs = config?.cacheTtlMs ?? CACHE_TTL_MS;
  const cacheEnabled = config?.cacheEnabled ?? true;
  const analysisCache: CacheEntry[] = [];
  const effectiveDropRate = config?.dropRate ?? EXTERNAL_KNOWLEDGE_DROP_RATE;

  /** E.1: 计算声明哈希（用于缓存键） */
  function hashClaim(claim: string): string {
    return createHash("sha256").update(claim).digest("hex").slice(0, 16);
  }

  /** E.1: 查找缓存 */
  function findCache(claim: string): CacheEntry | undefined {
    if (!cacheEnabled) return undefined;
    const hash = hashClaim(claim);
    const now = Date.now();
    return analysisCache.find(
      (e) => e.hash === hash && now - e.timestamp < cacheTtlMs,
    );
  }

  /** E.1: 写入缓存（FIFO 淘汰） */
  function writeCache(claim: string, result: LLMAnalysisResult): void {
    if (!cacheEnabled) return;
    const hash = hashClaim(claim);
    analysisCache.push({ hash, result, timestamp: Date.now() });
    while (analysisCache.length > cacheMaxSize) {
      analysisCache.shift();
    }
  }

  /** E.1: LLM 深度分析 */
  async function analyzeWithLLM(
    claim: string,
    trustScore: number,
  ): Promise<LLMAnalysisResult> {
    // 检查缓存
    const cached = findCache(claim);
    if (cached) {
      return cached.result;
    }

    const provider = config?.llmProvider;
    if (!provider) {
      // 无 LLM → 降级到简单分析
      const simpleResult = simpleAnalyze(claim, trustScore);
      const confidence = calculateConfidence(simpleResult, trustScore);
      const knowledge = createKnowledge("", claim, simpleResult, {}, confidence);
      const result: LLMAnalysisResult = {
        result: simpleResult,
        confidence,
        validAspects: knowledge.validAspects,
        flawedAspects: knowledge.flawedAspects,
        correctedStatement: knowledge.correctedStatement,
        reasoning: "simple_analysis_fallback",
        isFallback: true,
      };
      writeCache(claim, result);
      return result;
    }

    try {
      // 处理类别抽象：将内部类别名称映射为通用描述
      const CATEGORY_DESCRIPTIONS: Readonly<Record<ProcessingResult, string>> = {
        ACCEPT: "fully_accept",
        ACCEPT_PARTIAL: "partially_accept",
        REJECT: "reject",
        ARCHIVE_AS_FLAWED: "archive_as_flawed",
        CHALLENGE: "challenge_and_verify",
      };

      const categoryOptions = Object.values(CATEGORY_DESCRIPTIONS).join(" | ");

      const prompt = `You are a critical knowledge analyzer. Analyze the following claim and determine if it should be accepted, partially accepted, rejected, challenged, or archived as flawed.

Source trust score: ${trustScore.toFixed(2)}
Claim: ${filterArchitectureKeywords(claim)}

Respond in JSON format:
{
  "result": "<${categoryOptions}>",
  "confidence": <0.0-1.0>,
  "valid_aspects": ["<aspect1>", "<aspect2>"],
  "flawed_aspects": ["<flaw1>", "<flaw2>"],
  "corrected_statement": "<corrected version if needed>",
  "reasoning": "<brief explanation>"
}

Use English field names in JSON output. Output ONLY the JSON object, no additional text.`;

      const response = await provider.invoke([
        { role: "user", content: prompt },
      ]);

      const jsonStr = extractJSONObject(response);
      if (jsonStr === null) {
        throw new Error("LLM response did not contain valid JSON");
      }

      const rawParsed = safeJSONParse(jsonStr);

      const LLMCriticResultSchema = z.object({
        result: z.string(),
        confidence: z.number().min(0).max(1).optional(),
        valid_aspects: z.array(z.string()).optional(),
        flawed_aspects: z.array(z.string()).optional(),
        corrected_statement: z.string().optional(),
        reasoning: z.string().optional(),
      });

      const validated = LLMCriticResultSchema.safeParse(rawParsed);
      if (!validated.success) {
        throw new Error("LLM response JSON schema validation failed");
      }

      const parsed = validated.data;

      // 将通用描述映射回内部类别名称
      const DESCRIPTION_TO_RESULT: Readonly<Record<string, ProcessingResult>> = {
        fully_accept: "ACCEPT",
        partially_accept: "ACCEPT_PARTIAL",
        reject: "REJECT",
        archive_as_flawed: "ARCHIVE_AS_FLAWED",
        challenge_and_verify: "CHALLENGE",
      };

      const rawResult = parsed.result;
      const mappedResult = DESCRIPTION_TO_RESULT[rawResult];

      const validResults: ReadonlySet<string> = new Set([
        "ACCEPT", "ACCEPT_PARTIAL", "REJECT", "ARCHIVE_AS_FLAWED", "CHALLENGE",
      ]);
      const result = mappedResult ?? (validResults.has(rawResult)
        ? (rawResult as ProcessingResult)
        : "CHALLENGE");

      const confidence = parsed.confidence ?? 0.5;

      const llmResult: LLMAnalysisResult = {
        result,
        confidence,
        validAspects: parsed.valid_aspects ?? [],
        flawedAspects: parsed.flawed_aspects ?? [],
        correctedStatement: parsed.corrected_statement ?? claim,
        reasoning: parsed.reasoning ?? "LLM analysis",
        isFallback: false,
      };

      writeCache(claim, llmResult);
      return llmResult;
    } catch {
      // LLM 调用失败 → 降级到简单分析
      const simpleResult = simpleAnalyze(claim, trustScore);
      const confidence = calculateConfidence(simpleResult, trustScore);
      const knowledge = createKnowledge("", claim, simpleResult, {}, confidence);
      const fallbackResult: LLMAnalysisResult = {
        result: simpleResult,
        confidence,
        validAspects: knowledge.validAspects,
        flawedAspects: knowledge.flawedAspects,
        correctedStatement: knowledge.correctedStatement,
        reasoning: "llm_error_fallback",
        isFallback: true,
      };
      writeCache(claim, fallbackResult);
      return fallbackResult;
    }
  }

  /** P1-12: 批量信任更新（修复 C-01 死代码） */
  function processTrustUpdates(): void {
    if (trustUpdateQueue.length < TRUST_UPDATE_INTERVAL) return;

    // 取最近 TRUST_SCORE_WINDOW 条
    const recent = trustUpdateQueue.slice(-TRUST_SCORE_WINDOW);

    // 按来源分组
    const bySource = new Map<string, TrustUpdateEntry[]>();
    for (const entry of recent) {
      const list = bySource.get(entry.sourceAgent) ?? [];
      list.push(entry);
      bySource.set(entry.sourceAgent, list);
    }

    // 重算信任评分
    for (const [sourceAgent, entries] of bySource) {
      let positiveWeight = 0;
      let totalWeight = 0;

      for (const entry of entries) {
        const weight = entry.confidence;
        totalWeight += weight;

        switch (entry.result) {
          case "ACCEPT":
            positiveWeight += weight * 1.0;
            break;
          case "ACCEPT_PARTIAL":
            positiveWeight += weight * 0.5;
            break;
          case "REJECT":
            positiveWeight += weight * 0.0;
            break;
          case "ARCHIVE_AS_FLAWED":
            positiveWeight += weight * 0.2;
            break;
          case "CHALLENGE":
            positiveWeight += weight * 0.3;
            break;
        }
      }

      if (totalWeight > 0) {
        const newScore = positiveWeight / totalWeight;
        // 平滑更新（EMA）
        const oldScore = trustScores.get(sourceAgent) ?? 0.5;
        trustScores.set(sourceAgent, oldScore * 0.7 + newScore * 0.3);
      }
    }

    // 清空已处理的队列
    trustUpdateQueue.length = 0;
  }

  /** 入队信任更新 */
  function enqueueTrustUpdate(
    sourceAgent: string,
    result: ProcessingResult,
    confidence: number,
  ): void {
    trustUpdateQueue.push({
      sourceAgent,
      result,
      confidence,
      timestamp: Date.now(),
    });

    processTrustUpdates();
  }

  async function analyzeMessage(
    sourceAgent: string,
    claim: string,
    currentTrustScore: number,
  ): Promise<ExternalKnowledge> {
    // P1-13: 随机丢弃高信任来源的部分消息
    if (
      currentTrustScore > HIGH_TRUST_THRESHOLD &&
      Math.random() < effectiveDropRate
    ) {
      return createKnowledge(sourceAgent, claim, "REJECT", {
        reason: "randomly_dropped",
        dropRate: EXTERNAL_KNOWLEDGE_DROP_RATE,
      }, 0.1);
    }

    // B.1: 有 LLM Provider 时优先走 LLM 分析路径
    if (config?.llmProvider) {
      const llmResult = await analyzeWithLLM(claim, currentTrustScore);
      const method = llmResult.isFallback ? "simple" : "llm";

      // 置信度过滤
      if (llmResult.confidence < EXTERNAL_KNOWLEDGE_MIN_CONFIDENCE) {
        return createKnowledge(sourceAgent, claim, "REJECT", {
          reason: "below_min_confidence",
          confidence: llmResult.confidence,
          minConfidence: EXTERNAL_KNOWLEDGE_MIN_CONFIDENCE,
          method,
        }, llmResult.confidence);
      }

      const knowledge = createKnowledge(sourceAgent, claim, llmResult.result, {
        method,
        trustScore: currentTrustScore,
        reasoning: llmResult.reasoning,
      }, llmResult.confidence, llmResult.validAspects, llmResult.flawedAspects, llmResult.correctedStatement);

      if (llmResult.result !== "REJECT") {
        knowledgeStore.push(knowledge);
      }
      enqueueTrustUpdate(sourceAgent, llmResult.result, llmResult.confidence);
      return knowledge;
    }

    // 简单分析（无 LLM 的降级模式）
    const result = simpleAnalyze(claim, currentTrustScore);
    const confidence = calculateConfidence(result, currentTrustScore);

    // 置信度过滤：低于最低置信度的知识不存储
    if (confidence < EXTERNAL_KNOWLEDGE_MIN_CONFIDENCE) {
      return createKnowledge(sourceAgent, claim, "REJECT", {
        reason: "below_min_confidence",
        confidence,
        minConfidence: EXTERNAL_KNOWLEDGE_MIN_CONFIDENCE,
      }, confidence);
    }

    const knowledge = createKnowledge(sourceAgent, claim, result, {
      method: "simple",
      trustScore: currentTrustScore,
    }, confidence);

    // 存储非 REJECT 结果
    if (result !== "REJECT") {
      knowledgeStore.push(knowledge);
    }

    // 入队信任更新
    enqueueTrustUpdate(sourceAgent, result, confidence);

    return knowledge;
  }

  /** 简单分析（关键词匹配 + 信任评分） */
  function simpleAnalyze(
    claim: string,
    trustScore: number,
  ): ProcessingResult {
    // 高信任来源 → 倾向接受
    if (trustScore > 0.8) {
      return claim.length > 200 ? "ACCEPT_PARTIAL" : "ACCEPT";
    }

    // 低信任来源 → 倾向拒绝或质疑
    if (trustScore < 0.3) {
      return claim.includes("?") ? "CHALLENGE" : "REJECT";
    }

    // 中等信任 → 基于内容判断
    const hasCaveat =
      claim.includes("but") ||
      claim.includes("however") ||
      claim.includes("except") ||
      claim.includes("但是") ||
      claim.includes("然而");

    if (hasCaveat) {
      return "ACCEPT_PARTIAL";
    }

    return claim.length > 500 ? "CHALLENGE" : "ACCEPT";
  }

  /** 计算置信度 */
  function calculateConfidence(
    result: ProcessingResult,
    trustScore: number,
  ): number {
    const baseConfidence = trustScore * 0.6 + 0.2;

    switch (result) {
      case "ACCEPT":
        return Math.min(1, baseConfidence + 0.2);
      case "ACCEPT_PARTIAL":
        return Math.min(1, baseConfidence + 0.1);
      case "REJECT":
        return Math.max(0, baseConfidence - 0.1);
      case "ARCHIVE_AS_FLAWED":
        return Math.max(0, baseConfidence);
      case "CHALLENGE":
        return Math.max(0, baseConfidence - 0.05);
    }
  }

  /** 创建知识条目 */
  function createKnowledge(
    sourceAgent: string,
    claim: string,
    result: ProcessingResult,
    analysis: Record<string, unknown>,
    confidence: number,
    validAspects?: readonly string[],
    flawedAspects?: readonly string[],
    correctedStatement?: string,
  ): ExternalKnowledge {
    const valid: string[] = [...(validAspects ?? [])];
    const flawed: string[] = [...(flawedAspects ?? [])];
    let corrected = correctedStatement ?? "";

    if (valid.length === 0 && flawed.length === 0 && corrected === "") {
      switch (result) {
        case "ACCEPT":
          valid.push(claim);
          corrected = claim;
          break;
        case "ACCEPT_PARTIAL":
          valid.push("partial_content");
          flawed.push("incomplete_or_unverified");
          corrected = claim + " [partial]";
          break;
        case "ARCHIVE_AS_FLAWED":
          valid.push("some_valid_points");
          flawed.push("contains_flaws");
          corrected = claim + " [flawed]";
          break;
        default:
          break;
      }
    }

    return {
      id: `knowledge_${Date.now()}_${sourceAgent.slice(0, 8)}`,
      sourceAgent,
      originalClaim: claim,
      processingResult: result,
      analysis,
      confidence: Math.round(confidence * 1000) / 1000,
      validAspects: valid,
      flawedAspects: flawed,
      correctedStatement: corrected,
      timestamp: Date.now(),
    };
  }

  function getTrustScore(sourceAgent: string): number {
    return trustScores.get(sourceAgent) ?? 0.5;
  }

  function getKnowledge(
    sourceAgent: string,
  ): readonly ExternalKnowledge[] {
    return knowledgeStore.filter((k) => k.sourceAgent === sourceAgent);
  }

  function count(): number {
    return knowledgeStore.length;
  }

  function clear(): void {
    knowledgeStore.length = 0;
    trustScores.clear();
    trustUpdateQueue.length = 0;
  }

  function getCacheStats(): { size: number; maxSize: number } {
    return { size: analysisCache.length, maxSize: cacheMaxSize };
  }

  function clearCache(): void {
    analysisCache.length = 0;
  }

  return {
    analyzeMessage,
    getTrustScore,
    getKnowledge,
    count,
    clear,
    getCacheStats,
    clearCache,
  };
}
