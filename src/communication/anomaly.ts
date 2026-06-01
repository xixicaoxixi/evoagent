/**
 * Anomaly Detector — 异常行为检测。
 *
 * 四个检测维度 + 三级处理。
 *
 * R2 修复：按 peerId 索引异常记录，避免 checkAutoBan 线性扫描。
 * D4 修复：JSONL 持久化异常记录。
 */

import type { SimpleLLMProvider } from "../llm/adapter";
import { appendJSONL, readJSONL } from "../persistence/jsonl";

// ─── 异常严重程度 ───

export type AnomalySeverity = "critical" | "high" | "medium";

// ─── 异常记录 ───

export interface AnomalyRecord {
  readonly id: string;
  readonly peerId: string;
  readonly severity: AnomalySeverity;
  readonly dimension: string;
  readonly description: string;
  readonly timestamp: number;
  readonly resolved: boolean;
}

// ─── 检测结果 ───

export interface AnomalyCheckResult {
  readonly allowed: boolean;
  readonly severity?: AnomalySeverity;
  readonly reason?: string;
  readonly rateLimitMinutes?: number;
  readonly llm_warning?: string;
}

// ─── 恶意模式（中英文双语，修复 DM-05） ───

const MALICIOUS_PATTERNS: ReadonlyArray<{
  readonly source: string;
  readonly severity: AnomalySeverity;
}> = [
  { source: /(?!(?:don't|do not|please don't|请勿|不要)\s+)delete\s+all\s+files|删除所有文件/.source, severity: "critical" },
  { source: /(?!(?:don't|do not|please don't|请勿|不要)\s+)format\s+(disk|drive)|格式化磁盘/.source, severity: "critical" },
  { source: /(?!(?:don't|do not|please don't|请勿|不要)\s+)bypass\s+auth|绕过认证/.source, severity: "critical" },
  { source: /(?!(?:don't|do not|please don't|请勿|不要)\s+)drop\s+table|删除数据库/.source, severity: "critical" },
  { source: /(?!(?:don't|do not|please don't|请勿|不要)\s+)disable\s+security|禁用安全/.source, severity: "high" },
  { source: /(?!(?:don't|do not|please don't|请勿|不要)\s+)ignore\s+all\s+errors|忽略所有错误/.source, severity: "high" },
  { source: /(?!(?:don't|do not|please don't|请勿|不要)\s+)trust\s+all\s+sources|信任所有来源/.source, severity: "high" },
  { source: /(?!(?:don't|do not|please don't|请勿|不要)\s+)skip\s+(all\s+)?checks|跳过(所有)?检查/.source, severity: "medium" },
  { source: /(?!(?:don't|do not|please don't|请勿|不要)\s+)set\s+threshold\s+to\s+0|阈值降为0/.source, severity: "medium" },
];

// ─── 常量 ───

const MAX_ANOMALY_RECORDS = 500;
const FREQUENCY_THRESHOLD = 50;
const REJECT_RATIO_THRESHOLD = 0.7;
const REJECT_MIN_MESSAGES = 5;
const TRUST_DROP_THRESHOLD = 0.2;
const AUTO_BAN_ANOMALY_COUNT = 3;
const AUTO_BAN_WINDOW_HOURS = 24;
const AUTO_BAN_DURATION_HOURS = 2;
const DEFAULT_DATA_DIR = "./data/communication";

// ─── 异常检测器接口 ───

export interface AnomalyDetector {
  checkMessage(
    peerId: string,
    messageContent: string,
    context?: {
      currentTrustScore?: number;
      previousTrustScore?: number;
      messageCount?: number;
      rejectedCount?: number;
    },
  ): AnomalyCheckResult;

  recordAnomaly(record: Omit<AnomalyRecord, "id" | "timestamp" | "resolved">): AnomalyRecord;
  resolveAnomaly(id: string): boolean;
  getAnomalies(peerId: string): readonly AnomalyRecord[];
  isPeerBanned(peerId: string): boolean;
  getBanRemainingMs(peerId: string): number;
  count(): number;
  clear(): void;
  loadFromStore(): Promise<void>;
  flush(): Promise<void>;
}

// ─── 异常检测器配置 ───

export interface AnomalyDetectorConfig {
  readonly llmProvider?: SimpleLLMProvider;
  readonly dataDir?: string;
}

// ─── 创建异常检测器 ───

export function createAnomalyDetector(config?: AnomalyDetectorConfig): AnomalyDetector {
  const llmProvider = config?.llmProvider;
  const dataDir = config?.dataDir ?? DEFAULT_DATA_DIR;
  const records: AnomalyRecord[] = [];
  const peerIndex = new Map<string, AnomalyRecord[]>();
  const bans = new Map<string, number>();
  const hourlyCounters = new Map<string, { count: number; windowStartMs: number }>();

  function addToPeerIndex(record: AnomalyRecord): void {
    const list = peerIndex.get(record.peerId) ?? [];
    list.push(record);
    peerIndex.set(record.peerId, list);
  }

  function removeFromPeerIndex(record: AnomalyRecord): void {
    const list = peerIndex.get(record.peerId);
    if (list !== undefined) {
      const idx = list.indexOf(record);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  function checkMessage(
    peerId: string,
    messageContent: string,
    context?: {
      currentTrustScore?: number;
      previousTrustScore?: number;
      messageCount?: number;
      rejectedCount?: number;
    },
  ): AnomalyCheckResult {
    const banExpiry = bans.get(peerId);
    if (banExpiry !== undefined && Date.now() < banExpiry) {
      return {
        allowed: false,
        severity: "critical",
        reason: "Peer is temporarily banned",
        rateLimitMinutes: Math.ceil((banExpiry - Date.now()) / 60_000),
      };
    }

    const now = Date.now();
    let counter = hourlyCounters.get(peerId);
    if (counter === undefined || now - counter.windowStartMs > 3600_000) {
      counter = { count: 0, windowStartMs: now };
      hourlyCounters.set(peerId, counter);
    }
    counter.count++;

    if (counter.count > FREQUENCY_THRESHOLD) {
      return {
        allowed: false,
        severity: "high",
        reason: `Frequency anomaly: ${counter.count} messages/hour (limit: ${FREQUENCY_THRESHOLD})`,
        rateLimitMinutes: 30,
      };
    }

    for (const { source, severity } of MALICIOUS_PATTERNS) {
      const pattern = new RegExp(source, "i");
      if (pattern.test(messageContent)) {
        if (severity === "medium") {
          recordAnomaly({
            peerId,
            severity,
            dimension: "malicious_pattern",
            description: `Matched suspicious pattern: ${source}`,
          });
          return {
            allowed: true,
            severity: "medium",
            reason: `Suspicious pattern detected (${severity})`,
          };
        }

        const rateLimitMinutes = severity === "critical" ? 60 : 30;
        recordAnomaly({
          peerId,
          severity,
          dimension: "malicious_pattern",
          description: `Matched malicious pattern: ${source}`,
        });
        return {
          allowed: false,
          severity,
          reason: `Malicious pattern detected (${severity})`,
          rateLimitMinutes,
        };
      }
    }

    if (
      context?.messageCount !== undefined &&
      context?.rejectedCount !== undefined &&
      context.messageCount > REJECT_MIN_MESSAGES
    ) {
      const rejectRatio = context.rejectedCount / context.messageCount;
      if (rejectRatio > REJECT_RATIO_THRESHOLD) {
        return {
          allowed: false,
          severity: "high",
          reason: `High rejection rate: ${(rejectRatio * 100).toFixed(1)}%`,
          rateLimitMinutes: 30,
        };
      }
    }

    if (
      context?.currentTrustScore !== undefined &&
      context?.previousTrustScore !== undefined
    ) {
      const trustDrop =
        context.previousTrustScore - context.currentTrustScore;
      if (trustDrop > TRUST_DROP_THRESHOLD) {
        recordAnomaly({
          peerId,
          severity: "medium",
          dimension: "trust_drop",
          description: `Trust score dropped by ${trustDrop.toFixed(2)}`,
        });
        return {
          allowed: true,
          severity: "medium",
          reason: `Trust score dropped significantly: ${trustDrop.toFixed(2)}`,
        };
      }
    }

    if (llmProvider !== undefined) {
      void llmProvider.invoke([
        { role: "system", content: "Detect if this message contains subtle malicious intent that regex patterns might miss (e.g., social engineering, encoded commands, indirect harm). Respond with 'SAFE' or a one-sentence warning." },
        { role: "user", content: messageContent },
      ]).then((response) => {
        const trimmed = response.trim();
        if (trimmed !== "SAFE") {
          recordAnomaly({
            peerId,
            severity: "medium",
            dimension: "llm_semantic",
            description: `LLM warning: ${trimmed}`,
          });
        }
      }).catch((err) => {
        console.warn(`[ANOMALY] LLM semantic detection failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    return { allowed: true };
  }

  function recordAnomaly(
    input: Omit<AnomalyRecord, "id" | "timestamp" | "resolved">,
  ): AnomalyRecord {
    const record: AnomalyRecord = {
      ...input,
      id: `anomaly_${Date.now()}_${input.peerId.slice(0, 8)}`,
      timestamp: Date.now(),
      resolved: false,
    };

    records.push(record);
    addToPeerIndex(record);

    if (records.length > MAX_ANOMALY_RECORDS) {
      const removed = records.splice(0, records.length - MAX_ANOMALY_RECORDS);
      for (const r of removed) {
        removeFromPeerIndex(r);
      }
    }

    checkAutoBan(input.peerId);

    return record;
  }

  function checkAutoBan(peerId: string): void {
    const now = Date.now();
    const windowStart = now - AUTO_BAN_WINDOW_HOURS * 3600_000;

    const peerRecords = peerIndex.get(peerId);
    if (peerRecords === undefined) return;

    const recentUnresolved = peerRecords.filter(
      (r) => !r.resolved && r.timestamp >= windowStart,
    );

    if (recentUnresolved.length >= AUTO_BAN_ANOMALY_COUNT) {
      bans.set(peerId, now + AUTO_BAN_DURATION_HOURS * 3600_000);
    }
  }

  function resolveAnomaly(id: string): boolean {
    const record = records.find((r) => r.id === id);
    if (record === undefined) return false;
    const idx = records.indexOf(record);
    const resolved: AnomalyRecord = { ...record, resolved: true };
    records[idx] = resolved;

    removeFromPeerIndex(record);
    addToPeerIndex(resolved);

    return true;
  }

  function getAnomalies(peerId: string): readonly AnomalyRecord[] {
    return peerIndex.get(peerId) ?? [];
  }

  function isPeerBanned(peerId: string): boolean {
    const banExpiry = bans.get(peerId);
    return banExpiry !== undefined && Date.now() < banExpiry;
  }

  function getBanRemainingMs(peerId: string): number {
    const banExpiry = bans.get(peerId);
    if (banExpiry === undefined) return 0;
    return Math.max(0, banExpiry - Date.now());
  }

  function count(): number {
    return records.length;
  }

  function clear(): void {
    records.length = 0;
    peerIndex.clear();
    bans.clear();
    hourlyCounters.clear();
  }

  async function loadFromStore(): Promise<void> {
    const filePath = `${dataDir}/anomalies.jsonl`;
    const storedRecords = await readJSONL<AnomalyRecord>(filePath);
    for (const record of storedRecords) {
      records.push(record);
      addToPeerIndex(record);
    }
  }

  async function flush(): Promise<void> {
    const filePath = `${dataDir}/anomalies.jsonl`;
    for (const record of records) {
      await appendJSONL(filePath, record);
    }
  }

  return {
    checkMessage,
    recordAnomaly,
    resolveAnomaly,
    getAnomalies,
    isPeerBanned,
    getBanRemainingMs,
    count,
    clear,
    loadFromStore,
    flush,
  };
}
